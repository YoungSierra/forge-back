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
    .select('id, order_index, node_type, forge_nodes(inputs, outputs)')
    .eq('project_id', project_id)
    .eq('removed', false)
    .order('order_index')

  if (error) throw error

  // Slots que ya tienen edge — no se tocan
  const { data: existingEdges } = await db()
    .from('forge_project_edges')
    .select('target_node_id, target_handle')
    .eq('project_id', project_id)

  const connectedSlots = new Set(
    (existingEdges || []).map(e => `${e.target_node_id}:${e.target_handle}`)
  )

  // Solo forge_nodes tienen DNA inputs/outputs — primitivos y assets son fuentes manuales
  const forgeNodes = (projectNodes || []).filter(
    pn => (pn.node_type ?? 'forge_node') === 'forge_node' && pn.forge_nodes
  )

  const newEdges = []

  for (const target of forgeNodes) {
    const inputs = target.forge_nodes.inputs
    if (!Array.isArray(inputs) || inputs.length === 0) continue

    // Upstreams ordenados del más reciente al más lejano
    const upstreams = forgeNodes
      .filter(pn => pn.order_index < target.order_index)
      .sort((a, b) => b.order_index - a.order_index)

    for (let inputIdx = 0; inputIdx < inputs.length; inputIdx++) {
      const input      = inputs[inputIdx]
      const slotKey    = `${target.id}:in-${input.key}`

      if (connectedSlots.has(slotKey)) continue

      let matched = false
      for (const upstream of upstreams) {
        if (matched) break
        const outputs = upstream.forge_nodes.outputs
        if (!Array.isArray(outputs)) continue

        for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
          const output     = outputs[outIdx]
          const outputType = FORMAT_TO_TYPE[output.format] ?? output.format

          if (output.name === input.key && (input.accepts || []).includes(outputType)) {
            newEdges.push({
              project_id,
              source_node_id: upstream.id,
              source_handle:  `out-${output.name}`,
              target_node_id: target.id,
              target_handle:  `in-${input.key}`,
              is_auto:        true,
            })
            connectedSlots.add(slotKey)
            matched = true
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
