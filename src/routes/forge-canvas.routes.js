const express    = require('express')
const router     = express.Router({ mergeParams: true })
const multer     = require('multer')
const { db }     = require('../services/supabase.service')
const { autoWire, cleanupAndRewire } = require('../services/auto-wire.service')

// Multer para attachments de chat — límite 50 MB por archivo
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
})

// ─── Migración de output_images: formato viejo → nuevo con variations[] ──────
// Viejo: [{ index, image_url, text }]
// Nuevo: [{ index, variations: [{ url, condition }] }]
function migrateOutputImages(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const result = {}
  for (const [key, items] of Object.entries(raw)) {
    if (!Array.isArray(items)) { result[key] = items; continue }
    result[key] = items.map(item => {
      if (Array.isArray(item.variations)) return item  // ya en nuevo formato
      return {
        index:      item.index,
        variations: item.image_url ? [{ url: item.image_url, condition: null }] : [],
      }
    })
  }
  return result
}

// ─── Normalización post-generación de secciones estructuradas ────────────────

// Normaliza listas estructuradas a bullets "- item" para renderizado consistente
// El LLM debe incluir el label "Variation N:" en el texto — esta función solo
// garantiza que cada ítem tenga el prefijo bullet correcto
function normalizeStructuredSection(body) {
  const lines  = body.split('\n')
  const result = []

  for (const line of lines) {
    const t = line.trim()
    if (!t)                  { result.push('');  continue }
    if (/^#{1,4}\s/.test(t)) { result.push(t);   continue }  // subheadings — conservar
    if (/^---+$/.test(t))    { continue }                     // HR — saltar
    if (/^[-*•]\s/.test(t))  { result.push(t);   continue }  // ya es bullet — conservar

    const numbered = t.match(/^\d+[.)]\s+(.+)/)
    if (numbered)            { result.push('- ' + numbered[1]); continue }
    if (t.length > 2)        { result.push('- ' + t) }
  }
  return result.join('\n')
}

// Asegura que las filas con | tengan formato de tabla markdown con separador
function normalizeTableSection(body) {
  const lines  = body.split('\n')
  const rows   = lines.filter(l => l.trim().includes('|'))
  const rest   = lines.filter(l => !l.trim().includes('|'))
  if (!rows.length) return body

  const normalized = rows.map(r => {
    let t = r.trim()
    if (!t.startsWith('|')) t = '| ' + t
    if (!t.endsWith('|'))   t = t + ' |'
    return t
  })

  // Agregar separador --- después de la primera fila si no existe
  const hasSep = normalized.some(r => /^\|[\s\-:]+(\|[\s\-:]+)*\|$/.test(r))
  if (!hasSep && normalized.length >= 1) {
    const colCount = (normalized[0].match(/\|/g) || []).length - 1
    normalized.splice(1, 0, '|' + ' --- |'.repeat(colCount))
  }

  return (rest.filter(Boolean).length ? rest.join('\n') + '\n' : '') + normalized.join('\n') + '\n'
}

// Aplica normalización a las secciones del replyText según el format declarado en cada output
function normalizeOutputSections(text, outputDefs) {
  if (!outputDefs || !outputDefs.length) return text
  const structuredNames = new Set(outputDefs.filter(o => typeof o === 'object' && o.format === 'structured').map(o => o.name).filter(Boolean))
  const tableNames      = new Set(outputDefs.filter(o => typeof o === 'object' && o.format === 'markdown_table').map(o => o.name).filter(Boolean))
  if (!structuredNames.size && !tableNames.size) return text

  // Partir por \n## — más fiable que split con regex multiline+^  en Node.js
  const SEP   = '\n## '
  const parts = ('\n' + text).split(SEP)
  // parts[0] = '\n' + texto previo al primer ## (o vacío si empieza con ##)
  const result = [parts[0].slice(1)]  // quitar el \n que agregamos para hacer el split uniforme

  for (let i = 1; i < parts.length; i++) {
    const newlineIdx = parts[i].indexOf('\n')
    if (newlineIdx < 0) { result.push('## ' + parts[i]); continue }

    const name = parts[i].slice(0, newlineIdx).trim()
    const body = parts[i].slice(newlineIdx)

    let normalizedBody = body
    if (structuredNames.has(name))  normalizedBody = normalizeStructuredSection(body)
    else if (tableNames.has(name))  normalizedBody = normalizeTableSection(body)

    result.push('## ' + name + normalizedBody)
  }
  return result.join('\n')
}

