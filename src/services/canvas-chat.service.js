'use strict'

// Lógica compartida entre el endpoint de chat y el auto-run

function injectVars(template, vars) {
  return template.replace(/\[(\w+)\]/g, (_, key) => vars[key] ?? `[${key}]`)
}

function injectSkillVars(template, vars) {
  let result = template.replace(/\[([^\]]+)\]/g, (match, key) => {
    const normalized = key.toLowerCase().replace(/\s+/g, '_')
    const value = vars[normalized] ?? vars[key]
    return (value != null && value !== '') ? value : ''
  })
  result = result.replace(/\s*·\s*·\s*/g, ' · ')
  result = result.replace(/^\s*·\s*/gm, '')
  result = result.replace(/\s*·\s*$/gm, '')
  return result
}

/**
 * Construye el system prompt completo para un nodo dado.
 * Devuelve { finalSystemPrompt, baseUserMsg, executorStr, activeTools, outputDefs, resolvedInputs }
 */
async function buildSystemPrompt(db, { projectId, nodeId, sessionId, userMessage, historyMsgs = [], attachmentParts = [] }) {
  const { getPrompt, getSkill } = require('./prompt.service')

  const { data: node } = await db()
    .from('forge_nodes')
    .select('id, node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt, executor')
    .eq('id', nodeId)
    .single()

  if (!node) throw new Error(`Node not found: ${nodeId}`)

  const { data: project } = await db()
    .from('projects')
    .select('name, genre, studio_name, target_platform, team_scale, budget_range, timeline, context_notes')
    .eq('id', projectId)
    .maybeSingle()

  const templateVars = {
    project: project?.name ?? 'this game',
    prompt:  userMessage.trim(),
    seed:    userMessage.trim(),
  }

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

  const r2Prompt = node.default_prompt ? null : await getPrompt(node.node_key)

  let layer1 = node.default_prompt
    ? injectVars(node.default_prompt, templateVars)
    : r2Prompt
      ? injectVars(r2Prompt, templateVars)
      : null

  const outputDefs = Array.isArray(node.outputs) ? node.outputs : []

  if (!layer1) {
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

  const skillDefs  = Array.isArray(node.skills) ? node.skills : []
  const skillTexts = await Promise.all(skillDefs.map(s => getSkill(s)))
  const skillsBlock = skillDefs
    .map((s, i) => {
      if (!skillTexts[i]) return ''
      const filledText = injectSkillVars(skillTexts[i], skillVars)
      return `\n## Skill Reference: ${s}\n> This section is a GUIDE for your output structure. Do NOT reproduce these instructions verbatim in your response. Use the template to organize your content, but generate original text for each section.\n\n${filledText}`
    })
    .filter(Boolean).join('\n')

  const outputNames = outputDefs.map(o => typeof o === 'object' ? o.name : o).filter(Boolean)

  const FORMAT_HINTS = {
    structured:      'Output a FLAT numbered list ONLY — no subheadings, no category labels, no prose introduction. Each item MUST follow this exact format: `- Variation N: Name: brief description`',
    markdown_table:  'MUST be a markdown table with header row and `|---|` separator row.',
    single_sentence: 'Single sentence only — no markdown, no line breaks, no bullets.',
  }
  const outputFormatLines = outputDefs
    .filter(o => typeof o === 'object' && o.name && FORMAT_HINTS[o.format])
    .map(o => `- **${o.name}**: ${FORMAT_HINTS[o.format]}`)

  const formatInstr = outputNames.length
    ? `\n## Output format\nStructure your response in markdown. Each output must be its own section with the exact level-2 heading "## <output_name>". Required sections: ${outputNames.map(n => `"## ${n}"`).join(', ')}.${outputFormatLines.length ? '\n\nPer-section format requirements:\n' + outputFormatLines.join('\n') : ''}`
    : ''

  const layer1Extras = [
    node.purpose     && !layer1.includes(node.purpose)     ? `\n## Purpose\n${node.purpose}`         : '',
    node.constraints && !layer1.includes(node.constraints) ? `\n## Constraints\n${node.constraints}` : '',
    skillsBlock || '',
    formatInstr && !layer1.includes('## Output format') ? formatInstr : '',
  ].filter(Boolean).join('\n')

  layer1 = layer1 + layer1Extras

  // Layer 2: project context + inputs desde edges
  const projectMeta = [
    project?.name            ? `Game: ${project.name}`                : '',
    project?.genre           ? `Genre: ${project.genre}`              : '',
    project?.studio_name     ? `Studio: ${project.studio_name}`       : '',
    project?.target_platform ? `Platform: ${project.target_platform}` : '',
    project?.team_scale      ? `Team: ${project.team_scale}`          : '',
    project?.budget_range    ? `Budget: ${project.budget_range}`      : '',
    project?.timeline        ? `Timeline: ${project.timeline}`        : '',
    project?.context_notes   ? `\n${project.context_notes}`           : '',
  ].filter(Boolean).join('\n')

  const { data: currentPNode } = await db()
    .from('forge_project_nodes')
    .select('id')
    .eq('project_id', projectId)
    .eq('node_id', nodeId)
    .eq('removed', false)
    .maybeSingle()

  let resolvedInputs = []
  const injectedPngUrls = new Set()

  if (currentPNode) {
    let incomingEdges = []
    try {
      const { data: edgeData } = await db()
        .from('forge_project_edges')
        .select('source_node_id, source_handle')
        .eq('project_id', projectId)
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
        const lib = sourcePNode.forge_project_library_assets
        if (!lib) continue
        if (lib.extracted_text) {
          const snippet = lib.extracted_text.slice(0, 3000) + (lib.extracted_text.length > 3000 ? '\n[truncated]' : '')
          resolvedInputs.push(`### ${lib.display_name} (library asset)\n${snippet}`)
        } else if (lib.asset_type === 'image') {
          resolvedInputs.push(`### ${lib.display_name} (image reference)\nURL: ${lib.storage_url}`)
        }
      } else if (sourcePNode.node_type === 'text_input') {
        const label   = sourcePNode.text_label   || 'Text Input'
        const content = (sourcePNode.text_content || '').trim()
        if (content) resolvedInputs.push(`### ${label}\n${content}`)
      } else {
        // Forge-node: buscar output aprobado o auto_approved más reciente
        const { data: asset } = await db()
          .from('forge_assets')
          .select('content, storage_url')
          .eq('project_id', projectId)
          .eq('node_id', sourcePNode.node_id)
          .in('status', ['approved', 'auto_approved'])
          .neq('format', 'png')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (asset?.content) {
          const nodeTitle = sourcePNode.forge_nodes?.title ?? 'Upstream node'
          const outputs   = sourcePNode.forge_nodes?.outputs ?? []
          let   content   = asset.content
          let   slotLabel = nodeTitle

          const srcHandle = edge.source_handle
          if (srcHandle?.startsWith('out-')) {
            const handleVal = srcHandle.slice(4)
            const outputDef = outputs.find(o => o.name === handleVal) ?? outputs[parseInt(handleVal, 10)]
            if (outputDef?.name) {
              slotLabel = `${nodeTitle} → ${outputDef.name}`
            }
          }

          const snippet = content.slice(0, 3000) + (content.length > 3000 ? '\n[truncated]' : '')
          resolvedInputs.push(`### ${slotLabel}\n${snippet}`)
        }

        const { data: pngAssets } = await db()
          .from('forge_assets')
          .select('name, storage_url')
          .eq('project_id', projectId)
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
      }
    }

    // Library assets asignados explícitamente
    const { data: libInputs } = await db()
      .from('forge_project_node_inputs')
      .select(`input_label, forge_project_library_assets(display_name, extracted_text, storage_url, asset_type)`)
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

  const { getToolsBlock } = require('./tools.service')
  const activeTools      = Array.isArray(node.tools) && node.tools.length ? node.tools : []
  const llmVisibleTools  = activeTools.filter(t => t !== 'doc_gen_docx')
  const toolsBlock       = getToolsBlock(llmVisibleTools)

  const layer2Parts = [
    projectMeta       ? `## Project context\n${projectMeta}`              : '',
    resolvedInputs.length ? `## Input references\n${resolvedInputs.join('\n\n')}` : '',
  ].filter(Boolean)

  const systemPrompt = [layer1, ...layer2Parts, toolsBlock].filter(Boolean).join('\n\n')

  const finalSystemPrompt = attachmentParts.length
    ? systemPrompt + '\n\n## Attached references\n' + attachmentParts.join('\n\n')
    : systemPrompt

  const historyText = historyMsgs
    .map(m => `${m.role === 'human' ? 'Human' : 'Agent'}: ${m.content}`)
    .join('\n\n')

  const baseUserMsg = [
    historyText ? `Previous conversation:\n${historyText}` : '',
    `Human: ${userMessage.trim()}`,
  ].filter(Boolean).join('\n\n')

  const executorStr = node.executor?.model || process.env.DEFAULT_MODEL

  return { finalSystemPrompt, baseUserMsg, executorStr, activeTools, outputDefs, resolvedInputs, node }
}

/**
 * Ejecuta el ReAct loop: LLM + herramientas.
 * Devuelve { replyText, allToolCalls, docUrl, docFormat, meta }
 */
async function runReActLoop({ finalSystemPrompt, baseUserMsg, executorStr, activeTools, resolvedInputs = [], projectId, nodeId, nodeName = '' }) {
  const { callLLM }                          = require('./llm.service')
  const { parseToolCalls, executeTool }      = require('./tools.service')

  const MAX_TOOL_ITERS = 5
  let currentUserMsg   = baseUserMsg
  let replyText        = ''
  let allToolCalls     = []
  let meta             = null
  let docUrl           = null
  let docFormat        = null

  for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
    const result = await callLLM(finalSystemPrompt, currentUserMsg, {
      model: executorStr, rawText: true, temperature: 0.7, maxOutputTokens: 8192,
    })
    meta      = result.meta
    replyText = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)

    const calls = activeTools.length ? parseToolCalls(replyText) : []
    if (!calls.length) break

    const toolResultParts = []
    for (const tc of calls) {
      const toolResult = await executeTool(tc.tool, tc.args, { project_id: projectId, node_id: nodeId })
      allToolCalls.push({ ...tc, result: toolResult })

      let resultText = JSON.stringify(toolResult, null, 2)
      if ((tc.tool === 'doc_gen_docx' || tc.tool === 'doc_gen_pptx') && toolResult.success && toolResult.url) {
        docUrl     = toolResult.url
        docFormat  = toolResult.format || (tc.tool === 'doc_gen_pptx' ? 'pptx' : 'pdf')
        resultText = `File generated successfully.\nFilename: ${toolResult.filename}\nDownload URL: ${toolResult.url}\n\nTell the user the file is ready. Do NOT reproduce the slide content again.`
      }
      toolResultParts.push(`<tool_result tool="${tc.tool}">\n${resultText}\n</tool_result>`)
    }

    currentUserMsg = currentUserMsg
      + `\n\nAgent: ${replyText}\n\n${toolResultParts.join('\n\n')}\n\nContinue your response using the tool results above.`
  }

  // Strip disclaimer si el tool falló
  {
    const DISCLAIMER_RE = /web search is (?:unavailable|not (?:available|configured))|training knowledge|not have (?:access to|real-?time)|cannot (?:access|perform) (?:web|internet) search/i
    const firstBreak = replyText.search(/\n\n|\n(?=#)/)
    if (firstBreak > 0 && DISCLAIMER_RE.test(replyText.slice(0, firstBreak))) {
      replyText = replyText.slice(firstBreak).trimStart()
    }
  }

  // Auto doc_gen_docx si el nodo lo tiene y el LLM no lo llamó
  const hasDocxTool      = activeTools.includes('doc_gen_docx')
  const docxAlreadyCalled = allToolCalls.some(tc => tc.tool === 'doc_gen_docx')
  if (hasDocxTool && !docxAlreadyCalled && replyText.trim().length > 200) {
    try {
      const { executeTool: et } = require('./tools.service')
      const docResult = await et('doc_gen_docx', { title: nodeName, content: replyText }, { project_id: projectId, node_id: nodeId })
      if (docResult.success && docResult.url) {
        docUrl    = docResult.url
        docFormat = docResult.format || 'pdf'
        allToolCalls.push({ tool: 'doc_gen_docx', args: { auto: true }, result: docResult })
      }
    } catch (e) { console.error('[canvas-chat] auto doc_gen_docx failed:', e.message) }
  }

  // Auto doc_gen_pptx
  const hasPptxTool      = activeTools.includes('doc_gen_pptx')
  const pptxAlreadyCalled = allToolCalls.some(tc => tc.tool === 'doc_gen_pptx')
  if (hasPptxTool && !pptxAlreadyCalled && replyText.trim().length > 200) {
    try {
      const { executeTool: et } = require('./tools.service')
      const pngImageUrls = resolvedInputs
        .filter(s => s.includes('(generated image)'))
        .map(s => { const m = s.match(/URL:\s*(https?:\/\/\S+)/); return m ? m[1] : null })
        .filter(Boolean)

      const pptxResult = await et('doc_gen_pptx', { title: nodeName, content: replyText, images: pngImageUrls }, { project_id: projectId, node_id: nodeId })
      if (pptxResult.success && pptxResult.url) {
        docUrl    = pptxResult.url
        docFormat = 'pptx'
        allToolCalls.push({ tool: 'doc_gen_pptx', args: { auto: true }, result: pptxResult })
      }
    } catch (e) { console.error('[canvas-chat] auto doc_gen_pptx failed:', e.message) }
  }

  return { replyText, allToolCalls, docUrl, docFormat, meta }
}

/**
 * Propaga is_stale=true a todos los forge_nodes descendientes en el grafo.
 */
async function propagateStale(db, projectId, projectNodeId) {
  const visited = new Set()
  const queue   = [projectNodeId]

  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)

    const { data: outEdges } = await db()
      .from('forge_project_edges')
      .select('target_node_id')
      .eq('project_id', projectId)
      .eq('source_node_id', current)

    const targets = (outEdges || []).map(e => e.target_node_id)
    if (!targets.length) continue

    // Marcar solo forge_nodes (no text_input ni library_asset)
    await db()
      .from('forge_project_nodes')
      .update({ is_stale: true })
      .in('id', targets)
      .eq('node_type', 'forge_node')
      .eq('removed', false)

    queue.push(...targets)
  }
}

module.exports = { buildSystemPrompt, runReActLoop, propagateStale, injectVars, injectSkillVars }
