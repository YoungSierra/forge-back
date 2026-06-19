// Mapeo format de output → tipo para comparar con input.accepts[]
const FORMAT_TO_TYPE = {
  markdown:        'text',
  markdown_table:  'text',
  single_sentence: 'text',
  structured:      'text',
  json:            'text',
  docx:            'document',
  pptx:            'document',
  document:        'document',
  png:             'image',
  jpg:             'image',
  jpeg:            'image',
  image:           'image',
  audio:           'audio',
  model_3d:        'model_3d',
  artifact_bundle: 'artifact_bundle',
}

/**
 * Corre auto-wiring para todos los forge_nodes activos del proyecto.
 * Solo crea edges para input slots que no tienen ningún edge existente (auto o manual).
 * Regla: cualquier upstream puede conectar; el más cercano (mayor order_index) gana.
 * Retorna el número de edges creados.
 */
async function autoWire(project_id, db) {
  // Nodos activos del canvas con su DNA
  const { data: projectNodes, error } = await db()
    .from('forge_project_nodes')
    .select('id, order_index, node_type, lane_id, forge_nodes(inputs, outputs)')
    .eq('project_id', project_id)
    .eq('removed', false)
    .order('order_index')

  if (error) throw error

  // Edges existentes — incluye source para dedup de one_or_more
  const { data: existingEdges } = await db()
    .from('forge_project_edges')
    .select('source_node_id, target_node_id, target_handle')
    .eq('project_id', project_id)

  // Mapa id → inputs array para normalizar handles posicionales (in-0 → in-key)
  const inputsByNodeId = {}
  for (const pn of (projectNodes || [])) {
    const raw = pn.forge_nodes?.inputs
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.wired) ? raw.wired : null
    if (arr) inputsByNodeId[pn.id] = arr
  }

  // connectedSlots: "target:handle"          — dedup para cardinality single
  // connectedPairs: "source→target:handle"   — dedup para cardinality one_or_more
  const connectedSlots = new Set()
  const connectedPairs = new Set()
  for (const e of (existingEdges || [])) {
    let handle = e.target_handle
    if (handle?.startsWith('in-')) {
      const after = handle.slice(3)
      const idx   = parseInt(after, 10)
      if (!isNaN(idx) && String(idx) === after) {
        const inputs = inputsByNodeId[e.target_node_id]
        if (inputs?.[idx]?.key) handle = `in-${inputs[idx].key}`
      }
    }
    connectedSlots.add(`${e.target_node_id}:${handle}`)
    connectedPairs.add(`${e.source_node_id}→${e.target_node_id}:${handle}`)
  }

  // Solo forge_nodes tienen DNA inputs/outputs — primitivos y assets son fuentes manuales
  const forgeNodes = (projectNodes || []).filter(
    pn => (pn.node_type ?? 'forge_node') === 'forge_node' && pn.forge_nodes
  )

  const newEdges = []

  for (const target of forgeNodes) {
    const rawInputs = target.forge_nodes.inputs

    // Soporta formato v1.3.0 {wired:[...], direct_context} y legacy array
    const inputs = Array.isArray(rawInputs)
      ? rawInputs
      : Array.isArray(rawInputs?.wired) ? rawInputs.wired : []

    if (inputs.length === 0) continue

    // Upstreams ordenados del más reciente al más lejano
    const upstreams = forgeNodes
      .filter(pn => pn.order_index < target.order_index)
      .sort((a, b) => b.order_index - a.order_index)

    for (let inputIdx = 0; inputIdx < inputs.length; inputIdx++) {
      const input        = inputs[inputIdx]
      const slotKey      = `${target.id}:in-${input.key}`
      const isOneOrMore  = input.cardinality === 'one_or_more'

      // Single: saltar si el slot ya tiene algún edge
      if (!isOneOrMore && connectedSlots.has(slotKey)) continue

      let matched = false
      for (const upstream of upstreams) {
        if (!isOneOrMore && matched) break

        // Regla de lanes:
        // ✓ mismo lane → mismo lane
        // ✓ lane → sin lane (nodo de instancia conecta a nodo post-fan-in compartido)
        // ✓ sin lane → sin lane
        // ✓ sin lane → lane (contexto compartido pre-fan-out hacia cada instancia; slots
        //   ya ocupados por fan-out.service.js quedan protegidos por el guard de cardinality)
        // ✗ lane-A → lane-B (cross-lane entre instancias distintas)
        const srcLane = upstream.lane_id ?? null
        const tgtLane = target.lane_id   ?? null
        if (srcLane !== null && tgtLane !== null && srcLane !== tgtLane) continue

        // Normalizar outputs: soporta array plano, objeto suelto, y { connections, assets } legacy
        let outputs = upstream.forge_nodes.outputs
        if (!Array.isArray(outputs)) {
          if (outputs && typeof outputs === 'object') {
            if (Array.isArray(outputs.connections) || Array.isArray(outputs.assets)) {
              outputs = [
                ...(Array.isArray(outputs.connections) ? outputs.connections : []),
                ...(Array.isArray(outputs.assets)      ? outputs.assets      : []),
              ]
            } else if (outputs.key || outputs.name) {
              // objeto suelto de un solo output (sin envolver en array)
              outputs = [outputs]
            } else {
              continue
            }
          } else {
            continue
          }
        }

        for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
          const output    = outputs[outIdx]
          const outputKey = output.key || output.name
          const outputType = FORMAT_TO_TYPE[output.format] ?? output.format
          const keyMatch  = outputKey === input.key
          const typeMatch = (input.accepts || []).includes(outputType)
          const typeFromInput = input.type

          if (keyMatch || (typeMatch && !typeFromInput)) {
            const pairKey = `${upstream.id}→${target.id}:in-${input.key}`
            // One_or_more: saltar solo si este par source→target ya existe
            if (isOneOrMore && connectedPairs.has(pairKey)) break

            newEdges.push({
              project_id,
              source_node_id: upstream.id,
              source_handle:  `out-${outputKey}`,
              target_node_id: target.id,
              target_handle:  `in-${input.key}`,
              is_auto:        true,
            })

            if (isOneOrMore) {
              connectedPairs.add(pairKey)
            } else {
              connectedSlots.add(slotKey)
              matched = true
            }
            break
          }
        }
      }
    }
  }

  if (newEdges.length > 0) {
    const { error: insertErr } = await db()
      .from('forge_project_edges')
      .insert(newEdges)
    if (insertErr) throw insertErr
    console.log(`[auto-wire] project=${project_id} → ${newEdges.length} edge(s) creados`)
  }

  return newEdges.length
}

/**
 * Al remover un nodo: borra todos sus edges y re-corre auto-wiring
 * para que nodos downstream recuperen conexiones desde otros upstream.
 */
async function cleanupAndRewire(project_id, project_node_id, db) {
  await db()
    .from('forge_project_edges')
    .delete()
    .eq('project_id', project_id)
    .or(`source_node_id.eq.${project_node_id},target_node_id.eq.${project_node_id}`)

  return autoWire(project_id, db)
}

module.exports = { autoWire, cleanupAndRewire }