// ─── GET /api/projects/:id/canvas ────────────────────────────
// Devuelve los nodos del proyecto con su DNA + última sesión
router.get('/', async (req, res, next) => {
  try {
    const { id: project_id } = req.params

    // Nodos activos del canvas — forge_nodes y asset-nodes
    const { data: projectNodes, error: nodesError } = await db()
      .from('forge_project_nodes')
      .select(`
        id, order_index, added_at,
        node_type, node_id, source_asset_id,
        text_label, text_content, is_stale,
        blueprint_id, lane_id, bound_item_ref,
        forge_nodes (
          id, node_key, title, phase, purpose,
          inputs, outputs, tools, skills, executor, status, role,
          default_prompt, standalone_prompt
        ),
        forge_project_library_assets (
          id, display_name, description, file_name, mime_type, file_size_bytes,
          asset_type, storage_url, extracted_text
        )
      `)
      .eq('project_id', project_id)
      .eq('removed', false)
      .order('order_index')

    if (nodesError) throw nodesError

    // Sesiones por nodo: generales (output_key null) y por output específico
    const nodeIds = (projectNodes || []).filter(pn => pn.node_id).map(pn => pn.node_id)
    let sessionsByNodeId = {}           // node_id → última sesión general
    let outputSessionsByNodeId = {}     // node_id → { [output_key]: última sesión }
    let sessionsWithAgentMsg = new Set()

    if (nodeIds.length > 0) {
      // Intenta con output_key; si falla (migración 027 pendiente) reintenta sin ella
      let rawSessions = []
      {
        const { data, error } = await db()
          .from('forge_sessions')
          .select('id, node_id, output_key, status, iteration_count, started_at, completed_at, output_asset_id, output_images')
          .eq('project_id', project_id)
          .in('node_id', nodeIds)
          .order('created_at', { ascending: false })

        if (error) {
          // Columna output_key no existe aún — fallback sin ella
          const { data: data2, error: err2 } = await db()
            .from('forge_sessions')
            .select('id, node_id, status, iteration_count, started_at, completed_at, output_asset_id, output_images')
            .eq('project_id', project_id)
            .in('node_id', nodeIds)
            .order('created_at', { ascending: false })
          if (err2) throw err2
          rawSessions = (data2 || []).map(s => ({ ...s, output_key: null }))
        } else {
          rawSessions = data || []
        }
      }

      for (const s of rawSessions) {
        if (s.output_images) s.output_images = migrateOutputImages(s.output_images)
        if (s.output_key) {
          // Sesión específica de un output — una por output_key por nodo
          if (!outputSessionsByNodeId[s.node_id]) outputSessionsByNodeId[s.node_id] = {}
          if (!outputSessionsByNodeId[s.node_id][s.output_key]) {
            outputSessionsByNodeId[s.node_id][s.output_key] = s
          }
        } else {
          // Sesión general del nodo
          if (!sessionsByNodeId[s.node_id]) sessionsByNodeId[s.node_id] = s
        }
      }
    }

    // Todas las sesiones activas para detectar crash (sin asset, con mensajes de agente)
    const allSessions = [
      ...Object.values(sessionsByNodeId),
      ...Object.values(outputSessionsByNodeId).flatMap(m => Object.values(m)),
    ]

    // Detectar sesiones active sin asset pero con mensajes de agente (crash en run previo)
    const activeSessIds = allSessions
      .filter(s => s.status === 'active' && !s.output_asset_id)
      .map(s => s.id)
    if (activeSessIds.length > 0) {
      const { data: agentMsgs } = await db()
        .from('forge_messages')
        .select('session_id')
        .in('session_id', activeSessIds)
        .eq('role', 'agent')
        .limit(activeSessIds.length)
      for (const m of (agentMsgs || [])) sessionsWithAgentMsg.add(m.session_id)
    }

    // Cargar output assets de todas las sesiones aprobadas/auto_approved (batch — evita N+1)
    const outputAssetIds = allSessions
      .filter(s => (s.status === 'approved' || s.status === 'auto_approved') && s.output_asset_id)
      .map(s => s.output_asset_id)

    let outputAssetsMap = {}
    if (outputAssetIds.length > 0) {
      const { data: outputAssets } = await db()
        .from('forge_assets')
        .select('id, name, format, storage_url, content')
        .in('id', outputAssetIds)
      for (const a of (outputAssets || [])) {
        outputAssetsMap[a.id] = { id: a.id, name: a.name, format: a.format, storage_url: a.storage_url || null, content: a.content || null }
      }
    }

    const nodes = (projectNodes || []).map(pn => {
      const nodeType     = pn.node_type || 'forge_node'
      const session      = nodeType === 'forge_node' ? (sessionsByNodeId[pn.node_id] || null) : null
      const output_asset = session?.output_asset_id ? (outputAssetsMap[session.output_asset_id] ?? null) : null
      const has_content  = !!(output_asset || (session && sessionsWithAgentMsg.has(session.id)))

      // Construir mapa de sesiones por output_key
      const outputSessMap = nodeType === 'forge_node' ? (outputSessionsByNodeId[pn.node_id] ?? {}) : {}
      const output_sessions = {}
      for (const [ok, os] of Object.entries(outputSessMap)) {
        const oa = os.output_asset_id ? (outputAssetsMap[os.output_asset_id] ?? null) : null
        output_sessions[ok] = { ...os, output_asset: oa, has_content: !!(oa || sessionsWithAgentMsg.has(os.id)) }
      }

      return {
        project_node_id: pn.id,
        order_index:     pn.order_index,
        blueprint_id:    pn.blueprint_id,
        lane_id:         pn.lane_id         ?? null,
        bound_item_ref:  pn.bound_item_ref  ?? null,
        node_type:       nodeType,
        node:            pn.forge_nodes || null,
        asset:           pn.forge_project_library_assets || null,
        text_label:      pn.text_label  ?? null,
        text_content:    pn.text_content ?? null,
        is_stale:        pn.is_stale ?? false,
        session:         session ? { ...session, output_asset, has_content } : null,
        output_sessions,
      }
    })

    // Blueprint activo (el último cargado) con su gate_decision
    const { data: activeBlueprint } = await db()
      .from('forge_project_blueprints')
      .select('blueprint_id, trigger, loaded_at, gate_decision, forge_blueprints(id, blueprint_key, name, phase, gate)')
      .eq('project_id', project_id)
      .order('loaded_at', { ascending: false })
      .limit(1)
      .single()

    // Edges persistidos en DB (tabla puede no existir si la migración aún no se corrió)
    let edges = []
    try {
      const { data: edgeRows, error: edgeError } = await db()
        .from('forge_project_edges')
        .select('id, source_node_id, target_node_id, source_handle, target_handle')
        .eq('project_id', project_id)
      if (edgeError) {
        console.error('[forge-canvas] GET edges failed:', edgeError.message)
      } else {
        edges = (edgeRows || []).map(e => ({
          id:           e.id,
          source:       e.source_node_id,
          target:       e.target_node_id,
          sourceHandle: e.source_handle ?? null,
          targetHandle: e.target_handle ?? null,
        }))
      }
    } catch (e) { console.error('[forge-canvas] GET edges unexpected error:', e.message) }

    // Canvas layout guardado (posiciones de nodos) — se escribe en tabla 'projects'
    const { data: projectRow } = await db()
      .from('projects')
      .select('canvas_layout')
      .eq('id', project_id)
      .single()

    // Lanes del proyecto (tabla puede no existir si la migración 029 no se corrió aún)
    let lanes = []
    try {
      const { data: lanesData } = await db()
        .from('forge_lanes')
        .select('id, lane_key, label, color, bound_item_ref')
        .eq('project_id', project_id)
        .order('lane_key')
      lanes = lanesData || []
    } catch (e) { console.error('[forge-canvas] GET lanes failed (tabla puede no existir):', e.message) }

    res.json({
      success: true,
      nodes,
      edges,
      lanes,
      canvas_layout: projectRow?.canvas_layout ?? null,
      active_blueprint: activeBlueprint
        ? { ...activeBlueprint.forge_blueprints, gate_decision: activeBlueprint.gate_decision ?? null }
        : null,
    })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/gate ──────────────────────
// Registra la decisión del gate; si es ACCEPT carga el siguiente blueprint
router.post('/gate', async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    const { decision, blueprint_id, member_id } = req.body

    if (!['ACCEPT', 'REFINE', 'KILL'].includes(decision)) {
      return res.status(400).json({ success: false, error: 'decision debe ser ACCEPT, REFINE o KILL' })
    }

    // Registrar decisión en el historial del blueprint
    await db()
      .from('forge_project_blueprints')
      .update({ gate_decision: decision })
      .eq('project_id', project_id)
      .eq('blueprint_id', blueprint_id)

    if (decision !== 'ACCEPT') {
      return res.json({ success: true, decision, next_blueprint: null })
    }

    // ACCEPT → sellar todos los nodos auto_approved del blueprint aceptado
    // Obtener los node_ids del blueprint
    const { data: bpNodes } = await db()
      .from('forge_project_nodes')
      .select('node_id')
      .eq('project_id', project_id)
      .eq('blueprint_id', blueprint_id)
      .eq('removed', false)

    const bpNodeIds = (bpNodes || []).map(n => n.node_id)

    if (bpNodeIds.length > 0) {
      await db()
        .from('forge_sessions')
        .update({ status: 'approved', completed_at: new Date().toISOString() })
        .eq('project_id', project_id)
        .eq('status', 'auto_approved')
        .in('node_id', bpNodeIds)
    }

    // ACCEPT → buscar y cargar el siguiente blueprint por fase
    const PHASE_SEQUENCE = ['ideation', 'concept', 'preprod', 'production']

    const { data: currentBp } = await db()
      .from('forge_blueprints')
      .select('phase')
      .eq('id', blueprint_id)
      .single()

    const currentIdx = PHASE_SEQUENCE.indexOf(currentBp?.phase)
    const nextPhase  = currentIdx >= 0 ? PHASE_SEQUENCE[currentIdx + 1] : null

    if (!nextPhase) {
      return res.json({ success: true, decision, next_blueprint: null })
    }

    const { data: nextBp } = await db()
      .from('forge_blueprints')
      .select('id, name, node_sequence')
      .eq('phase', nextPhase)
      .eq('is_default', true)
      .single()

    if (!nextBp) {
      return res.json({ success: true, decision, next_blueprint: null })
    }

    // ── Fan-out: detección type-driven (Instancing Brief v1.2) ──────────────────
    // Busca Connection outputs tipo list<T> aprobados en el blueprint actual.
    // Si el próximo blueprint tiene nodos con single<T> input → fan-out.
    // Sin flags en blueprints ni nodos; todo se deriva de port cardinalities.
    {
      const { fanOut, classifySequenceNodes, parseItemsFromContent } = require('../services/fan-out.service')

      const { data: bpNodes } = await db()
        .from('forge_project_nodes')
        .select('id, node_id')
        .eq('project_id', project_id)
        .eq('blueprint_id', blueprint_id)
        .eq('removed', false)

      const bpNodeIds = (bpNodes || []).map(n => n.node_id).filter(Boolean)

      let fanOutItems       = null
      let fanOutItemType    = null
      let fanOutOutputKey   = null
      let gateProjectNodeId = null

      if (bpNodeIds.length > 0) {
        // DNA de los nodos del blueprint actual — buscar Connection outputs list<T>
        const { data: currentDna } = await db()
          .from('forge_nodes')
          .select('id, outputs')
          .in('id', bpNodeIds)

        const nextSeqNodeIds = (nextBp.node_sequence || []).map(s => s.node_id).filter(Boolean)

        for (const node of (currentDna || [])) {
          // Soporta formato v1.3.0 (array plano con type:'connection') y legacy (outputs.connections)
          const rawOutputs = Array.isArray(node.outputs)
            ? node.outputs
            : Array.isArray(node.outputs?.connections) ? node.outputs.connections : []

          const connOutputs = rawOutputs.filter(o =>
            o.type === 'connection' || (typeof o.type === 'string' && o.type.startsWith('list<'))
          )

          for (const conn of connOutputs) {
            // v1.3.0: T viene de format ("list<concept_seed>"); legacy: T venía de type
            const T = conn.format?.match(/^list<(.+)>$/)?.[1]
              ?? conn.type?.match(/^list<(.+)>$/)?.[1]
            if (!T) continue

            // v1.3.0 usa 'key'; legacy usaba 'name'
            const connKey = conn.key ?? conn.name
            if (!connKey) continue

            // Verificar que el próximo blueprint tiene single<T> inputs
            if (nextSeqNodeIds.length > 0) {
              const { data: nextDna } = await db()
                .from('forge_nodes')
                .select('id, inputs')
                .in('id', nextSeqNodeIds)

              const hasSingleT = (nextDna || []).some(n => {
                const ports = Array.isArray(n.inputs) ? n.inputs
                  : Array.isArray(n.inputs?.wired) ? n.inputs.wired : []
                return ports.some(p => p.cardinality === 'single' && p.type === T)
              })
              if (!hasSingleT) continue
            }

            // Buscar asset aprobado para este Connection output.
            // Intento 1: sesión per-output (output_key = connKey)
            // Intento 2: forge_asset por nombre — cubre sesiones generales
            let outputAssetId = null

            const { data: perOutputSess } = await db()
              .from('forge_sessions')
              .select('output_asset_id')
              .eq('project_id', project_id)
              .eq('node_id', node.id)
              .eq('output_key', connKey)
              .in('status', ['approved', 'auto_approved'])
              .limit(1)
              .maybeSingle()

            if (perOutputSess?.output_asset_id) {
              outputAssetId = perOutputSess.output_asset_id
            } else {
              // Intento 2: sesión general (output_key IS NULL) — contiene respuesta completa
              // con la sección ## connKey embebida; extractSeedsFromAsset la extraerá
              const { data: genSess } = await db()
                .from('forge_sessions')
                .select('output_asset_id')
                .eq('project_id', project_id)
                .eq('node_id', node.id)
                .is('output_key', null)
                .in('status', ['approved', 'auto_approved'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()
              outputAssetId = genSess?.output_asset_id ?? null
            }

            if (!outputAssetId) continue

            const { data: asset } = await db()
              .from('forge_assets')
              .select('content')
              .eq('id', outputAssetId)
              .single()

            const items = parseItemsFromContent(asset?.content)
            if (!items.length) continue

            fanOutItems       = items
            fanOutItemType    = T
            fanOutOutputKey   = connKey
            gateProjectNodeId = (bpNodes || []).find(n => n.node_id === node.id)?.id ?? null
            break
          }
          if (fanOutItems) break
        }
      }

      if (fanOutItems && gateProjectNodeId) {
        const fanOutResult = await fanOut({
          project_id,
          gate_project_node_id: gateProjectNodeId,
          gate_output_key:      fanOutOutputKey,
          nextBlueprint:        nextBp,
          items:                fanOutItems,
          itemType:             fanOutItemType,
          db,
        })

        await db()
          .from('forge_project_blueprints')
          .insert({ project_id, blueprint_id: nextBp.id, trigger: 'gate_fanout', loaded_by: member_id || null })

        return res.json({
          success:        true,
          decision,
          next_blueprint: { id: nextBp.id, name: nextBp.name, phase: nextPhase },
          fan_out:        true,
          lanes_created:  fanOutResult.lanes_created,
        })
      }
      // Sin fan-out detectado — continuar con flujo normal
    }

    // ── Flujo normal (sin fan-out): cargar nodos del blueprint ────────────────
    const { data: existing } = await db()
      .from('forge_project_nodes')
      .select('node_id')
      .eq('project_id', project_id)
      .eq('removed', false)

    const existingIds = new Set((existing || []).map(n => n.node_id))

    const { data: maxOrder } = await db()
      .from('forge_project_nodes')
      .select('order_index')
      .eq('project_id', project_id)
      .order('order_index', { ascending: false })
      .limit(1)
      .single()

    const baseIndex = (maxOrder?.order_index ?? -1) + 1
    const sequence  = nextBp.node_sequence || []

    const toInsert = sequence
      .filter(s => !existingIds.has(s.node_id))
      .map((s, i) => ({
        project_id,
        node_id:      s.node_id,
        blueprint_id: nextBp.id,
        order_index:  baseIndex + i,
      }))

    if (toInsert.length > 0) {
      await db().from('forge_project_nodes').insert(toInsert)
    }

    // Registrar en historial con trigger gate_accept
    await db()
      .from('forge_project_blueprints')
      .insert({ project_id, blueprint_id: nextBp.id, trigger: 'gate_accept', loaded_by: member_id || null })

    // Auto-wiring para los nodos del nuevo blueprint
    try { await autoWire(project_id, db) } catch (e) { console.error('[gate] auto-wire failed:', e.message) }

    res.json({ success: true, decision, next_blueprint: { id: nextBp.id, name: nextBp.name, phase: nextPhase } })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/load-blueprint ────────────
// Carga un blueprint: agrega sus nodos al pool del proyecto
router.post('/load-blueprint', async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    const { blueprint_id, trigger = 'manual', loaded_by } = req.body

    if (!blueprint_id) {
      return res.status(400).json({ success: false, error: 'blueprint_id es requerido' })
    }

    // Verificar que el blueprint existe
    const { data: blueprint, error: bpError } = await db()
      .from('forge_blueprints')
      .select('id, node_sequence, edges, name')
      .eq('id', blueprint_id)
      .single()

    if (bpError || !blueprint) {
      return res.status(404).json({ success: false, error: 'Blueprint not found' })
    }

    // node_sequence: [{node_id, order_index}]
    const sequence = blueprint.node_sequence || []

    // Nodos ya en el canvas para evitar duplicados
    const { data: existing } = await db()
      .from('forge_project_nodes')
      .select('node_id')
      .eq('project_id', project_id)
      .eq('removed', false)

    const existingIds = new Set((existing || []).map(n => n.node_id))

    // Calcular el próximo order_index
    const { data: maxOrder } = await db()
      .from('forge_project_nodes')
      .select('order_index')
      .eq('project_id', project_id)
      .order('order_index', { ascending: false })
      .limit(1)
      .single()

    const baseIndex = (maxOrder?.order_index ?? -1) + 1

    // Insertar solo nodos que no están ya en el canvas
    const toInsert = sequence
      .filter(s => !existingIds.has(s.node_id))
      .map((s, i) => ({
        project_id,
        node_id:      s.node_id,
        blueprint_id,
        order_index:  baseIndex + i,
      }))

    if (toInsert.length > 0) {
      const { error: insertError } = await db()
        .from('forge_project_nodes')
        .insert(toInsert)

      if (insertError) throw insertError
    }

    // Registrar en historial
    await db()
      .from('forge_project_blueprints')
      .insert({ project_id, blueprint_id, trigger, loaded_by: loaded_by || null })

    // Crear edges desde blueprint.edges (from_node_id → to_node_id usando forge_node UUIDs)
    // Traducir a source_node_id/target_node_id usando project_node UUIDs
    let blueprintEdgesCreated = 0
    const bpEdges = Array.isArray(blueprint.edges) ? blueprint.edges : []
    if (bpEdges.length > 0) {
      // Obtener todos los project_nodes actuales para construir el mapa node_id → project_node_id
      const { data: allPNodes } = await db()
        .from('forge_project_nodes')
        .select('id, node_id')
        .eq('project_id', project_id)
        .eq('removed', false)

      const nodeIdToProjectNodeId = {}
      for (const pn of (allPNodes || [])) {
        nodeIdToProjectNodeId[pn.node_id] = pn.id
      }

      // Edges ya existentes para evitar duplicados
      const { data: existingEdges } = await db()
        .from('forge_project_edges')
        .select('source_node_id, target_node_id')
        .eq('project_id', project_id)

      const existingPairs = new Set(
        (existingEdges || []).map(e => `${e.source_node_id}:${e.target_node_id}`)
      )

      const edgesToInsert = []
      for (const edge of bpEdges) {
        const srcPNodeId = nodeIdToProjectNodeId[edge.from_node_id]
        const tgtPNodeId = nodeIdToProjectNodeId[edge.to_node_id]
        if (!srcPNodeId || !tgtPNodeId) continue
        const pair = `${srcPNodeId}:${tgtPNodeId}`
        if (existingPairs.has(pair)) continue
        edgesToInsert.push({
          project_id,
          source_node_id: srcPNodeId,
          source_handle:  null,
          target_node_id: tgtPNodeId,
          target_handle:  null,
          is_auto:        true,
        })
        existingPairs.add(pair)
      }

      if (edgesToInsert.length > 0) {
        const { error: edgeErr } = await db()
          .from('forge_project_edges')
          .insert(edgesToInsert)
        if (edgeErr) console.error('[load-blueprint] error creando blueprint edges:', edgeErr.message)
        else blueprintEdgesCreated = edgesToInsert.length
      }
    }

    // Auto-wiring adicional: conectar por tipo si hay wired ports compatibles
    let wiredCount = 0
    try { wiredCount = await autoWire(project_id, db) } catch (e) { console.error('[load-blueprint] auto-wire failed:', e.message) }

    res.json({
      success:               true,
      blueprint_name:        blueprint.name,
      nodes_added:           toInsert.length,
      nodes_skipped:         sequence.length - toInsert.length,
      blueprint_edges_added: blueprintEdgesCreated,
      edges_wired:           wiredCount,
    })
  } catch (err) { next(err) }
})

// ─── DELETE /api/projects/:id/canvas/nodes/:project_node_id ──
// Elimina un nodo del canvas (hard delete)
router.delete('/nodes/:project_node_id', async (req, res, next) => {
  try {
    const { id: project_id, project_node_id } = req.params

    // Limpiar edges primero, luego eliminar el nodo
    try { await cleanupAndRewire(project_id, project_node_id, db) } catch (e) { console.error('[remove-node] auto-wire failed:', e.message) }

    const { error } = await db()
      .from('forge_project_nodes')
      .delete()
      .eq('id', project_node_id)

    if (error) throw error

    res.json({ success: true })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:node_id/accept ─────
// Aprueba el output del nodo: crea forge_asset(s) y cierra la sesión
router.post('/nodes/:node_id/accept', async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params
    const { session_id, content, member_id, doc_url, doc_format } = req.body

    if (!session_id || !content?.trim()) {
      return res.status(400).json({ success: false, error: 'session_id y content son requeridos' })
    }

    // Obtener nombre, key y outputs del nodo
    const { data: node, error: nodeErr } = await db()
      .from('forge_nodes')
      .select('id, title, node_key, outputs')
      .eq('id', node_id)
      .single()

    if (nodeErr || !node) {
      return res.status(404).json({ success: false, error: 'Node not found' })
    }

    // Obtener output_key de la sesión para nombrar el asset correctamente
    const { data: sessRow } = await db()
      .from('forge_sessions')
      .select('output_key')
      .eq('id', session_id)
      .maybeSingle()

    // Si la sesión tiene output_key, usar el label del output DNA como nombre del asset
    const outputKey = sessRow?.output_key ?? null
    const outputDef = outputKey
      ? (node.outputs || []).find(o => (o.key || o.name) === outputKey)
      : null
    const assetName = outputDef
      ? `${node.title} — ${outputDef.label || outputDef.name || outputKey}`
      : `${node.title} — Output`

    // Crear el forge_asset con el contenido de texto aceptado
    const { data: asset, error: assetErr } = await db()
      .from('forge_assets')
      .insert({
        node_id,
        project_id,
        session_id,
        name:           assetName,
        format:         doc_url ? (doc_format === 'pptx' ? 'pptx' : 'docx') : 'markdown',
        status:         'approved',
        content:        content.trim(),
        storage_url:    doc_url || null,
        approved_by:    member_id || null,
        approved_at:    new Date().toISOString(),
      })
      .select('id')
      .single()

    if (assetErr) throw assetErr

    // Cerrar la sesión: approved + output_asset_id + completed_at
    const { error: sessErr } = await db()
      .from('forge_sessions')
      .update({
        status:          'approved',
        output_asset_id: asset.id,
        completed_at:    new Date().toISOString(),
      })
      .eq('id', session_id)

    if (sessErr) throw sessErr

    // Persistir imágenes PNG generadas en forge_assets
    const { data: sessionData } = await db()
      .from('forge_sessions')
      .select('output_images')
      .eq('id', session_id)
      .single()

    const outputImages = sessionData?.output_images || {}
    const pngOutputDefs = (node.outputs || []).filter(o =>
      (o.format === 'png' || o.format === 'image') && o.image_gen
    )

    const imageAssets = pngOutputDefs.flatMap(outDef => {
      const items = (outputImages[outDef.name] || [])
      return items.flatMap(item => {
        // Formato nuevo: variations[]
        if (Array.isArray(item.variations)) {
          return item.variations
            .filter(v => v.url)
            .map(v => ({
              node_id,
              project_id,
              session_id,
              name:        `${node.title} — ${outDef.name}`,
              format:      'png',
              status:      'approved',
              content:     null,
              storage_url: v.url,
              approved_by: member_id || null,
              approved_at: new Date().toISOString(),
            }))
        }
        // Formato viejo: image_url
        if (item.image_url) {
          return [{
            node_id,
            project_id,
            session_id,
            name:        `${node.title} — ${outDef.name}`,
            format:      'png',
            status:      'approved',
            content:     null,
            storage_url: item.image_url,
            approved_by: member_id || null,
            approved_at: new Date().toISOString(),
          }]
        }
        return []
      })
    })

    if (imageAssets.length > 0) {
      const { error: imgErr } = await db().from('forge_assets').insert(imageAssets)
      if (imgErr) console.error('[accept] Error guardando image assets:', imgErr.message)
    }

    res.json({ success: true, asset_id: asset.id, image_assets_saved: imageAssets.length })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:node_id/sessions/:session_id/generate-item-image ─
// Genera imagen on-demand para un item de un output con image_gen:true
router.post('/nodes/:node_id/sessions/:session_id/generate-item-image', async (req, res, next) => {
  try {
    const { id: project_id, node_id, session_id } = req.params
    const { output_key, item_index, item_text, condition } = req.body

    if (!output_key || item_index == null || !item_text?.trim()) {
      return res.status(400).json({ success: false, error: 'output_key, item_index y item_text son requeridos' })
    }

    // Leer DNA del nodo para obtener el workflow configurado en el output
    const { data: node, error: nodeErr } = await db()
      .from('forge_nodes')
      .select('node_key, outputs')
      .eq('id', node_id)
      .single()

    if (nodeErr || !node) {
      return res.status(404).json({ success: false, error: 'Node not found' })
    }

    const outputDef = (node.outputs || []).find(o => (o.key || o.name) === output_key)
    if (!outputDef?.image_gen) {
      return res.status(400).json({ success: false, error: `Output "${output_key}" no tiene image_gen habilitado` })
    }

    const imageGenModel = outputDef.image_gen_model
    if (!imageGenModel) {
      return res.status(400).json({ success: false, error: `Output "${output_key}" no tiene image_gen_model definido` })
    }

    // Parsear "provider:model_o_workflow"
    const colonIdx = imageGenModel.indexOf(':')
    if (colonIdx < 0) {
      return res.status(400).json({ success: false, error: `image_gen_model debe tener formato "provider:model" — recibido: "${imageGenModel}"` })
    }
    const provider   = imageGenModel.slice(0, colonIdx)
    const modelOrWf  = imageGenModel.slice(colonIdx + 1)

    const storagePath = `projects/${project_id}/item-images/${node.node_key}/${output_key}-${session_id}-${item_index}-${Date.now()}.png`

    // Limpiar markdown del texto del ítem y construir prompt final con la condición de variación
    const cleanText = item_text.trim()
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')  // quitar negrita/cursiva
      .replace(/^[-*]\s+/, '')                    // quitar bullet inicial
      .replace(/^(Variation\s+\d+:\s*)/i, '')     // quitar prefijo "Variation N:"
    const imagePrompt = condition?.trim()
      ? `${cleanText}\n\nAdditional visual requirement: ${condition.trim()}`
      : cleanText

    const { logExecution: logExec } = require('../services/execution-log.service')
    const memberId = req.headers['x-member-id'] || null
    const imgStart = Date.now()

    let result
    if (provider === 'comfyui') {
      const { generateImageComfyUI } = require('../services/providers/comfyui.provider')
      result = await generateImageComfyUI(modelOrWf, imagePrompt, 1024, 1024, storagePath)
    } else if (provider === 'openai') {
      const { generateImageOpenAI } = require('../services/providers/openai.image.provider')
      result = await generateImageOpenAI(modelOrWf, imagePrompt, 1024, 1024, storagePath)
    } else if (provider === 'fal') {
      const { generateImageFal } = require('../services/providers/fal.image.provider')
      result = await generateImageFal(modelOrWf, imagePrompt, 1024, 1024, storagePath)
    } else {
      return res.status(400).json({ success: false, error: `Provider de imagen no soportado: "${provider}"` })
    }

    // Registrar costo estimado de generación de imagen (no bloqueante, nunca rompe el flujo)
    try {
      logExec({
        project_id:   project_id,
        node_id:      node_id,
        session_id:   session_id,
        triggered_by: memberId,
        trigger_type: 'image_gen',
        executor_type: provider === 'openai' ? 'openai_image' : provider,
        provider,
        model:        modelOrWf,
        is_estimated: true,
        duration_ms:  Date.now() - imgStart,
        started_at:   new Date(imgStart).toISOString(),
        status:       'success',
        metadata:     { output_key, item_index, width: 1024, height: 1024, node_key: node.node_key },
      })
    } catch (logErr) {
      console.error('[generate-item-image] logExec failed (non-fatal):', logErr.message)
    }

    // Leer output_images actual, migrar si viene en formato viejo y hacer append
    const { data: sessionRow } = await db()
      .from('forge_sessions')
      .select('output_images')
      .eq('id', session_id)
      .single()

    const currentImages = migrateOutputImages(sessionRow?.output_images || {})
    const outputItems   = Array.isArray(currentImages[output_key]) ? [...currentImages[output_key]] : []

    // Append variación al ítem existente o crear nuevo
    const newVariation = { url: result.url, condition: condition?.trim() || null }
    const existingIdx  = outputItems.findIndex(e => e.index === item_index)
    if (existingIdx >= 0) {
      outputItems[existingIdx] = {
        ...outputItems[existingIdx],
        variations: [...(outputItems[existingIdx].variations || []), newVariation],
      }
    } else {
      outputItems.push({ index: item_index, variations: [newVariation] })
    }
    outputItems.sort((a, b) => a.index - b.index)

    const updatedImages = { ...currentImages, [output_key]: outputItems }

    const { error: updateErr } = await db()
      .from('forge_sessions')
      .update({ output_images: updatedImages })
      .eq('id', session_id)

    if (updateErr) throw updateErr

    res.json({ success: true, image_url: result.url, output_images: updatedImages })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:node_id/generate-pdf ─
// Genera (o devuelve cached) el PDF del output aprobado del nodo
router.post('/nodes/:node_id/generate-pdf', async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params

    // Buscar sesión aprobada más reciente con asset
    const { data: session } = await db()
      .from('forge_sessions')
      .select('id, output_asset_id, status')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .in('status', ['approved', 'auto_approved'])
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!session?.output_asset_id) {
      return res.status(404).json({ success: false, error: 'No approved session with asset found' })
    }

    const { data: asset } = await db()
      .from('forge_assets')
      .select('id, name, content, storage_url')
      .eq('id', session.output_asset_id)
      .single()

    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' })

    // Si ya tiene URL, devolverla sin regenerar
    if (asset.storage_url) {
      return res.json({ success: true, url: asset.storage_url })
    }

    if (!asset.content?.trim()) {
      return res.status(400).json({ success: false, error: 'Asset has no content to convert' })
    }

    // Post-procesar placeholders igual que en el chat
    const { data: project } = await db()
      .from('projects')
      .select('name, studio_name')
      .eq('id', project_id)
      .single()

    let docContent = asset.content
    const studioVal = project?.studio_name || 'V57 Studio'
    const titleVal  = project?.name || ''
    docContent = docContent
      .replace(/\[Studio(?:\s+Name)?\]/gi, studioVal)
      .replace(/\[Working\s+Title\]/gi,    titleVal)
      .replace(/\[Game\s+Title\]/gi,        titleVal)
    if (titleVal) {
      docContent = docContent.replace(/\bWorking Title\b/g, titleVal)
    }

    const { executeTool } = require('../services/tools.service')
    const docResult = await executeTool('doc_gen_docx', {
      title:   asset.name,
      content: docContent,
    }, { project_id, node_id })

    if (!docResult.success || !docResult.url) {
      return res.status(500).json({ success: false, error: 'PDF generation failed' })
    }

    // Actualizar el asset con la URL para futuras llamadas
    await db()
      .from('forge_assets')
      .update({ storage_url: docResult.url, format: 'document' })
      .eq('id', asset.id)

    res.json({ success: true, url: docResult.url })
  } catch (err) { next(err) }
})

// ─── GET /api/projects/:id/canvas/nodes/:node_id/session ─────
// Devuelve la sesión activa del nodo con sus mensajes
router.get('/nodes/:node_id/session', async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params
    const { output_key = null } = req.query

    let baseQuery = db()
      .from('forge_sessions')
      .select('id, status, iteration_count, started_at, completed_at, output_asset_id, output_images')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .order('created_at', { ascending: false })
      .limit(1)

    // Filtrar por output_key si la columna existe; si falla, cae al más reciente
    let session = null
    {
      let q = baseQuery
      if (output_key) q = q.eq('output_key', output_key)
      else            q = q.is('output_key', null)
      const { data, error: qErr } = await q.maybeSingle()
      if (qErr) {
        // Columna output_key no existe aún — buscar sin filtro
        const { data: d2, error: sessErr } = await baseQuery.maybeSingle()
        if (sessErr) throw sessErr
        session = d2
      } else {
        session = data
      }
    }
    const sessErr = null  // ya manejado arriba

    if (sessErr) throw sessErr

    // Si no hay sesión general, buscar per-output sessions con imágenes o assets
    if (!session) {
      const { data: perOutSessions } = await db()
        .from('forge_sessions')
        .select('id, output_key, output_images, output_asset_id, status')
        .eq('project_id', project_id)
        .eq('node_id', node_id)
        .not('output_key', 'is', null)
        .order('created_at', { ascending: false })

      if (!perOutSessions?.length) {
        return res.json({ success: true, session: null, messages: [] })
      }

      // Merge de output_images de todas las per-output sessions
      const allOutputImages = {}
      for (const ps of perOutSessions) {
        if (ps.output_images) {
          Object.assign(allOutputImages, migrateOutputImages(ps.output_images))
        }
      }

      // Cargar asset del primer output session aprobado que tenga uno
      let perOutAsset = null
      for (const ps of perOutSessions) {
        if (ps.output_asset_id) {
          const { data: aData } = await db()
            .from('forge_assets')
            .select('id, name, format, content, storage_url')
            .eq('id', ps.output_asset_id)
            .maybeSingle()
          if (aData) { perOutAsset = aData; break }
        }
      }

      const syntheticSession = Object.keys(allOutputImages).length
        ? { output_images: allOutputImages }
        : null

      return res.json({
        success:      true,
        session:      syntheticSession,
        messages:     [],
        asset:        perOutAsset,
        image_assets: [],
      })
    }

    const { data: msgs } = await db()
      .from('forge_messages')
      .select('id, role, content, order_index, tool_calls')
      .eq('session_id', session.id)
      .order('order_index')

    // Cargar attachments de la sesión agrupados por message_id
    const { data: attachments } = await db()
      .from('forge_attachments')
      .select('message_id, file_name, mime_type, file_size_bytes, storage_url')
      .eq('session_id', session.id)

    const attachmentsByMsg = {}
    for (const att of (attachments || [])) {
      if (!attachmentsByMsg[att.message_id]) attachmentsByMsg[att.message_id] = []
      attachmentsByMsg[att.message_id].push({
        file_name:       att.file_name,
        mime_type:       att.mime_type,
        file_size_bytes: att.file_size_bytes,
        storage_url:     att.storage_url,
      })
    }

    // Mapear roles: human→user, agent→assistant
    const messages = (msgs || []).map(m => ({
      role:        m.role === 'human' ? 'user' : 'assistant',
      content:     m.content,
      attachments: attachmentsByMsg[m.id] || [],
      tool_calls:  m.tool_calls?.length ? m.tool_calls : undefined,
    }))

    // Cargar asset si existe
    let asset = null
    let imageAssets = []
    if (session.output_asset_id) {
      const { data: assetData } = await db()
        .from('forge_assets')
        .select('id, name, format, content, storage_url')
        .eq('id', session.output_asset_id)
        .maybeSingle()
      asset = assetData

      const { data: imgData } = await db()
        .from('forge_assets')
        .select('id, name, storage_url')
        .eq('session_id', session.id)
        .eq('format', 'png')
        .not('storage_url', 'is', null)
      imageAssets = imgData || []
    }

    // Fallback: si no hay asset pero la sesión estaba aprobada, reconstruir desde el último mensaje del agente
    // Solo aplica a sesiones aprobadas — evita bloquear el botón Accept en sesiones activas
    if (!asset && (session.status === 'approved' || session.status === 'auto_approved')) {
      const { data: lastAgentMsg } = await db()
        .from('forge_messages')
        .select('content')
        .eq('session_id', session.id)
        .eq('role', 'agent')
        .order('order_index', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (lastAgentMsg?.content) {
        asset = {
          id:          null,
          name:        'Output',
          format:      'markdown',
          content:     lastAgentMsg.content,
          storage_url: null,
        }
      }
    }

    // Migrar output_images al nuevo formato con variations[] antes de devolver
    if (session.output_images) {
      session.output_images = migrateOutputImages(session.output_images)
    }

    // Merge de output_images de per-output sessions (si existen)
    const { data: perOutForMerge } = await db()
      .from('forge_sessions')
      .select('output_images')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .not('output_key', 'is', null)

    if (perOutForMerge?.length) {
      const merged = { ...(session.output_images ?? {}) }
      for (const ps of perOutForMerge) {
        if (ps.output_images) Object.assign(merged, migrateOutputImages(ps.output_images))
      }
      session = { ...session, output_images: Object.keys(merged).length ? merged : session.output_images }
    }

    res.json({ success: true, session, messages, asset, image_assets: imageAssets })
  } catch (err) { next(err) }
})

// ─── Helper: extraer una sección por heading de un documento markdown ─────────
function extractSection(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const startRx = new RegExp(`^##\\s+${escaped}\\s*$`, 'im')
  const match   = startRx.exec(content)
  if (!match) return null
  const after       = content.slice(match.index + match[0].length)
  const nextSection = /^##\s+/im.exec(after)
  return nextSection ? after.slice(0, nextSection.index).trim() : after.trim()
}

// ─── POST /api/projects/:id/canvas/nodes/:node_id/chat ────────
// Conversación multi-turno con un nodo usando forge_sessions/forge_messages
router.post('/nodes/:node_id/chat', chatUpload.single('attachment'), async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params
    const { user_message, session_id, member_id, attachment_url, target_output_key = null, project_node_id: explicit_project_node_id = null } = req.body

    if (!user_message?.trim()) {
      return res.status(400).json({ success: false, error: 'user_message es requerido' })
    }

    // Obtener definición del nodo para componer el prompt y resolver el modelo
    const { data: node, error: nodeErr } = await db()
      .from('forge_nodes')
      .select('id, node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt, standalone_prompt, role, executor')
      .eq('id', node_id)
      .single()

    if (nodeErr || !node) {
      return res.status(404).json({ success: false, error: 'Node not found' })
    }

    // Normalizar outputs para soportar formato v1.3.0 (key/label) y legacy (name)
    const normalizeOutput = o => ({ ...o, key: o.key || o.name, label: o.label || o.name || o.key })
    const allOutputDefs = (Array.isArray(node.outputs) ? node.outputs : []).map(normalizeOutput)
    const targetOutput  = target_output_key ? allOutputDefs.find(o => o.key === target_output_key) ?? null : null
    const directContext = node.inputs?.direct_context || ''

    // Buscar o crear sesión activa
    let session = null

    if (session_id) {
      const { data } = await db()
        .from('forge_sessions')
        .select('id, iteration_count')
        .eq('id', session_id)
        .maybeSingle()
      session = data
    }

    if (!session) {
      let baseQ = db()
        .from('forge_sessions')
        .select('id, iteration_count')
        .eq('project_id', project_id)
        .eq('node_id', node_id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)

      // Si hay project_node_id explícito (instancia de lane), filtrar por él para
      // diferenciar sesiones de 2.1-A vs 2.1-B (misma forge_node.id, distinto project_node)
      if (explicit_project_node_id) {
        baseQ = baseQ.eq('project_node_id', explicit_project_node_id)
      }

      // Sesión separada por output_key — null = sesión general del nodo
      let lookupQ = baseQ
      if (target_output_key) lookupQ = lookupQ.eq('output_key', target_output_key)
      else                   lookupQ = lookupQ.is('output_key', null)

      const { data: existing, error: lookupErr } = await lookupQ.maybeSingle()
      if (lookupErr) {
        // Columna output_key no existe aún — buscar sin filtro
        const { data: d2 } = await baseQ.maybeSingle()
        session = d2
      } else {
        session = existing
      }
    }

    if (!session) {
      // Intentar insertar con output_key; si falla (columna no existe), insertar sin ella
      const insertPayload = {
        project_id,
        node_id,
        output_key:       target_output_key || null,
        project_node_id:  explicit_project_node_id || null,
        status:           'active',
        iteration_count:  0,
        started_at:       new Date().toISOString(),
        triggered_by:     member_id || null,
      }
      let { data: created, error: createErr } = await db()
        .from('forge_sessions')
        .insert(insertPayload)
        .select('id, iteration_count')
        .single()
      if (createErr) {
        // Columna output_key o project_node_id no existe — insertar sin ellas
        const { output_key: _ok, project_node_id: _pnid, ...payloadWithoutKey } = insertPayload
        const { data: c2, error: e2 } = await db()
          .from('forge_sessions')
          .insert(payloadWithoutKey)
          .select('id, iteration_count')
          .single()
        if (e2) throw e2
        created = c2
      }
      session = created
    }

    // ── Procesar adjunto (Reference Injection 5.2) ───────────────
    let pendingAttachment = null

    if (req.file || attachment_url) {
      const { extractText: extractAttachText } = require('../services/extraction.service')
      const { uploadToStorage: uploadAttachment } = require('../services/storage.service')

      if (req.file) {
        // Verificar límite acumulado de sesión (200 MB)
        const { data: sizeRows } = await db()
          .from('forge_attachments')
          .select('file_size_bytes')
          .eq('session_id', session.id)
        const sessionBytes = (sizeRows || []).reduce((s, r) => s + (r.file_size_bytes || 0), 0)
        if (sessionBytes + req.file.size > 200 * 1024 * 1024) {
          return res.status(400).json({ success: false, error: 'Session attachment limit exceeded (200 MB)' })
        }

        const dotIdx      = req.file.originalname.lastIndexOf('.')
        const ext         = dotIdx >= 0 ? req.file.originalname.slice(dotIdx + 1) : 'bin'
        const storagePath = `projects/${project_id}/chat-attachments/${session.id}-${Date.now()}.${ext}`
        const storageUrl  = await uploadAttachment(req.file.buffer, storagePath, req.file.mimetype, 'forge-assets')
        const extracted   = await extractAttachText(req.file.buffer, req.file.mimetype)

        pendingAttachment = {
          file_name:       req.file.originalname,
          mime_type:       req.file.mimetype,
          file_size_bytes: req.file.size,
          storage_url:     storageUrl,
          extracted_text:  extracted || null,
        }
      } else if (attachment_url) {
        try {
          const urlObj = new URL(attachment_url)
          pendingAttachment = {
            file_name:       urlObj.hostname + (urlObj.pathname !== '/' ? urlObj.pathname : ''),
            mime_type:       'text/uri-list',
            file_size_bytes: null,
            storage_url:     attachment_url,
            extracted_text:  null,
          }
        } catch {
          return res.status(400).json({ success: false, error: 'Invalid URL provided' })
        }
      }
    }

    // Cargar historial persistido para construir contexto
    const { data: historyMsgs } = await db()
      .from('forge_messages')
      .select('role, content, order_index')
      .eq('session_id', session.id)
      .order('order_index')

    const nextIndex = (historyMsgs?.length ?? 0)

    const { getPrompt, getSkill } = require('../services/prompt.service')
    const { callLLM }   = require('../services/llm.service')
    const { logExecution } = require('../services/execution-log.service')

    // ── Obtener metadata del proyecto (Layer 2) ───────────────────
    const { data: project } = await db()
      .from('projects')
      .select('name, genre, studio_name, target_platform, team_scale, budget_range, timeline, context_notes')
      .eq('id', project_id)
      .maybeSingle()

    // ── Layer 1: node_dna ─────────────────────────────────────────
    // Sustituir variables de plantilla: [project] → nombre del juego, [prompt]/[seed] → input del usuario
    function injectVars(template, vars) {
      return template.replace(/\[(\w+)\]/g, (_, key) => vars[key] ?? `[${key}]`)
    }

    // Para skills: soporta claves con espacios ([Working Title]) y es case-insensitive
    // Cuando el valor no está disponible, sustituye con '' y limpia separadores huérfanos
    function injectSkillVars(template, vars) {
      let result = template.replace(/\[([^\]]+)\]/g, (match, key) => {
        const normalized = key.toLowerCase().replace(/\s+/g, '_')
        const value = vars[normalized] ?? vars[key]
        return (value != null && value !== '') ? value : ''
      })
      // Limpiar separadores (· o |) que quedaron huérfanos tras sustituciones vacías
      result = result.replace(/\s*·\s*·\s*/g, ' · ')
      result = result.replace(/^\s*·\s*/gm, '')
      result = result.replace(/\s*·\s*$/gm, '')
      return result
    }

    const templateVars = {
      project: project?.name ?? 'this game',
      prompt:  user_message.trim(),
      seed:    user_message.trim(),
    }

    // Variables extendidas para skills/templates — null si no está definido (no reemplazar con vacío)
    const skillVars = {
      ...templateVars,
      title:         project?.name             || null,
      working_title: project?.name             || null,
      game:          project?.name             || null,
      game_title:    project?.name             || null,
      studio:        project?.studio_name      || 'V57 Studio',
      studio_name:   project?.studio_name      || 'V57 Studio',
      genre:         project?.genre            || null,
      platform:      project?.target_platform  || null,
      team:          project?.team_scale       || null,
      budget:        project?.budget_range     || null,
      timeline:      project?.timeline         || null,
    }

    // Orden de preferencia: output.prompt > default_prompt > R2 fallback
    const r2Prompt = (!node.default_prompt && !targetOutput?.prompt) ? await getPrompt(node.node_key) : null

    let layer1 = targetOutput?.prompt
      ? injectVars(targetOutput.prompt, templateVars)
      : node.default_prompt
        ? injectVars(node.default_prompt, templateVars)
        : r2Prompt
          ? injectVars(r2Prompt, templateVars)
          : null

    if (!layer1) {
      // Componer desde DNA cuando no hay prompt explícito
      const outputsBlock = allOutputDefs.length
        ? allOutputDefs.map(o => {
            const label  = o.label || o.key
            const format = o.format || null
            const desc   = o.description || null
            return `- **${label}**${format ? ` (${format})` : ''}${desc ? ` — ${desc}` : ''}`
          }).join('\n')
        : ''

      layer1 = [
        `You are Forge Assistant, an expert AI for game design and development.`,
        `You are operating as the "${node.title}" node (phase: ${node.phase}).`,
        node.purpose     ? `\n## Purpose\n${node.purpose}`         : '',
        node.constraints ? `\n## Constraints\n${node.constraints}` : '',
        outputsBlock     ? `\n## Outputs to produce\nProduce each output as a separate section using the exact heading "## <output_key>":\n${outputsBlock}` : '',
        `\nFormat your response in markdown. Each output section must start with its exact key as a level-2 heading (## output_key).`,
      ].filter(Boolean).join('\n')
    }

    // Cargar skills desde R2: skills/{skill_key}.md
    const skillDefs  = Array.isArray(node.skills) ? node.skills : []
    const skillTexts = await Promise.all(skillDefs.map(s => getSkill(s)))
    const skillsBlock = skillDefs
      .map((s, i) => {
        if (!skillTexts[i]) return ''
        const filledText = injectSkillVars(skillTexts[i], skillVars)
        return `\n## Skill Reference: ${s}\n> This section is a GUIDE for your output structure. Do NOT reproduce these instructions verbatim in your response. Use the template to organize your content, but generate original text for each section.\n\n${filledText}`
      })
      .filter(Boolean).join('\n')

    // Incluir purpose + constraints + skills siempre (aunque haya default_prompt)
    const outputNames   = allOutputDefs.map(o => o.key).filter(Boolean)
    // Si el nodo tiene tools, el output lo produce la tool call — no inyectar instrucción de formato markdown
    const nodeHasTools  = Array.isArray(node.tools) && node.tools.length > 0

    // Instrucciones de formato por output según su campo "format"
    const FORMAT_HINTS = {
      structured:      'Output a FLAT numbered list ONLY — no subheadings, no category labels, no prose introduction. Each item MUST follow this exact format: `- Variation N: Name: brief description`\n  Example:\n  - Variation 1: The Archivist: An immersive sim set in a post-collapse archive city\n  - Variation 2: Backrooms Builder: Procedural architecture exploration game',
      markdown_table:  'MUST be a markdown table with header row and `|---|` separator row.\n  Example:\n  | Name | Score | Notes |\n  |------|-------|-------|\n  | Item A | 9/10 | reason |',
      single_sentence: 'Single sentence only — no markdown, no line breaks, no bullets.',
    }
    const outputFormatLines = allOutputDefs
      .filter(o => o.key && FORMAT_HINTS[o.format])
      .map(o => `- **${o.key}**: ${FORMAT_HINTS[o.format]}`)

    // En modo targetOutput solo pedir ese output específico
    const visibleOutputNames = targetOutput ? [targetOutput.key] : outputNames
    const formatInstr = visibleOutputNames.length && !nodeHasTools
      ? `\n## Output format\nStructure your response in markdown. Each output must be its own section with the exact level-2 heading "## <output_key>". Required sections: ${visibleOutputNames.map(n => `"## ${n}"`).join(', ')}.${outputFormatLines.length && !targetOutput ? '\n\nPer-section format requirements:\n' + outputFormatLines.join('\n') : ''}`
      : ''

    const layer1Extras = [
      node.purpose     && !layer1.includes(node.purpose)     ? `\n## Purpose\n${node.purpose}`         : '',
      node.constraints && !layer1.includes(node.constraints) ? `\n## Constraints\n${node.constraints}` : '',
      skillsBlock || '',
      formatInstr && !layer1.includes('## Output format')    ? formatInstr                              : '',
      // Modo standalone: incluir prompt de contexto y pregunta directa si aplica
      node.standalone_prompt ? `\n## Standalone mode\n${node.standalone_prompt}${directContext ? `\n\nIf the user hasn't provided context yet, ask them: "${directContext}"` : ''}` : '',
      // Modo output-focused: restringir respuesta al output seleccionado
      targetOutput ? `\n## Current target output\nYou are working specifically on: **${targetOutput.label}** (${targetOutput.key}).\nFocus your response on producing this output only — do not generate other outputs.` : '',
    ].filter(Boolean).join('\n')

    layer1 = layer1 + layer1Extras

    // ── Layer 2: project_context ──────────────────────────────────
    // Metadata del proyecto
    const projectMeta = [
      project?.name           ? `Game: ${project.name}`                : '',
      project?.genre          ? `Genre: ${project.genre}`              : '',
      project?.studio_name    ? `Studio: ${project.studio_name}`       : '',
      project?.target_platform? `Platform: ${project.target_platform}` : '',
      project?.team_scale     ? `Team: ${project.team_scale}`          : '',
      project?.budget_range   ? `Budget: ${project.budget_range}`      : '',
      project?.timeline       ? `Timeline: ${project.timeline}`        : '',
      project?.context_notes  ? `\n${project.context_notes}`           : '',
    ].filter(Boolean).join('\n')

    // Resolver inputs: edges (outputs de nodos upstream) + library assets asignados
    // Si se recibe explicit_project_node_id (instancia de lane), usar ese directamente
    let currentPNode = null
    if (explicit_project_node_id) {
      const { data: pnDirect } = await db()
        .from('forge_project_nodes')
        .select('id, bound_item_ref')
        .eq('id', explicit_project_node_id)
        .maybeSingle()
      currentPNode = pnDirect
    } else {
      const { data: pnByNode } = await db()
        .from('forge_project_nodes')
        .select('id, bound_item_ref')
        .eq('project_id', project_id)
        .eq('node_id', node_id)
        .eq('removed', false)
        .maybeSingle()
      currentPNode = pnByNode
    }

    let resolvedInputs = []
    const injectedPngUrls   = new Set() // evitar duplicados de PNG cuando hay múltiples edges del mismo nodo
    const seenSourceNodeIds = new Set() // evitar inyectar el mismo nodo upstream dos veces (múltiples edges)

    if (currentPNode) {
      // 1. Outputs de nodos conectados por edge
      let incomingEdges = []
      try {
        const { data: edgeData } = await db()
          .from('forge_project_edges')
          .select('source_node_id, source_handle')
          .eq('project_id', project_id)
          .eq('target_node_id', currentPNode.id)
        incomingEdges = edgeData || []
      } catch { /* tabla no migrada aún */ }

      for (const edge of incomingEdges) {
        if (seenSourceNodeIds.has(edge.source_node_id)) continue
        seenSourceNodeIds.add(edge.source_node_id)
        const { data: sourcePNode } = await db()
          .from('forge_project_nodes')
          .select(`
            node_id, node_type, source_asset_id,
            text_label, text_content,
            forge_nodes(title, outputs),
            forge_project_library_assets(display_name, extracted_text, storage_url, asset_type)
          `)
          .eq('id', edge.source_node_id)
          .maybeSingle()

        if (!sourcePNode) continue

        if ((sourcePNode.node_type || 'forge_node') === 'library_asset') {
          // Asset-node: usar datos del library asset directamente
          const lib = sourcePNode.forge_project_library_assets
          if (!lib) continue
          if (lib.extracted_text) {
            const snippet = lib.extracted_text.slice(0, 3000) + (lib.extracted_text.length > 3000 ? '\n[truncated]' : '')
            resolvedInputs.push(`### ${lib.display_name} (library asset)\n${snippet}`)
          } else if (lib.asset_type === 'image') {
            resolvedInputs.push(`### ${lib.display_name} (image reference)\nURL: ${lib.storage_url}`)
          }
        } else if (sourcePNode.node_type === 'text_input') {
          // Text-input node: texto libre escrito por el usuario en el canvas
          const label   = sourcePNode.text_label   || 'Text Input'
          const content = (sourcePNode.text_content || '').trim()
          if (content) resolvedInputs.push(`### ${label}\n${content}`)
        } else {
          // Forge-node: buscar output de texto aprobado o auto_approved (excluir PNG)
          const { data: asset } = await db()
            .from('forge_assets')
            .select('content, storage_url')
            .eq('project_id', project_id)
            .eq('node_id', sourcePNode.node_id)
            .in('status', ['approved', 'auto_approved'])
            .neq('format', 'png')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (asset?.content) {
            const nodeTitle  = sourcePNode.forge_nodes?.title ?? 'Upstream node'
            const outputs    = sourcePNode.forge_nodes?.outputs ?? []
            let   content    = asset.content
            let   slotLabel  = nodeTitle

            // Si el edge apunta a un output slot específico, extraer solo esa sección
            const srcHandle = edge.source_handle
            if (srcHandle?.startsWith('out-')) {
              const handleVal = srcHandle.slice(4) // "out-concept_seeds" → "concept_seeds"
              // Buscar por key (v1.3.0) o name (legacy) o por índice
              const outputDef = outputs.find(o => (o.key || o.name) === handleVal)
                ?? outputs[parseInt(handleVal, 10)]
              if (outputDef) {
                const sectionKey = outputDef.key || outputDef.name
                const extracted  = sectionKey ? extractSection(content, sectionKey) : null
                if (extracted) {
                  content   = extracted
                  slotLabel = `${nodeTitle} → ${outputDef.label || sectionKey}`
                }
              }
            }

            const snippet = content.slice(0, 3000) + (content.length > 3000 ? '\n[truncated]' : '')
            resolvedInputs.push(`### ${slotLabel}\n${snippet}`)
          }

          // Inyectar imágenes PNG aprobadas o auto_approved del nodo upstream
          const { data: pngAssets } = await db()
            .from('forge_assets')
            .select('name, storage_url')
            .eq('project_id', project_id)
            .eq('node_id', sourcePNode.node_id)
            .in('status', ['approved', 'auto_approved'])
            .eq('format', 'png')
            .not('storage_url', 'is', null)

          for (const png of (pngAssets || [])) {
            if (png.storage_url && !injectedPngUrls.has(png.storage_url)) {
              injectedPngUrls.add(png.storage_url)
              resolvedInputs.push(`### ${png.name} (generated image)\nURL: ${png.storage_url}`)
            }
          }

          // Fallback: si no hay PNGs en forge_assets, leer output_images de la sesión aprobada
          // (cubre casos donde el accept fue anterior al fix del formato variations[])
          if ((pngAssets || []).length === 0) {
            const { data: approvedSession } = await db()
              .from('forge_sessions')
              .select('output_images, forge_nodes(title, outputs)')
              .eq('project_id', project_id)
              .eq('node_id', sourcePNode.node_id)
              .eq('status', 'approved')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()

            if (approvedSession?.output_images) {
              const nodeTitle2  = approvedSession.forge_nodes?.title ?? nodeTitle ?? 'Node'
              const pngOutputs  = (approvedSession.forge_nodes?.outputs || [])
                .filter(o => (o.format === 'png' || o.format === 'image') && o.image_gen)
              const raw = approvedSession.output_images

              for (const outDef of pngOutputs) {
                const items = Array.isArray(raw[outDef.name]) ? raw[outDef.name] : []
                for (const item of items) {
                  const urls = Array.isArray(item.variations)
                    ? item.variations.map(v => v.url).filter(Boolean)
                    : item.image_url ? [item.image_url] : []
                  for (const url of urls) {
                    if (!injectedPngUrls.has(url)) {
                      injectedPngUrls.add(url)
                      resolvedInputs.push(`### ${nodeTitle2} — ${outDef.name} (generated image)\nURL: ${url}`)
                    }
                  }
                }
              }
            }
          }
        }
      }

      // 2. Library assets asignados explícitamente
      const { data: libInputs } = await db()
        .from('forge_project_node_inputs')
        .select(`
          input_label,
          forge_project_library_assets ( display_name, extracted_text, storage_url, asset_type )
        `)
        .eq('project_node_id', currentPNode.id)
        .eq('source_type', 'library_asset')
        .order('order_index')

      for (const inp of (libInputs || [])) {
        const lib = inp.forge_project_library_assets
        if (!lib) continue
        if (lib.extracted_text) {
          const snippet = lib.extracted_text.slice(0, 3000) + (lib.extracted_text.length > 3000 ? '\n[truncated]' : '')
          resolvedInputs.push(`### ${lib.display_name} (external reference)\n${snippet}`)
        } else if (lib.asset_type === 'image') {
          resolvedInputs.push(`### ${lib.display_name} (image reference)\nURL: ${lib.storage_url}`)
        }
      }
    }

    // Inyectar bound_item_ref al inicio de inputs si el nodo es una instancia de lane
    // bound_item_ref es JSONB — formatear a texto legible para el LLM
    if (currentPNode?.bound_item_ref) {
      const ref = currentPNode.bound_item_ref
      const refText = (typeof ref === 'object' && ref !== null)
        ? Object.entries(ref)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .map(([k, v]) => `**${k}:** ${v}`)
            .join('\n')
        : String(ref)
      resolvedInputs.unshift(`### Bound item (this lane)\n${refText}`)
    }

    // Outputs existentes de este mismo nodo (para modo output-focused y standalone)
    const existingNodeOutputs = []
    if (allOutputDefs.length) {
      const { data: siblingAssets } = await db()
        .from('forge_assets')
        .select('name, content')
        .eq('project_id', project_id)
        .eq('node_id', node_id)
        .in('status', ['approved', 'auto_approved'])
        .neq('format', 'png')
        .order('created_at', { ascending: false })

      for (const asset of (siblingAssets || [])) {
        if (asset.name === target_output_key) continue  // excluir el output objetivo
        const snippet = (asset.content || '').slice(0, 2000)
        if (snippet) existingNodeOutputs.push(`### ${asset.name}\n${snippet}`)
      }
    }

    const layer2Parts = [
      projectMeta             ? `## Project context\n${projectMeta}`                                    : '',
      resolvedInputs.length   ? `## Input references\n${resolvedInputs.join('\n\n')}`                   : '',
      existingNodeOutputs.length ? `## Existing outputs from this node\n${existingNodeOutputs.join('\n\n')}` : '',
    ].filter(Boolean)

    // ── Ensamblar system prompt ───────────────────────────────────
    const { getToolsBlock, parseToolCalls, executeTool } = require('../services/tools.service')

    const activeTools = Array.isArray(node.tools) && node.tools.length ? node.tools : []
    // doc_gen_docx se ejecuta automáticamente — no exponerla al LLM para evitar alucinaciones
    // doc_gen_pptx sí se expone: el modelo es responsable de llamarla con contenido + imágenes
    const llmVisibleTools = activeTools.filter(t => t !== 'doc_gen_docx')
    const toolsBlock      = getToolsBlock(llmVisibleTools)

    const systemPrompt = [layer1, ...layer2Parts, toolsBlock].filter(Boolean).join('\n\n')

    // ── Layer 3: session attachments (Reference Injection) ────────
    const { data: sessionAttachments } = await db()
      .from('forge_attachments')
      .select('file_name, mime_type, storage_url, extracted_text')
      .eq('session_id', session.id)
      .order('created_at')

    const attachmentParts = [
      ...(sessionAttachments || []).map(att =>
        att.extracted_text
          ? `### ${att.file_name}\n${att.extracted_text.slice(0, 3000)}${att.extracted_text.length > 3000 ? '\n[truncated]' : ''}`
          : `### ${att.file_name}\nURL: ${att.storage_url}`
      ),
      ...(pendingAttachment ? [
        pendingAttachment.extracted_text
          ? `### ${pendingAttachment.file_name}\n${pendingAttachment.extracted_text.slice(0, 3000)}${pendingAttachment.extracted_text.length > 3000 ? '\n[truncated]' : ''}`
          : `### ${pendingAttachment.file_name}\nURL: ${pendingAttachment.storage_url}`
      ] : []),
    ]

    const finalSystemPrompt = attachmentParts.length
      ? systemPrompt + '\n\n## Attached references\n' + attachmentParts.join('\n\n')
      : systemPrompt

    // Historial como texto plano para el LLM
    const historyText = (historyMsgs || [])
      .map(m => `${m.role === 'human' ? 'Human' : 'Agent'}: ${m.content}`)
      .join('\n\n')

    const baseUserMsg = [
      historyText ? `Previous conversation:\n${historyText}` : '',
      `Human: ${user_message.trim()}`,
    ].filter(Boolean).join('\n\n')

    // Resolver modelo desde executor del nodo; fallback a DEFAULT_MODEL
    // executor.model ya tiene el formato correcto provider:model (ej: minimax:MiniMax-M2.7)
    // executor.type indica el tipo de ejecutor (llm, hybrid, comfyui...) — no es el provider
    const executorStr = node.executor?.model || process.env.DEFAULT_MODEL

    const toolsList  = activeTools.length                                  ? activeTools.join(', ') : null
    const skillsList = Array.isArray(node.skills) && node.skills.length ? node.skills.join(', ')  : null

    console.log('\n─── [forge-chat] LLM call ───────────────────────────')
    console.log(`  node:         ${node.node_key} — ${node.title}`)
    console.log(`  model:        ${executorStr}`)
    console.log(`  prompt src:   ${targetOutput?.prompt ? `output:${targetOutput.key}` : node.default_prompt ? 'default_prompt' : r2Prompt ? 'R2' : 'DNA composed'}${targetOutput ? ` [target: ${targetOutput.key}]` : ''}`)
    console.log(`  project:      ${project?.name ?? '(sin nombre)'}`)
    console.log(`  tools:        ${toolsList ?? '(none)'}`)
    console.log(`  skills:       ${skillsList ?? '(none)'}`)
    console.log(`  inputs:       ${resolvedInputs.length} referencia(s) — ${resolvedInputs.length ? resolvedInputs.map(d => d.split('\n')[0].replace('### ', '')).join(', ') : '(none)'}`)
    console.log(`  attachments:  ${attachmentParts.length} adjunto(s) en sesión`)
    console.log(`  system prompt (${finalSystemPrompt.length} chars):\n${finalSystemPrompt}`)

    console.log(`  history msgs: ${historyMsgs?.length ?? 0}`)
    console.log(`  user message: ${user_message.trim().slice(0, 120)}${user_message.length > 120 ? '…' : ''}`)
    console.log('─────────────────────────────────────────────────────\n')

    // ── ReAct loop — ejecuta hasta que el LLM no emita más tool_calls ────────
    const MAX_TOOL_ITERS  = 5
    let   currentUserMsg  = baseUserMsg
    let   replyText       = ''
    let   allToolCalls    = []    // historial de calls para persistir
    let   meta            = null
    let   docUrl          = null
    let   docFormat       = null

    for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
      const result = await callLLM(finalSystemPrompt, currentUserMsg, {
        model:           executorStr,
        rawText:         true,
        temperature:     0.7,
        maxOutputTokens: 8192,
      })

      meta      = result.meta
      replyText = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)

      const calls = activeTools.length ? parseToolCalls(replyText) : []
      if (!calls.length) break   // sin tool calls → terminado

      console.log(`[forge-chat] tool calls iter=${iter + 1}:`, calls.map(c => c.tool))

      // Extraer URLs reales de imágenes del contexto (para resolver nombres en doc_gen_pptx)
      const contextPngUrls = resolvedInputs
        .filter(s => s.includes('(generated image)'))
        .map(s => { const m = s.match(/URL:\s*(https?:\/\/\S+)/); return m ? m[1] : null })
        .filter(Boolean)

      // Ejecutar cada tool y acumular resultados
      const toolResultParts = []
      for (const tc of calls) {
        // Reemplazar nombres de imagen con URLs reales cuando el LLM pasa keys en vez de URLs
        if (tc.tool === 'doc_gen_pptx' && Array.isArray(tc.args?.images) && contextPngUrls.length > 0) {
          const hasNonUrls = tc.args.images.some(img => !img.startsWith('http'))
          if (hasNonUrls) tc.args.images = contextPngUrls
        }

        const toolResult = await executeTool(tc.tool, tc.args, { project_id, node_id })
        allToolCalls.push({ ...tc, result: toolResult })

        // Capturar URL de documentos generados para devolverla al frontend
        let resultText = JSON.stringify(toolResult, null, 2)
        if ((tc.tool === 'doc_gen_docx' || tc.tool === 'doc_gen_pptx') && toolResult.success && toolResult.url) {
          docUrl     = toolResult.url
          docFormat  = toolResult.format || (tc.tool === 'doc_gen_pptx' ? 'pptx' : 'pdf')
          resultText = `File generated successfully.\nFilename: ${toolResult.filename}\nDownload URL: ${toolResult.url}\n\nTell the user the file is ready. Do NOT reproduce the slide content again.`
        }

        toolResultParts.push(`<tool_result tool="${tc.tool}">\n${resultText}\n</tool_result>`)
      }

      // Extender el contexto con la respuesta parcial + resultados para el próximo iter
      currentUserMsg = currentUserMsg
        + `\n\nAgent: ${replyText}\n\n${toolResultParts.join('\n\n')}\n\nContinue your response using the tool results above.`
    }

    // Registrar costo y performance del llamado LLM (no bloqueante, nunca rompe el flujo)
    try {
      logExecution({
        project_id:   project_id,
        node_id:      node_id,
        session_id:   session.id,
        triggered_by: member_id || null,
        trigger_type: 'chat',
        executor_type:'llm',
        provider:     meta?.provider    || null,
        model:        meta?.model       || null,
        tokens:       meta?.tokens_used || null,
        duration_ms:  meta?.duration_ms || null,
        started_at:   new Date(Date.now() - (meta?.duration_ms || 0)).toISOString(),
        status:       'success',
        metadata:     { node_key: node.node_key, iter_count: allToolCalls.length > 0 ? undefined : 1 },
      })
    } catch (logErr) {
      console.error('[forge-chat] logExecution failed (non-fatal):', logErr.message)
    }

    // Eliminar párrafo de disclaimer cuando un tool falla y el LLM lo anuncia
    // (ej: "Web search is unavailable — I'll work from my training knowledge...")
    // Estrategia: si el primer párrafo (hasta \n\n o primer heading) contiene las keywords, eliminarlo
    {
      const DISCLAIMER_RE = /web search is (?:unavailable|not (?:available|configured))|training knowledge|not have (?:access to|real-?time)|cannot (?:access|perform) (?:web|internet) search/i
      const firstBreak = replyText.search(/\n\n|\n(?=#)/)
      if (firstBreak > 0) {
        const firstPara = replyText.slice(0, firstBreak)
        if (DISCLAIMER_RE.test(firstPara)) {
          replyText = replyText.slice(firstBreak).trimStart()
        }
      }
    }

    // Normalizar secciones estructuradas — independiente de cómo las formateó el LLM
    replyText = normalizeOutputSections(replyText, allOutputDefs)

    // Si el nodo tiene doc_gen_docx y el LLM no la llamó por su cuenta, generar automáticamente
    const hasDocTool   = activeTools.includes('doc_gen_docx')
    const alreadyCalled = allToolCalls.some(tc => tc.tool === 'doc_gen_docx')

    if (hasDocTool && !alreadyCalled && replyText.trim().length > 200) {
      try {
        // Extraer solo la sección del output principal (format: document/pdf)
        // para no incluir outputs secundarios (light_pitches, etc.) en el PDF
        let docContent = replyText
        const docOutputDef = allOutputDefs.find(o => {
          const fmt = typeof o === 'object' ? (o.format ?? '') : ''
          return ['document', 'pdf', 'doc'].includes(fmt.toLowerCase())
        }) || allOutputDefs[0]

        if (docOutputDef) {
          const outName        = typeof docOutputDef === 'object' ? docOutputDef.name : docOutputDef
          const secondaryDefs  = allOutputDefs.filter(o => o !== docOutputDef)

          // Estrategia: localizar dónde empieza la primera sección SECUNDARIA y cortar ahí.
          // Más robusto que extraer la primaria, porque el LLM suele renombrar su heading
          // (e.g. "## High Level Concept" en vez de "## pitch_document") mientras que
          // los headings de secciones secundarias sí coinciden con variantes humanizadas.
          let cutIndex = -1
          for (const secDef of secondaryDefs) {
            const secName = typeof secDef === 'object' ? secDef.name : secDef
            const variants = [
              secName,
              secName.replace(/_/g, ' '),
              secName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            ]
            for (const variant of variants) {
              const esc   = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              const secRx = new RegExp(`^##\\s+${esc}\\s*$`, 'im')
              const m     = secRx.exec(replyText)
              if (m && m.index > 100) {
                if (cutIndex < 0 || m.index < cutIndex) cutIndex = m.index
                break
              }
            }
          }

          if (cutIndex > 100) {
            let primaryContent = replyText.slice(0, cutIndex).trim()

            // Afinar: el output primario para el PDF siempre es la PRIMERA sección H2.
            // Si hay más de un ## heading en primaryContent, cortar en el segundo —
            // las secciones extra (high_level_concept, etc.) quedan excluidas.
            const allH2 = [...primaryContent.matchAll(/^##\s+.+$/gim)]
            if (allH2.length > 1 && allH2[1].index > 100) {
              primaryContent = primaryContent.slice(0, allH2[1].index).trim()
              console.log(`[forge-chat] doc_gen_docx — refinado al primer H2 (${primaryContent.length} chars)`)
            }

            docContent = primaryContent
            console.log(`[forge-chat] auto doc_gen_docx — cortado antes de sección secundaria (${docContent.length} chars)`)
          } else {
            // Fallback: extracción exacta de la sección primaria
            const extracted = extractSection(replyText, outName)
            if (extracted && extracted.length > 100) {
              docContent = extracted
              console.log(`[forge-chat] auto doc_gen_docx — usando sección "${outName}" (${extracted.length} chars)`)
            }
          }
        }

        // Post-process: el LLM a veces reproduce placeholders literalmente en el output
        const studioVal = project?.studio_name || 'V57 Studio'
        const titleVal  = project?.name        || ''
        docContent = docContent
          .replace(/\[Studio(?:\s+Name)?\]/gi, studioVal)
          .replace(/\[Working\s+Title\]/gi,    titleVal)
          .replace(/\[Game\s+Title\]/gi,        titleVal)
        if (titleVal) {
          // "Working Title" literal en subtítulos — siempre placeholder
          docContent = docContent.replace(/\bWorking Title\b/g, titleVal)
        }
        // Limpiar separadores huérfanos que pudieran haber quedado
        docContent = docContent
          .replace(/\s*·\s{2,}·\s*/g, ' · ')
          .replace(/^\s*·\s+/gm, '')
          .replace(/\s+·\s*$/gm, '')

        const docResult = await executeTool('doc_gen_docx', {
          title:   `${node.title} — ${project?.name ?? 'Document'}`,
          content: docContent,
        }, { project_id, node_id })

        if (docResult.success && docResult.url) {
          docUrl    = docResult.url
          docFormat = 'pdf'
          allToolCalls.push({ tool: 'doc_gen_docx', args: { auto: true }, result: docResult })
          // No embebemos el link en replyText — el frontend lo maneja via doc_url
        }
      } catch (docErr) {
        console.error('[forge-chat] auto doc_gen_docx failed:', docErr.message)
      }
    }

    // Auto-generar PPTX si el nodo tiene doc_gen_pptx y el LLM produjo contenido
    const hasPptxTool     = activeTools.includes('doc_gen_pptx')
    const pptxAlreadyCalled = allToolCalls.some(tc => tc.tool === 'doc_gen_pptx')

    if (hasPptxTool && !pptxAlreadyCalled && replyText.trim().length > 200) {
      try {
        // Extraer URLs de imágenes PNG inyectadas desde nodos upstream
        const pngImageUrls = resolvedInputs
          .filter(s => s.includes('(generated image)'))
          .map(s => { const m = s.match(/URL:\s*(https?:\/\/\S+)/); return m ? m[1] : null })
          .filter(Boolean)

        const pptxResult = await executeTool('doc_gen_pptx', {
          title:   `${node.title} — ${project?.name ?? 'Presentation'}`,
          content: replyText,
          images:  pngImageUrls,
        }, { project_id, node_id })

        if (pptxResult.success && pptxResult.url) {
          docUrl    = pptxResult.url
          docFormat = 'pptx'
          allToolCalls.push({ tool: 'doc_gen_pptx', args: { auto: true }, result: pptxResult })
          console.log(`[forge-chat] auto doc_gen_pptx — ${pngImageUrls.length} images, url: ${pptxResult.url}`)
        }
      } catch (pptxErr) {
        console.error('[forge-chat] auto doc_gen_pptx failed:', pptxErr.message)
      }
    }

    // Persistir mensajes — humano primero para obtener su ID (requerido por forge_attachments)
    const agentRecord = {
      session_id:  session.id,
      role:        'agent',
      content:     replyText,
      order_index: nextIndex + 1,
      tool_calls:  allToolCalls.length ? allToolCalls : [],
    }

    const { data: humanMsg, error: humanInsertErr } = await db()
      .from('forge_messages')
      .insert({ session_id: session.id, role: 'human', content: user_message.trim(), order_index: nextIndex, tool_calls: [] })
      .select('id')
      .single()

    if (humanInsertErr) {
      console.error('[forge-chat] forge_messages insert error:', humanInsertErr)
      throw new Error(`Failed to save messages: ${humanInsertErr.message}`)
    }

    if (pendingAttachment && humanMsg) {
      const { error: attErr } = await db()
        .from('forge_attachments')
        .insert({
          message_id:      humanMsg.id,
          session_id:      session.id,
          file_name:       pendingAttachment.file_name,
          mime_type:       pendingAttachment.mime_type,
          file_size_bytes: pendingAttachment.file_size_bytes,
          storage_url:     pendingAttachment.storage_url,
          extracted_text:  pendingAttachment.extracted_text,
        })
      if (attErr) console.error('[forge-chat] forge_attachments insert error:', attErr)
    }

    const { error: agentInsertErr } = await db()
      .from('forge_messages')
      .insert(agentRecord)

    if (agentInsertErr) {
      console.error('[forge-chat] forge_messages agent insert error:', agentInsertErr)
      throw new Error(`Failed to save agent message: ${agentInsertErr.message}`)
    }

    // Incrementar contador de iteraciones
    await db()
      .from('forge_sessions')
      .update({ iteration_count: session.iteration_count + 1 })
      .eq('id', session.id)

    res.json({
      success:    true,
      reply:      replyText,
      session_id: session.id,
      meta,
      doc_url:    docUrl    ?? undefined,
      doc_format: docFormat ?? undefined,
      attachment: pendingAttachment ? {
        file_name:       pendingAttachment.file_name,
        mime_type:       pendingAttachment.mime_type,
        file_size_bytes: pendingAttachment.file_size_bytes,
        storage_url:     pendingAttachment.storage_url,
      } : undefined,
    })
  } catch (err) { next(err) }
})

// ─── GET /api/projects/:id/canvas/nodes-catalog ──────────────
// Lista todos los nodos activos disponibles para agregar al canvas
router.get('/nodes-catalog', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('forge_nodes')
      .select('id, node_key, title, phase, purpose, executor')
      .eq('status', 'active')
      .order('phase')
      .order('node_key')

    if (error) throw error
    res.json({ success: true, nodes: data })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/add-node ──────────────────
// Agrega un nodo individual al canvas del proyecto
router.post('/add-node', async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    const { node_id } = req.body

    if (!node_id) {
      return res.status(400).json({ success: false, error: 'node_id es requerido' })
    }

    // Buscar blueprint activo y su node_sequence — fuente de verdad para orden y membresía
    let activeBlueprintId = null
    let blueprintSequence = []
    const { data: activeBp } = await db()
      .from('forge_project_blueprints')
      .select('blueprint_id')
      .eq('project_id', project_id)
      .order('loaded_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (activeBp?.blueprint_id) {
      const { data: bp } = await db()
        .from('forge_blueprints')
        .select('node_sequence')
        .eq('id', activeBp.blueprint_id)
        .single()
      blueprintSequence = bp?.node_sequence || []
      // El nodo pertenece al blueprint si está en node_sequence
      if (blueprintSequence.some(s => s.node_id === node_id)) {
        activeBlueprintId = activeBp.blueprint_id
      }
    }

    console.log('[add-node] node_id:', node_id, 'activeBlueprintId:', activeBlueprintId, 'seqLen:', blueprintSequence.length)

    // Verificar que no esté ya en canvas
    const { data: existing } = await db()
      .from('forge_project_nodes')
      .select('id')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .maybeSingle()

    if (existing) {
      return res.status(409).json({ success: false, error: 'Node already in canvas' })
    }

    // Calcular el próximo order_index
    const { data: maxOrder } = await db()
      .from('forge_project_nodes')
      .select('order_index')
      .eq('project_id', project_id)
      .order('order_index', { ascending: false })
      .limit(1)
      .maybeSingle()

    const order_index = (maxOrder?.order_index ?? -1) + 1

    const { data, error } = await db()
      .from('forge_project_nodes')
      .insert({ project_id, node_id, order_index, blueprint_id: activeBlueprintId })
      .select()
      .single()

    if (error) throw error

    // Re-numerar nodos del blueprint para que autoWire ubique correctamente el nodo re-agregado
    if (activeBlueprintId && blueprintSequence.length > 0) {
      const { data: bpProjectNodes } = await db()
        .from('forge_project_nodes')
        .select('id, node_id, order_index')
        .eq('project_id', project_id)
        .eq('blueprint_id', activeBlueprintId)
        .or('removed.is.null,removed.eq.false')
        .order('order_index', { ascending: true })

      console.log('[add-node] bpProjectNodes:', JSON.stringify(bpProjectNodes?.map(n => ({ node_id: n.node_id, order_index: n.order_index }))))

      if (bpProjectNodes && bpProjectNodes.length > 0) {
        const baseIdx = bpProjectNodes[0].order_index
        const seqMap = new Map(blueprintSequence.map((s, i) => [s.node_id, i]))
        const sorted = [...bpProjectNodes].sort(
          (a, b) => (seqMap.get(a.node_id) ?? 999) - (seqMap.get(b.node_id) ?? 999)
        )
        console.log('[add-node] re-indexing, sorted order:', sorted.map((n, i) => `${n.node_id}→${baseIdx + i}`))
        for (let i = 0; i < sorted.length; i++) {
          await db()
            .from('forge_project_nodes')
            .update({ order_index: baseIdx + i })
            .eq('id', sorted[i].id)
        }
      }
    }

    // Limpiar edges auto-wired para recalcular óptimos con el nuevo nodo en el canvas
    await db().from('forge_project_edges').delete().eq('project_id', project_id).eq('is_auto', true)
    try {
      const wired = await autoWire(project_id, db)
      console.log('[add-node] autoWire created', wired, 'edges')
    } catch (e) { console.error('[add-node] auto-wire failed:', e.message) }
    res.json({ success: true, project_node: data })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/add-asset-node ────────────
// Agrega un library asset como nodo en el canvas del proyecto
router.post('/add-asset-node', async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    const { asset_id } = req.body

    if (!asset_id) {
      return res.status(400).json({ success: false, error: 'asset_id es requerido' })
    }

    const { data: asset, error: assetErr } = await db()
      .from('forge_project_library_assets')
      .select('id')
      .eq('id', asset_id)
      .eq('project_id', project_id)
      .maybeSingle()

    if (assetErr || !asset) {
      return res.status(404).json({ success: false, error: 'Asset not found in project library' })
    }

    // Si ya existe (incluso removido) restaurarlo
    const { data: existing } = await db()
      .from('forge_project_nodes')
      .select('id, removed')
      .eq('project_id', project_id)
      .eq('source_asset_id', asset_id)
      .maybeSingle()

    if (existing && !existing.removed) {
      // Devolver el nodo existente — el frontend puede crear el edge igualmente
      return res.json({ success: true, project_node: existing, already_exists: true })
    }

    if (existing?.removed) {
      const { data, error } = await db()
        .from('forge_project_nodes')
        .update({ removed: false, removed_at: null })
        .eq('id', existing.id)
        .select()
        .single()
      if (error) throw error
      try { await autoWire(project_id, db) } catch (e) { console.error('[add-asset-node] auto-wire failed:', e.message) }
      return res.json({ success: true, project_node: data })
    }

    const { data, error } = await db()
      .from('forge_project_nodes')
      .insert({ project_id, node_type: 'library_asset', source_asset_id: asset_id, node_id: null })
      .select()
      .single()

    if (error) throw error
    try { await autoWire(project_id, db) } catch (e) { console.error('[add-asset-node] auto-wire failed:', e.message) }
    res.json({ success: true, project_node: data })
  } catch (err) { next(err) }
})

// ─── GET /api/projects/:id/canvas/blueprints ─────────────────
// Devuelve blueprints disponibles para cargar (sin requireAdmin)
router.get('/blueprints', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('forge_blueprints')
      .select('id, blueprint_key, name, phase')
      .order('phase')
      .order('name')

    if (error) throw error
    res.json({ success: true, blueprints: data })
  } catch (err) { next(err) }
})

// ─── PUT /api/projects/:id/canvas/edges ──────────────────────────────────────
// Reemplaza todos los edges del canvas del proyecto (fuente de verdad en DB)
router.put('/edges', async (req, res) => {
  const { id: project_id } = req.params
  const { edges } = req.body

  try {
    // Solo edges reales nodo→nodo: descartar virtuales de lane ("lane-<uuid>") y
    // cualquier id que no sea uuid válido. Evita borrar todo y fallar al insertar basura.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const cleanEdges = (Array.isArray(edges) ? edges : []).filter(
      e => UUID_RE.test(e?.source ?? '') && UUID_RE.test(e?.target ?? '')
    )

    const { error: delError } = await db()
      .from('forge_project_edges')
      .delete()
      .eq('project_id', project_id)

    if (delError) {
      console.warn('[forge-canvas] PUT /edges delete failed:', delError.message)
      return res.json({ success: true, pending_migration: true })
    }

    if (cleanEdges.length > 0) {
      const rows = cleanEdges.map(e => ({
        project_id,
        source_node_id: e.source,
        target_node_id: e.target,
        source_handle:  e.sourceHandle ?? null,
        target_handle:  e.targetHandle ?? null,
      }))
      const { error: insError } = await db().from('forge_project_edges').insert(rows)
      if (insError) {
        console.error('[forge-canvas] PUT /edges insert failed:', insError.message, '| rows:', JSON.stringify(rows))
        // Fallback: intentar sin handles (migración 013 puede no haberse corrido)
        const rowsBasic = cleanEdges.map(e => ({ project_id, source_node_id: e.source, target_node_id: e.target }))
        const { error: insError2 } = await db().from('forge_project_edges').insert(rowsBasic)
        if (insError2) {
          console.error('[forge-canvas] PUT /edges fallback also failed:', insError2.message)
          return res.status(500).json({ success: false, error: insError2.message })
        }
      }
    }

    res.json({ success: true })
  } catch (err) {
    console.error('[forge-canvas] PUT /edges unexpected error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─── GET /api/projects/:id/canvas/all-inputs ─────────────────────────────────
// Devuelve todos los inputs de todos los nodos del proyecto en un solo request
router.get('/all-inputs', async (req, res, next) => {
  try {
    const { id: project_id } = req.params

    const { data, error } = await db()
      .from('forge_project_node_inputs')
      .select(`
        id, project_node_id, input_key, input_label, is_required, source_type, order_index,
        source_node_id,
        source_asset_id,
        forge_project_library_assets ( id, display_name, file_name, mime_type, asset_type )
      `)
      .eq('project_id', project_id)
      .order('order_index')

    if (error) throw error
    res.json({ success: true, inputs: data })
  } catch (err) { next(err) }
})

// ─── GET /api/projects/:id/canvas/nodes/:project_node_id/inputs ──────────────
// Devuelve los inputs asignados a un nodo del proyecto
router.get('/nodes/:project_node_id/inputs', async (req, res, next) => {
  try {
    const { project_node_id } = req.params

    const { data, error } = await db()
      .from('forge_project_node_inputs')
      .select(`
        id, input_key, input_label, is_required, source_type, order_index,
        source_node_id,
        source_asset_id,
        forge_project_library_assets ( id, display_name, file_name, mime_type, asset_type )
      `)
      .eq('project_node_id', project_node_id)
      .order('order_index')

    if (error) throw error
    res.json({ success: true, inputs: data })
  } catch (err) { next(err) }
})

// ─── GET /api/projects/:id/canvas/nodes/:project_node_id/context-inputs ──────
// Devuelve los inputs resueltos de un nodo para el panel de contexto del chat.
// Solo se llama para nodos gate — misma lógica de resolución que el chat, sin llamar al LLM.
router.get('/nodes/:project_node_id/context-inputs', async (req, res, next) => {
  try {
    const { id: project_id, project_node_id } = req.params

    const { data: pNode, error: pnErr } = await db()
      .from('forge_project_nodes')
      .select('id, bound_item_ref')
      .eq('id', project_node_id)
      .maybeSingle()
    if (pnErr) throw pnErr
    if (!pNode) return res.json({ success: true, inputs: [] })

    const inputs = []
    const injectedPngUrls = new Set()

    // 1. Bound item del lane (va primero — es el contexto más específico)
    if (pNode.bound_item_ref) {
      const ref = pNode.bound_item_ref
      const content = (typeof ref === 'object' && ref !== null)
        ? Object.entries(ref)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .map(([k, v]) => `**${k}:** ${v}`)
            .join('\n')
        : String(ref)
      const rawLabel = (typeof ref === 'object' && ref !== null)
        ? (ref.title || ref.label || 'Lane item')
        : String(ref).slice(0, 40)
      inputs.push({ label: String(rawLabel), content, source: 'lane' })
    }

    // 2. Edges entrantes (outputs de nodos upstream conectados por edge)
    let incomingEdges = []
    try {
      const { data: edgeData } = await db()
        .from('forge_project_edges')
        .select('source_node_id, source_handle')
        .eq('project_id', project_id)
        .eq('target_node_id', pNode.id)
      incomingEdges = edgeData || []
    } catch { /* tabla no migrada aún */ }

    // Un entry por nodo fuente — si hay múltiples edges del mismo origen, solo el primero
    const seenSourceNodes = new Set()

    for (const edge of incomingEdges) {
      if (seenSourceNodes.has(edge.source_node_id)) continue
      seenSourceNodes.add(edge.source_node_id)
      const { data: srcPN } = await db()
        .from('forge_project_nodes')
        .select(`
          node_id, node_type, text_label, text_content,
          forge_nodes(title, outputs),
          forge_project_library_assets(display_name, extracted_text, storage_url, asset_type)
        `)
        .eq('id', edge.source_node_id)
        .maybeSingle()
      if (!srcPN) continue

      if ((srcPN.node_type || 'forge_node') === 'library_asset') {
        const lib = srcPN.forge_project_library_assets
        if (!lib) continue
        if (lib.extracted_text) {
          inputs.push({ label: lib.display_name, content: lib.extracted_text, source: 'edge', source_project_node_id: edge.source_node_id, output_key: null })
        } else if (lib.asset_type === 'image') {
          inputs.push({ label: lib.display_name, content: `![${lib.display_name}](${lib.storage_url})`, source: 'edge', isImage: true, source_project_node_id: edge.source_node_id, output_key: null })
        }
      } else if (srcPN.node_type === 'text_input') {
        const content = (srcPN.text_content || '').trim()
        if (content) inputs.push({ label: srcPN.text_label || 'Text Input', content, source: 'edge', source_project_node_id: edge.source_node_id, output_key: null })
      } else {
        // Forge-node: buscar asset aprobado
        const { data: asset } = await db()
          .from('forge_assets')
          .select('content')
          .eq('project_id', project_id)
          .eq('node_id', srcPN.node_id)
          .in('status', ['approved', 'auto_approved'])
          .neq('format', 'png')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (asset?.content) {
          const nodeTitle = srcPN.forge_nodes?.title ?? 'Node'
          const outputs   = srcPN.forge_nodes?.outputs ?? []
          let content = asset.content
          let label   = nodeTitle
          let outputKey = null

          const srcHandle = edge.source_handle
          if (srcHandle?.startsWith('out-')) {
            const handleVal = srcHandle.slice(4)
            const outDef = outputs.find(o => o.key === handleVal || o.name === handleVal)
              ?? outputs[parseInt(handleVal, 10)]
            if (outDef) {
              outputKey = outDef.key || outDef.name || null
              const extracted = outputKey ? extractSection(content, outputKey) : null
              if (extracted) {
                content = extracted
                label   = `${nodeTitle} — ${outDef.label || outputKey}`
              }
            }
          }

          inputs.push({
            label, content, source: 'edge',
            source_project_node_id: edge.source_node_id,
            output_key: outputKey,
          })
        }

        // PNGs aprobados del nodo upstream
        const { data: pngAssets } = await db()
          .from('forge_assets')
          .select('name, storage_url')
          .eq('project_id', project_id)
          .eq('node_id', srcPN.node_id)
          .in('status', ['approved', 'auto_approved'])
          .eq('format', 'png')
          .not('storage_url', 'is', null)

        for (const png of (pngAssets || [])) {
          if (png.storage_url && !injectedPngUrls.has(png.storage_url)) {
            injectedPngUrls.add(png.storage_url)
            // Formato markdown para que el frontend lo renderice como imagen inline
            inputs.push({ label: png.name, content: `![${png.name}](${png.storage_url})`, source: 'edge', isImage: true, source_project_node_id: edge.source_node_id, output_key: null })
          }
        }
      }
    }

    // 3. Library assets asignados explícitamente al nodo
    const { data: libInputs } = await db()
      .from('forge_project_node_inputs')
      .select(`
        input_label,
        forge_project_library_assets(display_name, extracted_text, storage_url, asset_type)
      `)
      .eq('project_node_id', pNode.id)
      .eq('source_type', 'library_asset')
      .order('order_index')

    for (const inp of (libInputs || [])) {
      const lib = inp.forge_project_library_assets
      if (!lib) continue
      if (lib.extracted_text) {
        inputs.push({ label: lib.display_name, content: lib.extracted_text, source: 'library' })
      } else if (lib.asset_type === 'image') {
        inputs.push({ label: lib.display_name, content: `![${lib.display_name}](${lib.storage_url})`, source: 'library', isImage: true })
      }
    }

    res.json({ success: true, inputs })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:project_node_id/inputs ─────────────
// Agrega un input a un nodo del proyecto
router.post('/nodes/:project_node_id/inputs', async (req, res, next) => {
  try {
    const { id: project_id, project_node_id } = req.params
    const { input_key, input_label, source_type, source_node_id, source_asset_id, is_required } = req.body

    if (!input_key || !source_type) {
      return res.status(400).json({ success: false, error: 'input_key y source_type son requeridos' })
    }

    if (source_type === 'node_output' && !source_node_id) {
      return res.status(400).json({ success: false, error: 'source_node_id es requerido para source_type node_output' })
    }
    if (source_type === 'library_asset' && !source_asset_id) {
      return res.status(400).json({ success: false, error: 'source_asset_id es requerido para source_type library_asset' })
    }

    // Calcular order_index
    const { data: maxOrder } = await db()
      .from('forge_project_node_inputs')
      .select('order_index')
      .eq('project_node_id', project_node_id)
      .order('order_index', { ascending: false })
      .limit(1)
      .maybeSingle()

    const order_index = (maxOrder?.order_index ?? -1) + 1

    const { data, error } = await db()
      .from('forge_project_node_inputs')
      .insert({
        project_node_id,
        project_id,
        input_key,
        input_label: input_label || input_key,
        is_required: is_required ?? false,
        source_type,
        source_node_id:  source_node_id  || null,
        source_asset_id: source_asset_id || null,
        order_index,
      })
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, input: data })
  } catch (err) { next(err) }
})

// ─── DELETE /api/projects/:id/canvas/nodes/:project_node_id/inputs/:input_id ─
// Elimina un input asignado a un nodo
router.delete('/nodes/:project_node_id/inputs/:input_id', async (req, res, next) => {
  try {
    const { input_id } = req.params

    const { error } = await db()
      .from('forge_project_node_inputs')
      .delete()
      .eq('id', input_id)

    if (error) throw error
    res.json({ success: true })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:node_id/import-as-output ───────────
// Importa un library asset como output aprobado del nodo (bypass del chat)
router.post('/nodes/:node_id/import-as-output', async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params
    const { asset_id, member_id } = req.body

    if (!asset_id) {
      return res.status(400).json({ success: false, error: 'asset_id es requerido' })
    }

    // Cargar el library asset
    const { data: libAsset, error: libErr } = await db()
      .from('forge_project_library_assets')
      .select('id, display_name, file_name, mime_type, storage_url, extracted_text, asset_type')
      .eq('id', asset_id)
      .eq('project_id', project_id)
      .single()

    if (libErr || !libAsset) {
      return res.status(404).json({ success: false, error: 'Library asset not found' })
    }

    // Obtener info del nodo
    const { data: node } = await db()
      .from('forge_nodes')
      .select('id, title')
      .eq('id', node_id)
      .single()

    // Crear sesión aprobada directamente
    const { data: session, error: sessErr } = await db()
      .from('forge_sessions')
      .insert({
        project_id,
        node_id,
        status:          'approved',
        iteration_count: 0,
        started_at:      new Date().toISOString(),
        completed_at:    new Date().toISOString(),
        triggered_by:    member_id || null,
      })
      .select('id')
      .single()

    if (sessErr) throw sessErr

    // Determinar formato según asset_type
    const formatMap = { document: 'markdown', image: 'png', model_3d: 'artifact_bundle', other: 'artifact_bundle' }
    const format    = formatMap[libAsset.asset_type] || 'artifact_bundle'

    // Crear forge_asset aprobado apuntando al library asset
    const { data: asset, error: assetErr } = await db()
      .from('forge_assets')
      .insert({
        node_id,
        project_id,
        session_id:   session.id,
        name:         libAsset.display_name || libAsset.file_name,
        format,
        status:       'approved',
        storage_url:  libAsset.storage_url,
        mime_type:    libAsset.mime_type,
        content:      libAsset.extracted_text || null,
        approved_by:  member_id || null,
        approved_at:  new Date().toISOString(),
      })
      .select('id')
      .single()

    if (assetErr) throw assetErr

    // Vincular output_asset_id en la sesión
    await db()
      .from('forge_sessions')
      .update({ output_asset_id: asset.id })
      .eq('id', session.id)

    res.json({ success: true, session_id: session.id, asset_id: asset.id })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/add-text-node ─────────────
// Crea una nueva instancia de text-input node en el canvas
router.post('/add-text-node', async (req, res, next) => {
  try {
    const { id: project_id } = req.params

    const { data: maxOrder } = await db()
      .from('forge_project_nodes')
      .select('order_index')
      .eq('project_id', project_id)
      .order('order_index', { ascending: false })
      .limit(1)
      .maybeSingle()

    const order_index = (maxOrder?.order_index ?? -1) + 1

    const { data, error } = await db()
      .from('forge_project_nodes')
      .insert({
        project_id,
        node_type:       'text_input',
        node_id:         null,
        source_asset_id: null,
        text_label:      'Text Input',
        text_content:    '',
        order_index,
      })
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, project_node: data })
  } catch (err) { next(err) }
})

// ─── PATCH /api/projects/:id/canvas/nodes/:project_node_id/text ──
// Actualiza el label y contenido de un text-input node
router.patch('/nodes/:project_node_id/text', async (req, res, next) => {
  try {
    const { project_node_id } = req.params
    const { text_label, text_content } = req.body

    const { error } = await db()
      .from('forge_project_nodes')
      .update({ text_label, text_content })
      .eq('id', project_node_id)
      .eq('node_type', 'text_input')

    if (error) throw error
    res.json({ success: true })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/run-validate ─────────────────
// Valida que todos los inputs required de los forge_nodes del canvas tienen fuente válida
router.post('/run-validate', async (req, res, next) => {
  try {
    const { id: project_id } = req.params

    // Cargar todos los nodos del canvas
    const { data: pNodes } = await db()
      .from('forge_project_nodes')
      .select('id, node_id, node_type, text_content, text_label, source_asset_id')
      .eq('project_id', project_id)
      .eq('removed', false)

    const forgeNodes = (pNodes || []).filter(n => n.node_type === 'forge_node')

    // Cargar definiciones de nodos (inputs required)
    const nodeIds = forgeNodes.map(n => n.node_id)
    const { data: nodeDefs } = await db()
      .from('forge_nodes')
      .select('id, node_key, title, inputs')
      .in('id', nodeIds)

    const defById = Object.fromEntries((nodeDefs || []).map(n => [n.id, n]))

    // Cargar sesiones activas con mensajes de agente (intervención manual pendiente)
    const { data: activeSessions } = await db()
      .from('forge_sessions')
      .select('node_id, id')
      .eq('project_id', project_id)
      .eq('status', 'active')

    // Para cada sesión activa, verificar si tiene mensajes del agente
    const unreviewedNodeIds = new Set()
    for (const sess of (activeSessions || [])) {
      const { count } = await db()
        .from('forge_messages')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sess.id)
        .eq('role', 'agent')
      if (count > 0) unreviewedNodeIds.add(sess.node_id)
    }

    // Cargar todos los edges del proyecto
    const { data: edges } = await db()
      .from('forge_project_edges')
      .select('source_node_id, target_node_id')
      .eq('project_id', project_id)

    const edgesByTarget = {}
    for (const e of (edges || [])) {
      if (!edgesByTarget[e.target_node_id]) edgesByTarget[e.target_node_id] = []
      edgesByTarget[e.target_node_id].push(e.source_node_id)
    }

    const pNodeById = Object.fromEntries((pNodes || []).map(n => [n.id, n]))

    const errors = []

    for (const pn of forgeNodes) {
      const def = defById[pn.node_id]
      if (!def) continue

      // Prioridad 1: sesión activa con respuesta del agente no aceptada → el usuario debe resolver
      if (unreviewedNodeIds.has(pn.node_id)) {
        errors.push({
          type:          'unreviewed_session',
          projectNodeId: pn.id,
          nodeId:        pn.node_id,
          nodeKey:       def.node_key,
          nodeTitle:     def.title,
          reason:        `Has an unreviewed response — Accept or discard it before running`,
        })
        continue
      }

      const inputs   = def.inputs
      const required = Array.isArray(inputs)
        ? inputs.filter(i => i.required).map(i => i.key ?? i)
        : Array.isArray(inputs?.required) ? inputs.required : []

      const incomingSources = edgesByTarget[pn.id] || []

      // Prioridad 2: inputs required sin ninguna fuente conectada
      if (required.length > 0 && incomingSources.length === 0) {
        errors.push({
          type:          'missing_input',
          projectNodeId: pn.id,
          nodeId:        pn.node_id,
          nodeKey:       def.node_key,
          nodeTitle:     def.title,
          reason:        `Requires "${required[0]}" — connect a Text Input node with your idea first`,
        })
        continue
      }

      // Prioridad 3: fuentes conectadas vacías
      for (const sourceId of incomingSources) {
        const src = pNodeById[sourceId]
        if (!src) continue
        if (src.node_type === 'forge_node') continue  // se ejecutará antes en el run — OK

        if (src.node_type === 'text_input' && !src.text_content?.trim()) {
          errors.push({
            type:          'empty_source',
            projectNodeId: pn.id,
            nodeId:        pn.node_id,
            nodeKey:       def.node_key,
            nodeTitle:     def.title,
            reason:        `"${src.text_label || 'Text Input'}" is connected but has no text`,
          })
        } else if (src.node_type === 'library_asset') {
          const { data: asset } = await db()
            .from('forge_project_library_assets')
            .select('extracted_text, storage_url')
            .eq('id', src.source_asset_id)
            .maybeSingle()
          if (!asset?.extracted_text && !asset?.storage_url) {
            errors.push({
              type:          'empty_source',
              projectNodeId: pn.id,
              nodeId:        pn.node_id,
              nodeKey:       def.node_key,
              nodeTitle:     def.title,
              reason:        `Asset connected to "${def.title}" has no content`,
            })
          }
        }
      }
    }

    res.json({ success: true, valid: errors.length === 0, errors })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:project_node_id/auto-run ──
// Ejecuta un nodo en modo autopilot y lo auto-aprueba como auto_approved
router.post('/nodes/:project_node_id/auto-run', async (req, res, next) => {
  try {
    const { id: project_id, project_node_id } = req.params
    const { member_id } = req.body

    const { buildSystemPrompt, runReActLoop, propagateStale } = require('../services/canvas-chat.service')
    const { logExecution } = require('../services/execution-log.service')
    const normalizeOutputSections = (text, defs) => text  // sin normalización en auto-run

    // Obtener el forge_node_id desde el project_node_id
    const { data: pNode } = await db()
      .from('forge_project_nodes')
      .select('node_id, node_type')
      .eq('id', project_node_id)
      .eq('removed', false)
      .maybeSingle()

    if (!pNode || pNode.node_type !== 'forge_node') {
      return res.status(404).json({ success: false, error: 'Project node not found or not a forge_node' })
    }

    const node_id = pNode.node_id

    // Crear nueva sesión activa
    const { data: session, error: sessErr } = await db()
      .from('forge_sessions')
      .insert({
        project_id,
        node_id,
        status:          'active',
        iteration_count: 0,
        started_at:      new Date().toISOString(),
        triggered_by:    member_id || null,
      })
      .select('id, iteration_count')
      .single()

    if (sessErr) throw sessErr

    const userMessage = 'Generate the output for this step'

    // Componer system prompt
    const { finalSystemPrompt, baseUserMsg, executorStr, activeTools, outputDefs, resolvedInputs, node } =
      await buildSystemPrompt(db, { projectId: project_id, nodeId: node_id, sessionId: session.id, userMessage, targetOutputKey: req.body.target_output_key || null })

    // Ejecutar ReAct loop
    const { replyText, allToolCalls, docUrl, docFormat, meta } = await runReActLoop({
      finalSystemPrompt, baseUserMsg, executorStr, activeTools, resolvedInputs,
      projectId: project_id, nodeId: node_id, nodeName: node.title,
    })

    // Registrar costo (nunca rompe el flujo)
    try { logExecution({
      project_id,
      node_id,
      session_id:   session.id,
      triggered_by: member_id || null,
      trigger_type: 'auto_run',
      executor_type:'llm',
      provider:     meta?.provider   || null,
      model:        meta?.model      || null,
      tokens:       meta?.tokens_used || null,
      duration_ms:  meta?.duration_ms || null,
      started_at:   new Date(Date.now() - (meta?.duration_ms || 0)).toISOString(),
      status:       'success',
      metadata:     { node_key: node.node_key },
    }) } catch (logErr) { console.error('[auto-run] logExecution failed (non-fatal):', logErr.message) }

    // Persistir mensajes
    await db()
      .from('forge_messages')
      .insert({ session_id: session.id, role: 'human', content: userMessage, order_index: 0, tool_calls: [] })

    await db()
      .from('forge_messages')
      .insert({ session_id: session.id, role: 'agent', content: replyText, order_index: 1, tool_calls: allToolCalls.length ? allToolCalls : [] })

    // Crear asset auto_approved
    const { data: asset, error: assetErr } = await db()
      .from('forge_assets')
      .insert({
        node_id,
        project_id,
        session_id:   session.id,
        name:         `${node.title} — Output`,
        format:       docUrl ? (docFormat === 'pptx' ? 'pptx' : 'docx') : 'markdown',
        status:       'approved',
        content:      replyText,
        storage_url:  docUrl || null,
        approved_by:  member_id || null,
        approved_at:  new Date().toISOString(),
      })
      .select('id')
      .single()

    if (assetErr) throw assetErr

    // Cerrar sesión como auto_approved
    await db()
      .from('forge_sessions')
      .update({ status: 'auto_approved', output_asset_id: asset.id, completed_at: new Date().toISOString(), iteration_count: 1 })
      .eq('id', session.id)

    // Limpiar is_stale del nodo actual y propagar stale a descendientes
    await db()
      .from('forge_project_nodes')
      .update({ is_stale: false })
      .eq('id', project_node_id)

    await propagateStale(db, project_id, project_node_id)

    res.json({
      success:    true,
      session_id: session.id,
      reply:      replyText,
      doc_url:    docUrl   || undefined,
      doc_format: docFormat || undefined,
    })
  } catch (err) { next(err) }
})

// Re-corre auto-wire manualmente — útil después de reconstruir project_nodes vía SQL
router.post('/rewire', async (req, res, next) => {
  const project_id = req.params.id
  try {
    const created = await autoWire(project_id, db)
    res.json({ ok: true, edges_created: created })
  } catch (err) { next(err) }
})

// ─── DELETE /canvas/lanes/:lane_id ────────────────────────────────────────────
// Elimina un lane y todos sus nodos miembro en cascade
router.delete('/lanes/:lane_id', async (req, res, next) => {
  try {
    const { id: project_id, lane_id } = req.params

    // Obtener todos los nodos del lane
    const { data: memberNodes } = await db()
      .from('forge_project_nodes')
      .select('id')
      .eq('project_id', project_id)
      .eq('lane_id', lane_id)

    // Limpiar edges y rewire por cada nodo miembro
    for (const node of memberNodes ?? []) {
      try { await cleanupAndRewire(project_id, node.id, db) } catch { /* noop */ }
    }

    // Eliminar nodos miembro
    if (memberNodes?.length) {
      await db()
        .from('forge_project_nodes')
        .delete()
        .eq('project_id', project_id)
        .eq('lane_id', lane_id)
    }

    // Eliminar el lane
    const { error } = await db()
      .from('forge_lanes')
      .delete()
      .eq('id', lane_id)
      .eq('project_id', project_id)

    if (error) throw error

    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
