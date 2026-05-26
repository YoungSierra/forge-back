const express = require('express')
const router  = express.Router({ mergeParams: true })
const { db }  = require('../services/supabase.service')

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
        text_label, text_content,
        blueprint_id,
        forge_nodes (
          id, node_key, title, phase, purpose,
          inputs, outputs, tools, skills, executor, status
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

    // Última sesión por nodo
    const nodeIds = (projectNodes || []).filter(pn => pn.node_id).map(pn => pn.node_id)
    let sessionsByNodeId = {}

    if (nodeIds.length > 0) {
      const { data: sessions, error: sessionsError } = await db()
        .from('forge_sessions')
        .select('id, node_id, status, iteration_count, started_at, completed_at, output_asset_id')
        .eq('project_id', project_id)
        .in('node_id', nodeIds)
        .order('created_at', { ascending: false })

      if (sessionsError) throw sessionsError

      // Quedarse solo con la última sesión por nodo
      for (const s of (sessions || [])) {
        if (!sessionsByNodeId[s.node_id]) sessionsByNodeId[s.node_id] = s
      }
    }

    // Cargar output assets de sesiones aprobadas (batch — evita N+1)
    const outputAssetIds = Object.values(sessionsByNodeId)
      .filter(s => s.status === 'approved' && s.output_asset_id)
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
      return {
        project_node_id: pn.id,
        order_index:     pn.order_index,
        blueprint_id:    pn.blueprint_id,
        node_type:       nodeType,
        node:            pn.forge_nodes || null,
        asset:           pn.forge_project_library_assets || null,
        text_label:      pn.text_label  ?? null,
        text_content:    pn.text_content ?? null,
        session:         session ? { ...session, output_asset } : null,
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

    res.json({
      success: true,
      nodes,
      edges,
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

    // Nodos ya en el canvas para evitar duplicados
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
      .select('id, node_sequence, name')
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

    res.json({
      success:         true,
      blueprint_name:  blueprint.name,
      nodes_added:     toInsert.length,
      nodes_skipped:   sequence.length - toInsert.length,
    })
  } catch (err) { next(err) }
})

// ─── DELETE /api/projects/:id/canvas/nodes/:project_node_id ──
// Quita un nodo del canvas (soft remove)
router.delete('/nodes/:project_node_id', async (req, res, next) => {
  try {
    const { error } = await db()
      .from('forge_project_nodes')
      .update({ removed: true, removed_at: new Date().toISOString() })
      .eq('id', req.params.project_node_id)

    if (error) throw error
    res.json({ success: true })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:node_id/accept ─────
// Aprueba el output del nodo: crea forge_asset y cierra la sesión
router.post('/nodes/:node_id/accept', async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params
    const { session_id, content, member_id, doc_url } = req.body

    if (!session_id || !content?.trim()) {
      return res.status(400).json({ success: false, error: 'session_id y content son requeridos' })
    }

    // Obtener nombre del nodo para el asset
    const { data: node, error: nodeErr } = await db()
      .from('forge_nodes')
      .select('id, title, node_key')
      .eq('id', node_id)
      .single()

    if (nodeErr || !node) {
      return res.status(404).json({ success: false, error: 'Node not found' })
    }

    // Crear el forge_asset con el contenido aceptado
    const { data: asset, error: assetErr } = await db()
      .from('forge_assets')
      .insert({
        node_id,
        project_id,
        session_id,
        name:           `${node.title} — Output`,
        format:         doc_url ? 'document' : 'markdown',
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

    res.json({ success: true, asset_id: asset.id })
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
      .eq('status', 'approved')
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

    const { data: session, error: sessErr } = await db()
      .from('forge_sessions')
      .select('id, status, iteration_count, started_at, completed_at, output_asset_id')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (sessErr) throw sessErr
    if (!session) return res.json({ success: true, session: null, messages: [] })

    const { data: msgs } = await db()
      .from('forge_messages')
      .select('role, content, order_index')
      .eq('session_id', session.id)
      .order('order_index')

    // Mapear roles: human→user, agent→assistant
    const messages = (msgs || []).map(m => ({
      role:    m.role === 'human' ? 'user' : 'assistant',
      content: m.content,
    }))

    // Incluir asset aprobado si la sesión está aprobada
    let asset = null
    if (session.status === 'approved' && session.output_asset_id) {
      const { data: assetData } = await db()
        .from('forge_assets')
        .select('id, name, format, content, storage_url')
        .eq('id', session.output_asset_id)
        .maybeSingle()
      asset = assetData
    }

    res.json({ success: true, session, messages, asset })
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
router.post('/nodes/:node_id/chat', async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params
    const { user_message, session_id, member_id } = req.body

    if (!user_message?.trim()) {
      return res.status(400).json({ success: false, error: 'user_message es requerido' })
    }

    // Obtener definición del nodo para componer el prompt y resolver el modelo
    const { data: node, error: nodeErr } = await db()
      .from('forge_nodes')
      .select('id, node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt, executor')
      .eq('id', node_id)
      .single()

    if (nodeErr || !node) {
      return res.status(404).json({ success: false, error: 'Node not found' })
    }

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
      const { data: existing } = await db()
        .from('forge_sessions')
        .select('id, iteration_count')
        .eq('project_id', project_id)
        .eq('node_id', node_id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      session = existing
    }

    if (!session) {
      const { data: created, error: createErr } = await db()
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
      if (createErr) throw createErr
      session = created
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

    // default_prompt del nodo primero; R2 solo como fallback si está vacío
    const r2Prompt = node.default_prompt ? null : await getPrompt(node.node_key)

    let layer1 = node.default_prompt
      ? injectVars(node.default_prompt, templateVars)
      : r2Prompt
        ? injectVars(r2Prompt, templateVars)
        : null

    if (!layer1) {
      // Componer desde DNA cuando no hay prompt explícito
      const outputDefs = Array.isArray(node.outputs) ? node.outputs : []
      const outputsBlock = outputDefs.length
        ? outputDefs.map(o => {
            const name   = typeof o === 'object' ? o.name   : o
            const format = typeof o === 'object' ? o.format : null
            const desc   = typeof o === 'object' ? o.description : null
            return `- **${name}**${format ? ` (${format})` : ''}${desc ? ` — ${desc}` : ''}`
          }).join('\n')
        : ''

      layer1 = [
        `You are Forge Assistant, an expert AI for game design and development.`,
        `You are operating as the "${node.title}" node (phase: ${node.phase}).`,
        node.purpose     ? `\n## Purpose\n${node.purpose}`         : '',
        node.constraints ? `\n## Constraints\n${node.constraints}` : '',
        outputsBlock     ? `\n## Outputs to produce\nProduce each output as a separate section using the exact heading "## <output_name>":\n${outputsBlock}` : '',
        `\nFormat your response in markdown. Each output section must start with its exact name as a level-2 heading (## output_name).`,
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
    const outputDefs    = Array.isArray(node.outputs) ? node.outputs : []
    const outputNames   = outputDefs.map(o => typeof o === 'object' ? o.name : o).filter(Boolean)
    const formatInstr   = outputNames.length
      ? `\n## Output format\nStructure your response in markdown. Each output must be its own section with the exact level-2 heading "## <output_name>". Required sections: ${outputNames.map(n => `"## ${n}"`).join(', ')}.`
      : ''

    const layer1Extras = [
      node.purpose     && !layer1.includes(node.purpose)     ? `\n## Purpose\n${node.purpose}`         : '',
      node.constraints && !layer1.includes(node.constraints) ? `\n## Constraints\n${node.constraints}` : '',
      skillsBlock || '',
      formatInstr && !layer1.includes('## Output format')    ? formatInstr                              : '',
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
    const { data: currentPNode } = await db()
      .from('forge_project_nodes')
      .select('id')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .eq('removed', false)
      .maybeSingle()

    let resolvedInputs = []

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
          // Forge-node: buscar output aprobado
          const { data: asset } = await db()
            .from('forge_assets')
            .select('content, storage_url')
            .eq('project_id', project_id)
            .eq('node_id', sourcePNode.node_id)
            .eq('status', 'approved')
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
              const idx       = parseInt(srcHandle.replace('out-', ''), 10)
              const outputDef = outputs[idx]
              if (outputDef?.name) {
                const extracted = extractSection(content, outputDef.name)
                if (extracted) {
                  content   = extracted
                  slotLabel = `${nodeTitle} → ${outputDef.name}`
                }
              }
            }

            const snippet = content.slice(0, 3000) + (content.length > 3000 ? '\n[truncated]' : '')
            resolvedInputs.push(`### ${slotLabel}\n${snippet}`)
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

    const layer2Parts = [
      projectMeta      ? `## Project context\n${projectMeta}`              : '',
      resolvedInputs.length ? `## Input references\n${resolvedInputs.join('\n\n')}` : '',
    ].filter(Boolean)

    // ── Ensamblar system prompt ───────────────────────────────────
    const { getToolsBlock, parseToolCalls, executeTool } = require('../services/tools.service')

    const activeTools = Array.isArray(node.tools) && node.tools.length ? node.tools : []
    // doc_gen_docx se ejecuta automáticamente al final — no exponerla al LLM para evitar alucinaciones
    const llmVisibleTools = activeTools.filter(t => t !== 'doc_gen_docx')
    const toolsBlock      = getToolsBlock(llmVisibleTools)

    const systemPrompt = [layer1, ...layer2Parts, toolsBlock].filter(Boolean).join('\n\n')

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
    console.log(`  prompt src:   ${node.default_prompt ? 'default_prompt' : r2Prompt ? 'R2' : 'DNA composed'}`)
    console.log(`  project:      ${project?.name ?? '(sin nombre)'}`)
    console.log(`  tools:        ${toolsList ?? '(none)'}`)
    console.log(`  skills:       ${skillsList ?? '(none)'}`)
    console.log(`  inputs:       ${resolvedInputs.length} referencia(s) — ${resolvedInputs.length ? resolvedInputs.map(d => d.split('\n')[0].replace('### ', '')).join(', ') : '(none)'}`)
    console.log(`  system prompt (${systemPrompt.length} chars):\n${systemPrompt}`)

    console.log(`  history msgs: ${historyMsgs?.length ?? 0}`)
    console.log(`  user message: ${user_message.trim().slice(0, 120)}${user_message.length > 120 ? '…' : ''}`)
    console.log('─────────────────────────────────────────────────────\n')

    // ── ReAct loop — ejecuta hasta que el LLM no emita más tool_calls ────────
    const MAX_TOOL_ITERS  = 5
    let   currentUserMsg  = baseUserMsg
    let   replyText       = ''
    let   allToolCalls    = []    // historial de calls para persistir
    let   meta            = null

    for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
      const result = await callLLM(systemPrompt, currentUserMsg, {
        model:           executorStr,
        rawText:         true,
        temperature:     0.7,
        maxOutputTokens: 2048,
      })

      meta      = result.meta
      replyText = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)

      const calls = activeTools.length ? parseToolCalls(replyText) : []
      if (!calls.length) break   // sin tool calls → terminado

      console.log(`[forge-chat] tool calls iter=${iter + 1}:`, calls.map(c => c.tool))

      // Ejecutar cada tool y acumular resultados
      const toolResultParts = []
      for (const tc of calls) {
        const toolResult = await executeTool(tc.tool, tc.args, { project_id, node_id })
        allToolCalls.push({ ...tc, result: toolResult })

        // Para doc_gen_docx con URL exitosa, pedir al LLM que presente el link en markdown
        let resultText = JSON.stringify(toolResult, null, 2)
        if (tc.tool === 'doc_gen_docx' && toolResult.success && toolResult.url) {
          resultText = `Document generated successfully.\nFilename: ${toolResult.filename}\nDownload URL: ${toolResult.url}\n\nPresent this to the user as a markdown link: [${toolResult.filename}](${toolResult.url}) — make sure to include the full URL so they can open it.`
        }

        toolResultParts.push(`<tool_result tool="${tc.tool}">\n${resultText}\n</tool_result>`)
      }

      // Extender el contexto con la respuesta parcial + resultados para el próximo iter
      currentUserMsg = currentUserMsg
        + `\n\nAgent: ${replyText}\n\n${toolResultParts.join('\n\n')}\n\nContinue your response using the tool results above.`
    }

    // Si el nodo tiene doc_gen_docx y el LLM no la llamó por su cuenta, generar automáticamente
    let docUrl = null
    const hasDocTool   = activeTools.includes('doc_gen_docx')
    const alreadyCalled = allToolCalls.some(tc => tc.tool === 'doc_gen_docx')

    if (hasDocTool && !alreadyCalled && replyText.trim().length > 200) {
      try {
        // Extraer solo la sección del output principal (format: document/pdf)
        // para no incluir outputs secundarios (light_pitches, etc.) en el PDF
        let docContent = replyText
        const docOutputDef = outputDefs.find(o => {
          const fmt = typeof o === 'object' ? (o.format ?? '') : ''
          return ['document', 'pdf', 'doc'].includes(fmt.toLowerCase())
        }) || outputDefs[0]

        if (docOutputDef) {
          const outName        = typeof docOutputDef === 'object' ? docOutputDef.name : docOutputDef
          const secondaryDefs  = outputDefs.filter(o => o !== docOutputDef)

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
          docUrl = docResult.url
          allToolCalls.push({ tool: 'doc_gen_docx', args: { auto: true }, result: docResult })
          // No embebemos el link en replyText — el frontend lo maneja via doc_url
        }
      } catch (docErr) {
        console.error('[forge-chat] auto doc_gen_docx failed:', docErr.message)
      }
    }

    // Persistir par de mensajes — tool_calls en el mensaje del agente si los hubo
    const agentRecord = {
      session_id:  session.id,
      role:        'agent',
      content:     replyText,
      order_index: nextIndex + 1,
      tool_calls:  allToolCalls.length ? allToolCalls : [],
    }

    const { error: insertErr } = await db().from('forge_messages').insert([
      { session_id: session.id, role: 'human', content: user_message.trim(), order_index: nextIndex, tool_calls: [] },
      agentRecord,
    ])

    if (insertErr) {
      console.error('[forge-chat] forge_messages insert error:', insertErr)
      throw new Error(`Failed to save messages: ${insertErr.message}`)
    }

    // Incrementar contador de iteraciones
    await db()
      .from('forge_sessions')
      .update({ iteration_count: session.iteration_count + 1 })
      .eq('id', session.id)

    res.json({ success: true, reply: replyText, session_id: session.id, meta, doc_url: docUrl ?? undefined })
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

    // Buscar cualquier registro existente (activo o removido)
    const { data: existing } = await db()
      .from('forge_project_nodes')
      .select('id, removed')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .maybeSingle()

    if (existing) {
      if (!existing.removed) {
        return res.status(409).json({ success: false, error: 'Node already in canvas' })
      }

      // Restaurar el registro en lugar de crear uno nuevo
      const { data, error } = await db()
        .from('forge_project_nodes')
        .update({ removed: false, removed_at: null })
        .eq('id', existing.id)
        .select()
        .single()

      if (error) throw error
      return res.json({ success: true, project_node: data })
    }

    // Registro nuevo — calcular el próximo order_index
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
      .insert({ project_id, node_id, order_index })
      .select()
      .single()

    if (error) throw error
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
      return res.json({ success: true, project_node: data })
    }

    const { data, error } = await db()
      .from('forge_project_nodes')
      .insert({ project_id, node_type: 'library_asset', source_asset_id: asset_id, node_id: null })
      .select()
      .single()

    if (error) throw error
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
    const { error: delError } = await db()
      .from('forge_project_edges')
      .delete()
      .eq('project_id', project_id)

    if (delError) {
      console.warn('[forge-canvas] PUT /edges delete failed:', delError.message)
      return res.json({ success: true, pending_migration: true })
    }

    if (Array.isArray(edges) && edges.length > 0) {
      const rows = edges.map(e => ({
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
        const rowsBasic = edges.map(e => ({ project_id, source_node_id: e.source, target_node_id: e.target }))
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

module.exports = router
