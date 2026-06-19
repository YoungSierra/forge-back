// Motor de fan-out: type-driven, sin flags en blueprints ni nodos.
// Regla (Instancing Brief v1.2): list<T> → single<T> dispara fan-out (una instancia por ítem).
// Fan-in: primer nodo downstream con cardinality one_or_more.

const LANE_COLORS  = ['#60a5fa', '#a78bfa', '#34d399', '#f59e0b', '#fb923c']
const LANE_KEYS    = ['A', 'B', 'C', 'D', 'E']

const NODE_W       = 210
const NODE_H       = 130
const LANE_GAP_V   = 230
const NODE_STEP_X  = 290
const START_OFFSET = 360

// ── Helpers de inputs ──────────────────────────────────────────────────────────

function getInputPorts(inputs) {
  if (Array.isArray(inputs)) return inputs
  if (Array.isArray(inputs?.wired)) return inputs.wired
  return []
}

// ── Clasificación type-driven de la secuencia ─────────────────────────────────

/**
 * Lee el DNA de los nodos de la secuencia y clasifica:
 *   - laneSeqNodes : tienen un port single<itemType>
 *   - fanInSeqNode : primer nodo con port one_or_more<T> (después de los lane nodes)
 *   - postSeqNodes : nodos tras el fan-in
 */
async function classifySequenceNodes(sequence, itemType, db) {
  const seqNodeIds = sequence.map(s => s.node_id).filter(Boolean)
  if (!seqNodeIds.length) return { laneSeqNodes: [], fanInSeqNode: null, postSeqNodes: [] }

  const { data: dnaRows } = await db()
    .from('forge_nodes')
    .select('id, inputs')
    .in('id', seqNodeIds)

  const dna = Object.fromEntries((dnaRows || []).map(n => [n.id, n]))

  // Primer nodo con single<itemType> → inicio del fan-out
  const fanOutStartNode = sequence.find(s => {
    const ports = getInputPorts(dna[s.node_id]?.inputs)
    return ports.some(p => p.cardinality === 'single' && p.type === itemType)
  })
  if (!fanOutStartNode) return { laneSeqNodes: [], fanInSeqNode: null, postSeqNodes: [] }

  const laneStartIdx = sequence.findIndex(s => s.node_id === fanOutStartNode.node_id)

  // Primer nodo con one_or_more → fan-in
  const fanInSeqNode = sequence.slice(laneStartIdx).find(s => {
    const ports = getInputPorts(dna[s.node_id]?.inputs)
    return ports.some(p => p.cardinality === 'one_or_more')
  }) ?? null

  const fanInIdx = fanInSeqNode
    ? sequence.findIndex(s => s.node_id === fanInSeqNode.node_id)
    : -1

  // Todos los nodos entre fan-out start y fan-in → lane nodes (incluye 2.3, 2.4)
  const laneSeqNodes = fanInIdx >= 0
    ? sequence.slice(laneStartIdx, fanInIdx)
    : sequence.slice(laneStartIdx)

  const postSeqNodes = fanInIdx >= 0 ? sequence.slice(fanInIdx + 1) : []

  return { laneSeqNodes, fanInSeqNode, postSeqNodes }
}

// ── Parsing de texto (fallback cuando el LLM no emitió JSON limpio) ───────────

/**
 * Parsea líneas de lista a objetos concept_seed mínimos.
 * Soporta "- Variation N: Title: desc" y "- Title: desc"
 */
function parseSeeds(content) {
  if (!content) return []
  const seeds = []
  for (const line of content.split('\n')) {
    const m = line.match(/^[-*]\s*(?:Variation\s+\d+:\s*)?([^:\n]+?)(?:\s*:\s*(.+?))?[\s]*$/)
    const title = m?.[1]?.trim()
    // Ignorar bullets de análisis con bold markers (**Hook:**, **Audience fit:** etc.)
    if (!title || title.length <= 2 || title.startsWith('**') || title.startsWith('*')) continue
    seeds.push({
      title,
      one_liner: m[2]?.trim() || title,
      rationale: '',
    })
  }
  return seeds
}

/**
 * Extrae la sección "## selected_seeds" de un markdown y parsea sus ítems.
 */
function extractSeedsFromAsset(content) {
  if (!content) return []
  // Acepta: ## selected_seeds | **selected_seeds** | selected_seeds (con o sin bold/heading)
  const startRx = /^(?:#{1,3}\s+|\*{1,2})?selected_seeds\*{0,2}:?\s*$/im
  // Usar la ÚLTIMA ocurrencia: el LLM a veces abre con ## selected_seeds
  // y repite el heading al final con la lista limpia
  let match = null
  let m
  const globalRx = new RegExp(startRx.source, 'gim')
  while ((m = globalRx.exec(content)) !== null) match = m

  const body = match
    ? (() => {
        const after = content.slice(match.index + match[0].length)
        // Solo cortar en heading real (##), no en texto bold (**)
        const nextH = /^#{1,3}\s+\S/im.exec(after)
        return nextH ? after.slice(0, nextH.index) : after
      })()
    : content
  return parseSeeds(body)
}

/**
 * Parsea el contenido de un asset como array de ítems del type_registry.
 * Intenta JSON primero; fallback a text parsing (concept_seed mínimo).
 */
function parseItemsFromContent(content) {
  if (!content) return []
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed
  } catch (_) {}
  return extractSeedsFromAsset(content)
}

// ── Motor principal ────────────────────────────────────────────────────────────

/**
 * Crea lanes e instancias de nodos.
 *
 * @param {string}   opts.project_id
 * @param {string}   opts.gate_project_node_id  - project_node_id del nodo que disparó el fan-out
 * @param {string}   opts.gate_output_key        - nombre del Connection output (ej: "selected_seeds")
 * @param {Object}   opts.nextBlueprint          - { id, node_sequence: [...] }
 * @param {Array}    opts.items                  - ítems del type_registry (objetos estructurados)
 * @param {string}   opts.itemType               - T de list<T> (ej: "concept_seed")
 * @param {Function} opts.db                     - Supabase client factory
 */
async function fanOut({ project_id, gate_project_node_id, gate_output_key, nextBlueprint, items, itemType, db }) {
  const sequence = nextBlueprint.node_sequence || []

  const { laneSeqNodes, fanInSeqNode, postSeqNodes } =
    await classifySequenceNodes(sequence, itemType, db)

  if (laneSeqNodes.length === 0 || items.length === 0) {
    console.log('[fan-out] sin lane nodes o sin items — noop')
    return { lanes_created: 0, nodes_created: 0 }
  }

  // Idempotencia
  const { data: existingLanes } = await db()
    .from('forge_lanes')
    .select('id')
    .eq('project_id', project_id)
    .limit(1)

  if (existingLanes?.length > 0) {
    console.log('[fan-out] lanes ya existen — skipping')
    return { lanes_created: 0, nodes_created: 0 }
  }

  // 1. Crear forge_lanes (bound_item_ref = JSONB del ítem completo)
  const laneRows = items.slice(0, 5).map((item, i) => ({
    project_id,
    lane_key:       LANE_KEYS[i],
    label:          item.title || item.label || `Lane ${LANE_KEYS[i]}`,
    color:          LANE_COLORS[i],
    bound_item_ref: item,
  }))

  const { data: createdLanes, error: lanesErr } = await db()
    .from('forge_lanes')
    .insert(laneRows)
    .select('id, lane_key, label, color, bound_item_ref')

  if (lanesErr) throw lanesErr

  // 2. Canvas layout para posicionar relativo al gate
  const { data: projectRow } = await db()
    .from('projects')
    .select('canvas_layout')
    .eq('id', project_id)
    .single()

  const savedNodes = projectRow?.canvas_layout?.nodes ?? []

  // Calcular Y base desde los nodos existentes para que los nuevos queden alineados
  const existingYVals = savedNodes.map(n => n.position?.y).filter(y => typeof y === 'number')
  const baseY = existingYVals.length > 0
    ? Math.round(existingYVals.reduce((a, b) => a + b, 0) / existingYVals.length)
    : 0

  const existingXVals = savedNodes.map(n => n.position?.x).filter(x => typeof x === 'number')
  const maxX = existingXVals.length > 0 ? Math.max(...existingXVals) : 760

  const gatePos = savedNodes.find(n => n.id === gate_project_node_id)?.position
    ?? { x: maxX, y: baseY }

  // 3. Próximo order_index disponible
  const { data: maxOrder } = await db()
    .from('forge_project_nodes')
    .select('order_index')
    .eq('project_id', project_id)
    .order('order_index', { ascending: false })
    .limit(1)
    .maybeSingle()

  let nextIdx = (maxOrder?.order_index ?? -1) + 1

  // 4. Crear project_nodes instanciados por lane
  const startX  = gatePos.x + START_OFFSET
  const totalH  = (createdLanes.length - 1) * LANE_GAP_V
  const firstY  = gatePos.y - totalH / 2

  const newPositions        = {}
  const allLaneFirstNodeIds = []
  const allLaneLastNodeIds  = []

  for (let li = 0; li < createdLanes.length; li++) {
    const lane  = createdLanes[li]
    const laneY = firstY + li * LANE_GAP_V

    const toInsert = laneSeqNodes.map((seqNode, j) => ({
      project_id,
      node_id:        seqNode.node_id,
      blueprint_id:   nextBlueprint.id,
      order_index:    nextIdx++,
      lane_id:        lane.id,
      bound_item_ref: lane.bound_item_ref,
    }))

    const { data: inserted, error: insErr } = await db()
      .from('forge_project_nodes')
      .insert(toInsert)
      .select('id, node_id, order_index')

    if (insErr) throw insErr

    // Ordenar por order_index — Supabase no garantiza el orden del resultado del INSERT
    const sorted = [...inserted].sort((a, b) => a.order_index - b.order_index)
    for (let j = 0; j < sorted.length; j++) {
      newPositions[sorted[j].id] = { x: startX + j * NODE_STEP_X, y: laneY }
    }

    allLaneFirstNodeIds.push(sorted[0].id)
    allLaneLastNodeIds.push(sorted[sorted.length - 1].id)
  }

  // 5. Nodo fan-in y post-fan-in
  const { data: existingPNodes } = await db()
    .from('forge_project_nodes')
    .select('id, node_id')
    .eq('project_id', project_id)
    .eq('removed', false)

  const existingNodeIds = new Set((existingPNodes || []).map(n => n.node_id))

  const fanInX = startX + laneSeqNodes.length * NODE_STEP_X + 100
  const fanInY = gatePos.y
  let   fanInProjectNodeId = null

  if (fanInSeqNode) {
    if (!existingNodeIds.has(fanInSeqNode.node_id)) {
      const { data: fanInPN } = await db()
        .from('forge_project_nodes')
        .insert({ project_id, node_id: fanInSeqNode.node_id, blueprint_id: nextBlueprint.id, order_index: nextIdx++ })
        .select('id')
        .single()
      fanInProjectNodeId = fanInPN?.id
      if (fanInPN) newPositions[fanInPN.id] = { x: fanInX, y: fanInY }
    } else {
      fanInProjectNodeId = (existingPNodes || []).find(n => n.node_id === fanInSeqNode.node_id)?.id ?? null
    }
  }

  const postToInsert = postSeqNodes
    .filter(s => !existingNodeIds.has(s.node_id))
    .map((s, i) => ({
      project_id,
      node_id:      s.node_id,
      blueprint_id: nextBlueprint.id,
      order_index:  nextIdx++,
    }))

  if (postToInsert.length > 0) {
    const { data: postPN } = await db()
      .from('forge_project_nodes')
      .insert(postToInsert)
      .select('id, node_id')

    for (let i = 0; i < (postPN || []).length; i++) {
      newPositions[postPN[i].id] = { x: fanInX + (i + 1) * NODE_STEP_X, y: fanInY }
    }
  }

  // 6. Persistir posiciones en canvas_layout
  const currentLayout = projectRow?.canvas_layout ?? { templateId: null, nodes: [], edges: [] }
  const layoutNodeMap = {}
  for (const n of (currentLayout.nodes ?? [])) layoutNodeMap[n.id] = n
  for (const [pnId, pos] of Object.entries(newPositions)) {
    layoutNodeMap[pnId] = { ...(layoutNodeMap[pnId] ?? {}), id: pnId, position: pos }
  }
  await db().from('projects')
    .update({ canvas_layout: { ...currentLayout, nodes: Object.values(layoutNodeMap) } })
    .eq('id', project_id)

  // 7. Edges fan-out (gate → primer nodo de cada lane)
  const fanOutEdges = allLaneFirstNodeIds.map(firstNodeId => ({
    project_id,
    source_node_id: gate_project_node_id,
    source_handle:  `out-${gate_output_key}`,
    target_node_id: firstNodeId,
    target_handle:  'in',
    is_auto:        true,
  }))

  // Edges fan-in (último nodo de cada lane → fan-in)
  const fanInEdges = fanInProjectNodeId
    ? allLaneLastNodeIds.map(lastNodeId => ({
        project_id,
        source_node_id: lastNodeId,
        source_handle:  'out',
        target_node_id: fanInProjectNodeId,
        target_handle:  'in',
        is_auto:        true,
      }))
    : []

  const allEdges = [...fanOutEdges, ...fanInEdges]
  if (allEdges.length > 0) {
    const { error: edgeErr } = await db().from('forge_project_edges').insert(allEdges)
    if (edgeErr) console.error('[fan-out] error creando edges explícitos:', edgeErr.message)
    else console.log(`[fan-out] ${allEdges.length} edges explícitos creados (fanOut + fanIn)`)
  }

  // 8. AutoWire intra-lane
  const { autoWire } = require('./auto-wire.service')
  let wireCount = 0
  try { wireCount = await autoWire(project_id, db) }
  catch (e) { console.error('[fan-out] autoWire failed:', e.message) }

  const totalNodes = Object.keys(newPositions).length
  console.log(`[fan-out] project=${project_id} → ${createdLanes.length} lanes, ${totalNodes} nodos, ${wireCount} edges auto-wire`)

  return { lanes_created: createdLanes.length, nodes_created: totalNodes }
}

module.exports = { fanOut, classifySequenceNodes, parseItemsFromContent, extractSeedsFromAsset, parseSeeds }
