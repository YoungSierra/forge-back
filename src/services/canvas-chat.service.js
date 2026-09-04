'use strict'

// Lógica compartida entre el endpoint de chat y el auto-run

const { extractSection } = require('../utils/extract-section')

function injectVars(template, vars) {
  return template.replace(/\[(\w+)\]/g, (_, key) => vars[key] ?? `[${key}]`)
}

function injectSkillVars(template, vars) {
  let result = template.replace(/\[([^\]]+)\]/g, (match, key) => {
    const normalized = key.toLowerCase().replace(/\s+/g, '_')
    // Solo sustituir variables CONOCIDAS; corchetes no-variables ([REQUIRED], [PROJECTED],
    // [goal]…) se dejan intactos — antes se comían y rompían los marcadores del template.
    const known = Object.prototype.hasOwnProperty.call(vars, normalized) || Object.prototype.hasOwnProperty.call(vars, key)
    if (!known) return match
    const value = vars[normalized] ?? vars[key]
    return (value != null && value !== '') ? value : ''
  })
  result = result.replace(/\s*·\s*·\s*/g, ' · ')
  result = result.replace(/^\s*·\s*/gm, '')
  result = result.replace(/\s*·\s*$/gm, '')
  return result
}

// Cap alto por input: los docs estructurados que consume aguas abajo (mechanics_engineering
// → §B del TDD, GDD, visual_targets) deben llegar COMPLETOS. 120K chars ≈ 30K tokens/input.
const INPUT_CAP = 120000

// El asset guarda el nombre "<título del nodo> — <label del output>" TAL COMO ESTABAN el día que
// se generó, y v2.9.0 renombró títulos y labels ("UX / UI Design — Hud Layout" contra el actual
// "UX/UI Design — HUD Layout"). Normalizar (minúsculas, sin espacios) absorbe esa deriva sin
// aflojar el match. Lo usan los dos resolvedores: el de inputs del LLM y el del ensamblador.
const normAssetName = s => String(s || '').toLowerCase().replace(/\s+/g, '')

// Cap corto para outputs hermanos NO declarados como dependencia: son sólo un anclaje de estilo,
// no una fuente a transcribir. Los declarados en uses.siblings_if_present[] van con INPUT_CAP.
const ANCHOR_CAP = 2000

/**
 * Resuelve los inputs de un nodo del canvas para el system prompt: outputs de nodos upstream
 * conectados por edge (extrayendo la sección del output slot y aplicando el scoping
 * targetOutput.uses.inputs), imágenes PNG upstream, y library assets asignados explícitamente.
 *
 * Único resolvedor compartido entre el endpoint /chat (run real) y buildSystemPrompt (preview
 * /session), para que el preview refleje EXACTAMENTE lo que se genera. Antes existían dos copias
 * divergentes: el preview no extraía secciones y algunos inputs se truncaban a 3000 chars,
 * cortando docs estructurados (mechanics_engineering ~73KB) a la mitad de su 1ª sección.
 *
 * @returns {Promise<string[]>} bloques markdown "### label\ncontent" listos para el prompt.
 */
// `visualRefs` es una bolsa de salida: acá se anotan las referencias que el modelo tiene que
// VER, no solo leer. Va aparte del texto porque los strings resueltos alimentan el prompt y
// estas van como bloques de imagen. El llamador que no la pase sigue funcionando igual.
async function resolveNodeInputs(db, { projectId, currentPNodeId, targetOutput, visualRefs = [] }) {
  const resolvedInputs    = []
  const injectedPngUrls   = new Set()  // dedup PNG cuando hay múltiples edges del mismo nodo
  const seenInputKeys     = new Set()  // dedup por (nodo + output): cada output es un asset aparte
  const seenPngNodeIds    = new Set()  // inyectar PNGs una sola vez por nodo upstream

  // 1. Outputs de nodos conectados por edge
  let incomingEdges = []
  try {
    const { data: edgeData } = await db()
      .from('forge_project_edges')
      .select('source_node_id, source_handle, target_handle')
      .eq('project_id', projectId)
      .eq('target_node_id', currentPNodeId)
    incomingEdges = edgeData || []
  } catch { /* tabla no migrada aún */ }

  // Scoping por output: si el output declara uses.inputs[], inyectar SOLO esos inputs. Evita que
  // outputs mecánicos (ui_screens/scene_manifest) se contaminen con la narrativa (world/characters),
  // que trae nombres de mecánicas viejos y hace driftear al modelo.
  const usesInputs = targetOutput?.uses?.inputs ?? null
  if (usesInputs !== null && !usesInputs.length) {
    // `uses.inputs: []` es una declaración EXPLÍCITA de "este output no consume upstream": deriva
    // de sus siblings (p.ej. 3.8/gdd_ref sale de gdd_complete). Distinto de la clave ausente, que
    // significa "sin scoping" y deja pasar todo. No confundirlas: si acá dejáramos pasar los
    // genéricos, gdd_ref se comería ~350K de upstream que no le corresponden.
    incomingEdges = []
  } else if (usesInputs !== null) {
    // Un edge dibujado a mano nodo→nodo no lleva puerto: sus handles son 'out'/'in' pelados (los
    // tipados son 'out-<key>'/'in-<key>'). Contrastarlos contra uses.inputs los descartaba SIEMPRE
    // ⇒ el cable se veía en el canvas y no transmitía nada. Caso medido: el 30-jul el 3.8 sólo
    // tenía edges genéricos y resolvió 0 inputs, así que el LLM terminó pidiendo que le pegaran
    // los documentos a mano (feedback #4/#5 de Miguel).
    const portOf = e => {
      const th = e.target_handle || ''
      return th.startsWith('in-') ? th.slice(3) : null
    }
    // Nodos que YA entran por un puerto permitido: para esos, el edge genérico es redundante.
    const scopedSources = new Set(
      incomingEdges.filter(e => { const p = portOf(e); return p !== null && usesInputs.includes(p) })
                   .map(e => e.source_node_id)
    )
    incomingEdges = incomingEdges.filter(edge => {
      const port = portOf(edge)
      if (port !== null) return usesInputs.includes(port)
      // Genérico: honrarlo salvo que ese nodo ya aporte por un puerto declarado (evita duplicar).
      return !scopedSources.has(edge.source_node_id)
    })
  }

  for (const edge of incomingEdges) {
    // Dedup por (nodo + output): un nodo con varios outputs (p.ej. 3.9 → ui_screens, scene_manifest,
    // visual_targets) los guarda como assets SEPARADOS; deduplicar solo por nodo perdería todos menos uno.
    const outputKey = edge.source_handle?.startsWith('out-') ? edge.source_handle.slice(4) : null
    const dedupKey  = `${edge.source_node_id}::${outputKey ?? '*'}`
    if (seenInputKeys.has(dedupKey)) continue
    seenInputKeys.add(dedupKey)

    const { data: sourcePNode } = await db()
      .from('forge_project_nodes')
      .select(`
        node_id, node_type, source_asset_id,
        text_label, text_content,
        forge_nodes(title, outputs),
        forge_project_library_assets(display_name, extracted_text, storage_url, asset_type, mime_type)
      `)
      .eq('id', edge.source_node_id)
      .maybeSingle()
    if (!sourcePNode) continue

    if ((sourcePNode.node_type || 'forge_node') === 'library_asset') {
      const lib = sourcePNode.forge_project_library_assets
      if (!lib) continue
      if (lib.extracted_text) {
        const snippet = lib.extracted_text.slice(0, INPUT_CAP) + (lib.extracted_text.length > INPUT_CAP ? '\n[truncated]' : '')
        resolvedInputs.push(`### ${lib.display_name} (library asset)\n${snippet}`)
        // Un documento aporta su texto Y sus imágenes embebidas: el key art de un pitch es
        // contexto visual, no adorno.
        visualRefs.push({ label: lib.display_name, docUrl: lib.storage_url, docMime: lib.mime_type })
      } else if (lib.asset_type === 'image') {
        // La URL sigue en el texto (la usan el frontend y los tools). Lo que hace que el MODELO
        // la vea es esta anotación.
        resolvedInputs.push(`### ${lib.display_name} (image reference)\nURL: ${lib.storage_url}`)
        visualRefs.push({ label: lib.display_name, imageUrl: lib.storage_url })
      }
    } else if (sourcePNode.node_type === 'text_input') {
      const label   = sourcePNode.text_label   || 'Text Input'
      const content = (sourcePNode.text_content || '').trim()
      if (content) resolvedInputs.push(`### ${label}\n${content}`)
    } else {
      // Forge-node: resolver el asset del OUTPUT específico que referencia el edge. Cada output se
      // guarda como asset aparte con name = "${título} — ${label}", así que se busca por ese name.
      // Si no existe (docs legacy combinados en un solo asset con secciones ##), se cae al asset más
      // reciente del nodo + extractSection.
      const nodeTitle = sourcePNode.forge_nodes?.title ?? 'Upstream node'
      const outputs   = sourcePNode.forge_nodes?.outputs ?? []
      const outputDef = outputKey
        ? (outputs.find(o => (o.key || o.name) === outputKey) ?? outputs[parseInt(outputKey, 10)] ?? null)
        : null
      const outputLabel = outputDef ? (outputDef.label || outputDef.name || outputDef.key) : null

      let content   = null
      let slotLabel = nodeTitle

      // 1) Asset del output específico. Se identifica por el output_key de SU SESIÓN, que es el
      //    contrato; forge_assets no guarda el key, sólo un `name` de presentación
      //    ("<título> — <label>") congelado el día que se generó. Buscar por ese name se rompió
      //    con el rename de v2.9.0 — el asset dice "UX / UI Design — Hud Layout" y el DNA pide
      //    "UX/UI Design — HUD Layout" — y caía al fallback inyectando OTRO output por el puerto.
      //    El name normalizado queda de respaldo para assets viejos sin sesión por output.
      if (outputKey || outputLabel) {
        const { data: cand } = await db()
          .from('forge_assets')
          .select('name, content, forge_sessions!session_id(output_key, project_node_id)')
          .eq('project_id', projectId)
          .eq('node_id', sourcePNode.node_id)
          .in('status', ['approved', 'auto_approved'])
          .neq('format', 'png')
          .order('created_at', { ascending: false })

        // El asset se busca por `node_id` del catálogo, que con fan-out es el MISMO en todos los
        // lanes: sin acotar por instancia, el lane A puede quedarse con el documento del lane B —
        // gana el más reciente, que es el que corrió último. La sesión sí sabe de qué instancia
        // salió, así que se prefiere lo del lane propio y solo se acepta lo demás cuando el asset
        // no tiene instancia (sesiones viejas, anteriores al fan-out).
        const delLane = a => {
          const pn = a.forge_sessions?.project_node_id
          return !pn || pn === edge.source_node_id
        }
        const propios = (cand || []).filter(delLane)
        const want  = outputLabel ? normAssetName(`${nodeTitle} — ${outputLabel}`) : null
        const match = (outputKey && propios.find(a => a.forge_sessions?.output_key === outputKey))
                   || (want     && propios.find(a => normAssetName(a.name) === want))
        if (match?.content) {
          content   = match.content
          slotLabel = `${nodeTitle} → ${outputLabel || outputKey}`
        }
      }

      // 2) Fallback: asset más reciente del nodo (+ extractSection si el edge apunta a un output)
      if (content === null) {
        const { data: recientes } = await db()
          .from('forge_assets')
          .select('content, forge_sessions!session_id(project_node_id)')
          .eq('project_id', projectId)
          .eq('node_id', sourcePNode.node_id)
          .in('status', ['approved', 'auto_approved'])
          .neq('format', 'png')
          .order('created_at', { ascending: false })
        // Mismo criterio de lane que arriba: el respaldo no puede traer el documento del vecino.
        const recent = (recientes || []).find(a => {
          const pn = a.forge_sessions?.project_node_id
          return !pn || pn === edge.source_node_id
        })
        if (recent?.content) {
          content = recent.content
          const sectionKey = outputDef ? (outputDef.key || outputDef.name) : null
          const hermanas   = outputs.map(o => o.key || o.name).filter(Boolean)
          const extracted  = sectionKey ? extractSection(content, sectionKey, hermanas) : null
          if (extracted) {
            content   = extracted
            slotLabel = `${nodeTitle} → ${outputLabel || sectionKey}`
          }
        }
      }

      if (content !== null) {
        const snippet = content.slice(0, INPUT_CAP) + (content.length > INPUT_CAP ? '\n[truncated]' : '')
        resolvedInputs.push(`### ${slotLabel}\n${snippet}`)
      }

      // Imágenes PNG del nodo: inyectar una sola vez por INSTANCIA fuente. Deduplicar por
      // `node_id` mezclaba los lanes: el primero que pasara se quedaba con el cupo y los demás
      // heredaban sus imágenes.
      if (seenPngNodeIds.has(edge.source_node_id)) continue
      seenPngNodeIds.add(edge.source_node_id)

      // Imágenes PNG aprobadas/auto_approved del nodo upstream — las de ESTE lane
      const { data: pngTodos } = await db()
        .from('forge_assets')
        .select('name, storage_url, forge_sessions!session_id(project_node_id)')
        .eq('project_id', projectId)
        .eq('node_id', sourcePNode.node_id)
        .in('status', ['approved', 'auto_approved'])
        .eq('format', 'png')
        .not('storage_url', 'is', null)
      const pngAssets = (pngTodos || []).filter(a => {
        const pn = a.forge_sessions?.project_node_id
        return !pn || pn === edge.source_node_id
      })

      for (const png of (pngAssets || [])) {
        if (png.storage_url && !injectedPngUrls.has(png.storage_url)) {
          injectedPngUrls.add(png.storage_url)
          resolvedInputs.push(`### ${png.name} (generated image)\nURL: ${png.storage_url}`)
          visualRefs.push({ label: png.name, imageUrl: png.storage_url })
        }
      }

      // Fallback: si no hay PNGs en forge_assets, leer output_images de las sesiones aprobadas.
      // OJO: en el modelo per-output cada output vive en SU PROPIA sesión (ej. orientation_images y
      // image_prompts son sesiones distintas), así que hay que juntar output_images de TODAS.
      if ((pngAssets || []).length === 0) {
        const { data: sesionesTodas } = await db()
          .from('forge_sessions')
          .select('output_images, project_node_id, forge_nodes(title, outputs)')
          .eq('project_id', projectId)
          .eq('node_id', sourcePNode.node_id)
          .in('status', ['approved', 'auto_approved'])
          .order('created_at', { ascending: false })
        const approvedSessions = (sesionesTodas || [])
          .filter(s => !s.project_node_id || s.project_node_id === edge.source_node_id)

        if (approvedSessions?.length) {
          const nodeTitle2 = approvedSessions[0].forge_nodes?.title ?? sourcePNode.forge_nodes?.title ?? 'Node'
          // Cualquier output que GENERE imágenes, sea cual sea su formato. Exigir `format: png`
          // dejaba fuera a los documentos que incrustan las suyas —el `concept_seeds` del 1.1 y,
          // desde v2.9.13, el `pitch_document` del 2.1—: sus imágenes se producen, se guardan en
          // `output_images` bajo la clave del output y aguas abajo no las ve nadie. El formato dice
          // cómo se entrega el output, no si hubo imágenes.
          const pngOutputs = (approvedSessions[0].forge_nodes?.outputs || [])
            .filter(o => o.image_gen)
          // Merge de output_images de todas las sesiones (la primera no-vacía por clave; están ordenadas desc)
          const merged = {}
          for (const s of approvedSessions) {
            for (const [k, v] of Object.entries(s.output_images || {})) {
              if (merged[k] == null) merged[k] = v
            }
          }
          for (const outDef of pngOutputs) {
            const okey  = outDef.key || outDef.name  // los outputs usan 'key' (no 'name') -> output_images se indexa por key
            const items = Array.isArray(merged[okey]) ? merged[okey] : []
            for (const item of items) {
              const urls = Array.isArray(item.variations)
                ? item.variations.map(v => v.url).filter(Boolean)
                : item.image_url ? [item.image_url] : []
              for (const url of urls) {
                if (!injectedPngUrls.has(url)) {
                  injectedPngUrls.add(url)
                  resolvedInputs.push(`### ${nodeTitle2} — ${outDef.label || okey} (generated image)\nURL: ${url}`)
                }
              }
            }
          }
        }
      }
    }
  }

  // 2. Library assets asignados explícitamente al nodo
  const { data: libInputs } = await db()
    .from('forge_project_node_inputs')
    .select(`input_label, forge_project_library_assets(display_name, extracted_text, storage_url, asset_type, mime_type)`)
    .eq('project_node_id', currentPNodeId)
    .eq('source_type', 'library_asset')
    .order('order_index')

  for (const inp of (libInputs || [])) {
    const lib = inp.forge_project_library_assets
    if (!lib) continue
    if (lib.extracted_text) {
      const snippet = lib.extracted_text.slice(0, INPUT_CAP) + (lib.extracted_text.length > INPUT_CAP ? '\n[truncated]' : '')
      resolvedInputs.push(`### ${lib.display_name} (external reference)\n${snippet}`)
      visualRefs.push({ label: lib.display_name, docUrl: lib.storage_url, docMime: lib.mime_type })
    } else if (lib.asset_type === 'image') {
      resolvedInputs.push(`### ${lib.display_name} (image reference)\nURL: ${lib.storage_url}`)
      visualRefs.push({ label: lib.display_name, imageUrl: lib.storage_url })
    }
  }

  return resolvedInputs
}

/**
 * Construye el system prompt completo para un nodo dado.
 * Devuelve { finalSystemPrompt, baseUserMsg, executorStr, activeTools, outputDefs, resolvedInputs }
 */
/**
 * Resuelve SOBRE QUÉ instancia de nodo se está trabajando.
 *
 * Con fan-out un mismo `node_id` del catálogo vive en varios lanes, así que la consulta por
 * `node_id` devuelve más de una fila. `maybeSingle()` en ese caso NO devuelve la primera: devuelve
 * `data: null` con error PGRST116. Como el error se descartaba, el nodo se quedaba sin inputs en
 * silencio y el modelo terminaba pidiendo a mano lo que ya estaba conectado — medido el 20-ago en
 * Smack JM V2, donde el 2.4 del lane A dijo «I don't have concept data» con el cable puesto y el
 * documento aprobado. Afectaba a 15 de 43 proyectos.
 *
 * Con `projectNodeId` no hay nada que adivinar. Sin él, una sola instancia es inequívoca; varias
 * son un error del llamador, y se dice.
 */
async function resolverInstancia(db, { projectId, nodeId, projectNodeId = null, select = 'id' }) {
  if (projectNodeId) {
    const { data } = await db().from('forge_project_nodes').select(select).eq('id', projectNodeId).maybeSingle()
    if (data) return data
  }
  const { data: filas } = await db()
    .from('forge_project_nodes').select(select)
    .eq('project_id', projectId).eq('node_id', nodeId).eq('removed', false)
  if (!filas?.length) return null
  if (filas.length > 1) {
    throw new Error(
      `Este nodo tiene ${filas.length} instancias en el proyecto (fan-out por lane): ` +
      'hace falta project_node_id para saber cuál se está ejecutando.',
    )
  }
  return filas[0]
}

async function buildSystemPrompt(db, { projectId, nodeId, sessionId, userMessage, historyMsgs = [], attachmentParts = [], targetOutputKey = null, projectNodeId = null }) {
  const { getPrompt, getSkill } = require('./prompt.service')

  const { data: node } = await db()
    .from('forge_nodes')
    .select('id, node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt, standalone_prompt, role, executor')
    .eq('id', nodeId)
    .single()

  if (!node) throw new Error(`Node not found: ${nodeId}`)

  // Normaliza outputs — soporta formato nuevo {key} y legado {name}
  const normalizeOutput = o => ({ ...o, key: o.key || o.name, label: o.label || o.name || o.key })
  const outputDefs = (Array.isArray(node.outputs) ? node.outputs : []).map(normalizeOutput)

  // Output específico siendo trabajado (modo output enfocado)
  const targetOutput = targetOutputKey
    ? outputDefs.find(o => o.key === targetOutputKey) ?? null
    : null

  // Detecta si hay inputs wired disponibles para este nodo
  const wiredInputDefs = Array.isArray(node.inputs?.wired) ? node.inputs.wired : []
  const directContext  = node.inputs?.direct_context || ''

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

  // Prompt base: v1.4.0 — nodo default_prompt como base compartida + output prompt encima
  let basePrompt = null
  if (targetOutput) {
    const nodePart = node.default_prompt ? injectVars(node.default_prompt, templateVars) : null
    const outPart  = targetOutput.prompt  ? injectVars(targetOutput.prompt,  templateVars) : null
    basePrompt = [nodePart, outPart].filter(Boolean).join('\n\n')
  } else if (node.default_prompt) {
    basePrompt = injectVars(node.default_prompt, templateVars)
  } else if (r2Prompt) {
    basePrompt = injectVars(r2Prompt, templateVars)
  }

  // Qué outputs mostrar en el system prompt
  const activeOutputDefs = targetOutput ? [targetOutput] : outputDefs

  let layer1 = null

  if (basePrompt) {
    layer1 = basePrompt

    // ── El contrato de CADA output, también corriendo el nodo entero ───────────────────────────
    // En modo focus el prompt del output se apila sobre el default (arriba). Sin foco no se
    // mandaba ninguno: el modelo recibía el resumen del nodo y nunca el contrato de sus salidas
    // —dónde va el bloque de emisión, qué campos lleva el plan, cómo se escriben las anclas—.
    //
    // Medido el 28-08 en 2.2: el modelo respondió «this node's contract does not declare image_gen
    // outputs» y emitió []. Tenía razón desde lo que veía. La misma ceguera explica los sobres que
    // faltaron toda la tarde y las tres maquetaciones distintas del plan.
    if (!targetOutput) {
      const contratos = outputDefs
        .filter(o => o.prompt)
        .map(o => `### ${o.key}${o.format ? ` (${o.format})` : ''}\n${injectVars(o.prompt, templateVars)}`)
      if (contratos.length) {
        layer1 += '\n\n## Output contracts\n'
          + 'Each section below is the contract of one output of this node. Produce every one of them, '
          + 'each opened by a level-2 heading with its exact name, and honor its contract in full.\n\n'
          + contratos.join('\n\n')
      }
    }
  } else {
    const outputsBlock = activeOutputDefs.length
      ? activeOutputDefs.map(o => {
          const name   = o.key || o.name || ''
          const format = o.format || null
          const desc   = o.description || null
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

  // Modo standalone: no hay inputs wired definidos o el nodo lo requiere explícitamente
  if (node.standalone_prompt) {
    layer1 += `\n\n## Standalone mode\n${node.standalone_prompt}`
    if (directContext) {
      layer1 += `\n\nIf the user hasn't provided context yet, ask them: "${directContext}"`
    }
  }

  // Modo output enfocado: indicar claramente qué output se está trabajando
  if (targetOutput) {
    layer1 += `\n\n## Current target output\nYou are working specifically on: **${targetOutput.label}** (${targetOutput.key}).\nFocus your response on producing this output. Other outputs of this node are available as context but are not the current target.`
  }

  const skillDefs  = Array.isArray(node.skills) ? node.skills : []
  const skillTexts = await Promise.all(skillDefs.map(s => getSkill(s)))
  const skillsBlock = skillDefs
    .map((s, i) => {
      if (!skillTexts[i]) return ''
      const filledText = injectSkillVars(skillTexts[i], skillVars)
      return `\n## Skill Reference: ${s}\n> This is a GUIDE for HOW to build the output — it is NOT the output. Do NOT reproduce the guide itself: never output its own meta-sections (e.g. "When to use this", "Inputs", "Method", "Principles", "Worked example", "Output checklist", "Common mistakes", "Companion artifacts", "Playbook / Method", "A/B/C" headers) nor its instructions or examples. Produce the deliverable the task asks for, following this guidance. Only reuse EXACT field/section labels when the guide explicitly lists the fields of the DELIVERABLE itself (e.g. a GDD template's fields) — never the guide's own section names.\n\n${filledText}`
    })
    .filter(Boolean).join('\n')

  const outputNames  = activeOutputDefs.map(o => o.key || o.name).filter(Boolean)
  const nodeHasTools = Array.isArray(node.tools) && node.tools.length > 0

  const FORMAT_HINTS = {
    structured:      'Output a FLAT numbered list ONLY — no subheadings, no category labels, no prose introduction. Each item MUST follow this exact format: `- Variation N: Name: brief description`',
    markdown_table:  'MUST be a markdown table with header row and `|---|` separator row.',
    single_sentence: 'Single sentence only — no markdown, no line breaks, no bullets.',
  }
  const outputFormatLines = activeOutputDefs
    .filter(o => typeof o === 'object' && (o.key || o.name) && FORMAT_HINTS[o.format])
    .map(o => `- **${o.key || o.name}**: ${FORMAT_HINTS[o.format]}`)

  const formatInstr = outputNames.length && !nodeHasTools
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

  const currentPNode = await resolverInstancia(db, { projectId, nodeId, projectNodeId })

  const visualRefs = []   // referencias que el modelo tiene que VER (ver vision.service)
  const resolvedInputs = currentPNode
    ? await resolveNodeInputs(db, { projectId, currentPNodeId: currentPNode.id, targetOutput, visualRefs })
    : []

  const { getToolsBlock, getDocPolicyBlock } = require('./tools.service')
  const activeTools      = Array.isArray(node.tools) && node.tools.length ? node.tools : []
  const llmVisibleTools  = activeTools.filter(t => t !== 'doc_gen_docx')
  const toolsBlock       = getToolsBlock(llmVisibleTools)

  // Outputs existentes del mismo nodo como contexto (excluye el target actual)
  const existingNodeOutputs = []
  if (projectId && nodeId) {
    const { data: nodeAssets } = await db()
      .from('forge_assets')
      .select('name, content, format')
      .eq('project_id', projectId)
      .eq('node_id', nodeId)
      .in('status', ['approved', 'auto_approved'])
      .neq('format', 'png')
      .order('created_at', { ascending: false })

    // El asset se llama "NodeTitle — OutputLabel", NUNCA el output_key: hay que reconstruir ese
    // nombre para poder matchear. (Antes se comparaba contra name.replace(/\s+/g,'_'), que produce
    // "core_gameplay_—_mechanic_specs" y no matcheaba NUNCA un siblings_if_present:["mechanic_specs"]
    // ⇒ el filtro no filtraba y todo hermano entraba truncado a 2000.)
    const labelOf = o => (typeof o === 'object' ? (o.label || o.name || o.key) : o)
    const assetNameFor = key => {
      const od = outputDefs.find(o => (o.key || o.name) === key)
      return `${node.title} — ${labelOf(od || key)}`.toLowerCase().trim()
    }

    // Se aceptan LAS DOS claves: el DNA histórico usa `siblings_if_present`, pero los outputs que
    // trajo v2.9.0 (3.8/gdd_complete, 3.9/add_source_md + ADIs, 3.12/tdd_complete, 3.13/vs_spec_*)
    // declaran `siblings`. Leyendo sólo la primera, esos 12 outputs caían al else — que EXCLUYE los
    // outputs propios del nodo — y por lo tanto NO veían su fuente declarada ni una vez (misma
    // falla que el 3.2 en bug_32_divergencia_mechanics, reintroducida por la clave equivocada).
    const siblingsAllowed = targetOutput?.uses?.siblings_if_present ?? targetOutput?.uses?.siblings ?? null
    if (siblingsAllowed && siblingsAllowed.length) {
      // Dependencia explícita: va COMPLETO. Truncarlo a 2000 hacía que el output re-derivara de cero
      // lo que no alcanzaba a ver (caso 3.2: mechanics_engineering veía el 7% de mechanic_specs).
      const wantNames = new Set(siblingsAllowed.map(assetNameFor))
      for (const asset of (nodeAssets || [])) {
        if (!wantNames.has((asset.name || '').toLowerCase().trim())) continue
        const c = asset.content || ''
        if (!c) continue
        const snippet = c.slice(0, INPUT_CAP) + (c.length > INPUT_CAP ? '\n[truncated]' : '')
        existingNodeOutputs.push(`### ${asset.name} (this node — declared dependency)\n${snippet}`)
      }
    } else {
      // Default: NO re-inyectar los outputs PROPIOS del nodo — al regenerar, mostrarle al modelo su
      // salida anterior lo ancla a la estructura vieja y la copia, pisando el field-spec del skill.
      const ownOutputAssetNames = new Set(outputDefs.map(o => `${node.title} — ${labelOf(o)}`.toLowerCase().trim()))
      for (const asset of (nodeAssets || [])) {
        if (ownOutputAssetNames.has((asset.name || '').toLowerCase().trim())) continue
        const snippet = (asset.content || '').slice(0, ANCHOR_CAP)
        if (snippet) existingNodeOutputs.push(`### ${asset.name} (this node — existing output)\n${snippet}`)
      }
    }
  }

  const layer2Parts = [
    projectMeta              ? `## Project context\n${projectMeta}`                                : '',
    resolvedInputs.length    ? `## Input references\n${resolvedInputs.join('\n\n')}`               : '',
    existingNodeOutputs.length ? `## Existing outputs from this node\n${existingNodeOutputs.join('\n\n')}` : '',
  ].filter(Boolean)

  // Fecha actual para el LLM (mismo criterio que el handler de chat): evita que use su corte de
  // entrenamiento en afirmaciones time-sensitive (ej. "as of June 2025" en un scan competitivo).
  const dateBlock = `The current date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Use it as "today" for any time-sensitive or recency statement (market data, "as of", "current year", competitive scans); do NOT rely on your training cutoff.`
  // ── De qué juego estamos hablando, ANTES de las plantillas ──────────────────────────────────
  //
  // Los skills se cargan en `layer1` y los datos del proyecto van después. En el 2.5 eso son 38.826
  // caracteres de plantillas genéricas de deck antes de que el modelo se entere de qué juego es:
  // `concept_data` empezaba en el carácter 49.813 de 75.587. Íntegro, sin truncar, con 35
  // menciones de «medusa» — y el modelo igual se quedó con el título «Atelier of Bells» y escribió
  // un simulador de fundición de campanas, con su paleta de bronce y Unreal 5.
  //
  // No es cosa de un modelo: cualquiera que lea cincuenta mil caracteres de instrucciones antes
  // del tema va a rellenar. Se antepone la identidad en unas líneas. Sale de los inputs ya
  // resueltos —no se vuelve a consultar nada— y si no hay de dónde, no se pone nada.
  const anclaIdentidad = (() => {
    const CAMPOS = ['title', 'one_liner', 'elevator_line', 'genre', 'setting', 'core_fantasy', 'palette']
    for (const bloque of resolvedInputs) {
      const m = /\{[\s\S]*\}/.exec(String(bloque || ''))
      if (!m) continue
      let o = null
      try { o = JSON.parse(m[0]) } catch { continue }
      if (!o || typeof o !== 'object' || !o.title) continue
      const lineas = []
      for (const k of CAMPOS) {
        const v = o[k] ?? o.fact_sheet?.[k]
        if (typeof v === 'string' && v.trim()) lineas.push(`${k.replace(/_/g, ' ')}: ${v.trim().slice(0, 300)}`)
        else if (Array.isArray(v) && v.length) lineas.push(`${k.replace(/_/g, ' ')}: ${v.filter(x => typeof x === 'string').join(' · ').slice(0, 300)}`)
      }
      if (lineas.length < 2) continue
      return '## The game this node is working on\n'
        + 'Everything below — templates, grammars, examples — is generic. THIS is the game. If any\n'
        + 'instruction and these facts disagree, these facts win. Never infer the game from its title.\n\n'
        + lineas.join('\n')
    }
    return ''
  })()

  const systemPrompt = [dateBlock, anclaIdentidad, layer1, ...layer2Parts, toolsBlock, getDocPolicyBlock(activeTools)].filter(Boolean).join('\n\n')

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

  return { finalSystemPrompt, baseUserMsg, executorStr, activeTools, outputDefs, resolvedInputs, visualRefs, node, targetOutput }
}

/**
 * Ejecuta el ReAct loop: LLM + herramientas.
 * Devuelve { replyText, allToolCalls, docUrl, docFormat, meta }
 */
// Título de un ítem, normalizado para comparar entre nodos: el 1.4 reescribe el formato pero
// conserva el nombre ("**SMACK: Drift**", "1. SMACK: Drift", "SMACK: Drift —" son el mismo).
const tituloDeItem = s => String(s || '')
  .replace(/^[\s\-*#>]+/, '')
  .replace(/^\d+[.)]\s*/, '')
  .replace(/\*+/g, '')
  .split(/\s+[—–-]\s+|\n/)[0]
  .split(':').slice(0, 2).join(':')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Imágenes para incrustar al pie de cada ítem del documento, en el orden en que salen.
 *
 * Primero las propias: un output con `image_gen` guarda una por ítem en `output_images`, por
 * índice. Si no tiene —el caso del 1.4, que selecciona pero no genera— se buscan AGUAS ARRIBA,
 * en los nodos que lo alimentan, y se emparejan POR TÍTULO.
 *
 * El título y no el índice porque un nodo de selección devuelve un subconjunto y puede
 * reordenarlo: de cinco seeds, si sobreviven el 2º y el 5º, el índice 0 del documento sería el
 * seed 1 del origen y le pondríamos la imagen de otro. Sin coincidencia de título no se pone
 * nada — un ítem sin imagen es mejor que un ítem con la imagen equivocada.
 */
async function resolverImagenesDeItems({ db, projectId, nodeId, sessionId, outKey, contenido }) {
  const parseItems = txt => require('./fan-out.service').parseItemsFromContent(txt || '')
  const imagenes = []

  // 1) Propias. Sin `output_key` —las sesiones generales, las de antes del modelo por output— no
  //    hay una clave que buscar en `output_images`, pero eso no quita que aguas arriba haya
  //    imágenes: antes se cortaba acá y esos documentos salían siempre sin nada.
  if (sessionId) {
    const { data: propia } = await db().from('forge_sessions')
      .select('output_images, project_node_id').eq('id', sessionId).maybeSingle()

    // Las imágenes de un output pueden NO estar en esta sesión: el despacho del run del nodo
    // entero las guarda en la sesión del propio output. Se juntan las dos, la del output encima,
    // o el documento sale pelado teniendo las imágenes al lado. Medido: 4 generadas, 0 en el PDF.
    let mezcla = { ...(propia?.output_images || {}) }
    if (propia?.project_node_id) {
      const { data: porOutput } = await db().from('forge_sessions')
        .select('output_key, output_images, created_at')
        .eq('project_node_id', propia.project_node_id).not('output_key', 'is', null)
        .order('created_at')
      for (const s of porOutput || []) mezcla = { ...mezcla, ...(s.output_images || {}) }
    }
    const sess = { output_images: mezcla }

    // Con `output_key` se mira esa clave; SIN ella —el nodo corrido entero— se miran TODAS las de
    // la sesión. Antes este paso se salteaba por completo cuando la clave era null, así que un
    // documento que había generado sus propias imágenes salía sin ninguna: estaban guardadas ahí
    // al lado y nadie las miraba. Medido el 26-08 en el 2.1: 4 imágenes en la sesión, 0 en el PDF.
    const claves = outKey ? [outKey] : Object.keys(sess?.output_images || {})

    // De qué sección salen los títulos. Un documento que declara un hermano —el pitch declara su
    // plan de imágenes— numera contra las entradas de ESE hermano, no contra su propia prosa.
    const { data: dna } = await db().from('forge_nodes').select('outputs').eq('id', nodeId).maybeSingle()
    const defs = dna?.outputs || []
    // El ancla de un output: su clave como encabezado, con o sin negrita.
    const anclaDe = clave => new RegExp(`^#{1,4}\\s+\\*{0,2}\\s*${clave}\\b`, 'im')
    const seccionDe = clave => {
      const def = defs.find(o => (o.key || o.name) === clave)
      const decl = (def?.uses?.siblings_if_present ?? def?.uses?.siblings ?? []).find(k => /plan$/i.test(k))
      if (!decl) return contenido
      const ini = anclaDe(decl).exec(contenido)
      if (!ini) return contenido
      const desde = contenido.slice(ini.index + ini[0].length)
      const cortes = defs.map(o => o.key || o.name).filter(k => k !== decl)
        .map(k => anclaDe(k).exec(desde))
        .filter(Boolean).map(r => r.index)
      return desde.slice(0, cortes.length ? Math.min(...cortes) : desde.length).trim() || contenido
    }

    // Los títulos salen del parser de ÍTEMS, no del de fan-out: las entradas del plan son
    // encabezados-identificador (`### pitch_01_hook`) y el de fan-out no los reconoce, así que
    // devolvía título vacío y las imágenes quedaban sin ancla — se apilaban al principio del PDF
    // en vez de ir cada una en su sección.
    // La propia sección del output, sin pasar por el hermano. Es donde viven los marcadores.
    const seccionPropia = clave => {
      const ini = anclaDe(clave).exec(contenido)
      if (!ini) return ''
      const desde = contenido.slice(ini.index + ini[0].length)
      const cortes = defs.map(o => o.key || o.name).filter(k => k !== clave)
        .map(k => anclaDe(k).exec(desde)).filter(Boolean).map(r => r.index)
      return desde.slice(0, cortes.length ? Math.min(...cortes) : desde.length)
    }

    // Los ids que el propio documento escribe en sus huecos: «[ IMAGE: pitch_01_hook — … ]».
    // Es la única fuente EXACTA que hay — el id lo puso el modelo, no lo adivinamos raspando
    // encabezados. Sacar los títulos del plan hermano fallaba en 3 de 4 (títulos vacíos) y las
    // imágenes terminaban ancladas al plan, no al pitch. Si el documento no trae marcadores se
    // sigue con el plan, que es lo que necesitan los documentos que no los usan.
    const { idsDeAnclas: idsDeMarcadores } = require('./anchor.format')

    const { parseOutputItems, cleanItemText } = require('./image-gen.service')
    for (const clave of claves) {
      const marcas  = idsDeMarcadores(seccionPropia(clave))
      const propios = marcas.length
        ? marcas.map(t => ({ title: t }))
        : parseOutputItems(seccionDe(clave), 'markdown')
            .map(t => ({ title: (cleanItemText(t).split(String.fromCharCode(10)).filter(Boolean)[0] || '') }))
      for (const it of (sess?.output_images?.[clave] || [])) {
        const url = it?.variations?.length ? it.variations[it.variations.length - 1]?.url : it?.url
        const src = propios[it?.index]
        if (url) imagenes.push({ title: it?.name ?? src?.title ?? src ?? '', url })
      }
    }

    // 1b) Las del HERMANO que genera imágenes. Un documento puede no producir ninguna y aun así
    //     tener que llevarlas: el `concept_document` del 2.2 no genera, y su hermano
    //     `development_images` sí. Antes había que pasárselas a mano.
    //
    //     Y dónde va cada una NO hay que preguntárselo a nadie: el hermano ya lo escribe. Cuando
    //     declara una imagen emite `"placement": "Signature Mechanics section, adjacent to
    //     Pillar 1"`. Se resuelve contra los encabezados del documento y la imagen cae ahí.
    //     Sin `placement` se usa su etiqueta, que es el comportamiento de antes.
    if (outKey && !imagenes.length) {
      const hermanos = (defs.find(o => (o.key || o.name) === outKey)?.uses?.siblings_if_present
                     ?? defs.find(o => (o.key || o.name) === outKey)?.uses?.siblings ?? [])
        .filter(k => defs.find(o => (o.key || o.name) === k)?.image_gen)

      for (const hermano of hermanos) {
        let { data: sh } = await db().from('forge_sessions')
          .select('output_images, output_asset_id')
          .eq('project_id', projectId).eq('node_id', nodeId).eq('output_key', hermano)
          .in('status', ['approved', 'auto_approved']).maybeSingle()

        // Corriendo el nodo ENTERO no hay sesión por output: las imágenes del hermano quedan en
        // la general, bajo su clave. Mirar solo la sesión por output dejaba el documento sin una
        // sola imagen teniéndolas al lado — medido en 2.2: 3 generadas, 0 en el PDF.
        if (!Object.keys(sh?.output_images || {}).length) {
          const { data: sg } = await db().from('forge_sessions')
            .select('output_images, output_asset_id, id')
            .eq('project_id', projectId).eq('node_id', nodeId).is('output_key', null)
            .order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (sg?.output_images?.[hermano]) sh = { output_images: { [hermano]: sg.output_images[hermano] }, output_asset_id: sg.output_asset_id }
        }

        // `name` es el id con el que se generó la imagen —el mismo que el documento pone en su
        // ancla—. El despachador lo guarda ahí; ignorarlo obligaba a reconstruir el título por
        // etiqueta («Development Images 1») y entonces ningún marcador coincidía: el motor
        // incrustaba bien y el PDF pedido a mano salía sin nada.
        const urls = Object.values(sh?.output_images || {}).flat()
          .map(it => ({
            i: it.index,
            id: it?.name || null,
            url: it?.variations?.length ? it.variations[it.variations.length - 1]?.url : it?.url,
          }))
          .filter(x => x.url)
        if (!urls.length) continue

        // La declaración del hermano, con su `placement`.
        let decl = []
        if (sh?.output_asset_id) {
          const { data: ah } = await db().from('forge_assets').select('content').eq('id', sh.output_asset_id).maybeSingle()
          const txt = ah?.content || ''
          // El sobre del hermano NO es necesariamente el primer bloque json: en el nodo entero la
          // respuesta trae antes el documento en json (concept_data). Se busca el bloque que
          // nombra al hermano; si no hay, se cae al primero, como antes.
          const conClave = new RegExp('```(?:json)?\\s*(\\{[\\s\\S]*?"' + hermano + '"[\\s\\S]*?\\})\\s*```', 'i').exec(txt)
          const m = conClave || /```(?:json)?\s*([\s\S]*?)```/.exec(txt)
          try {
            const j = JSON.parse(m?.[1] ?? '')
            decl = Array.isArray(j?.[hermano]) ? j[hermano] : (Array.isArray(j) ? j : [])
          } catch { /* sin declaración: se cae a la etiqueta */ }
        }

        // Los encabezados de ESTE documento. Gana el más largo que aparezca dentro del texto del
        // placement: así «Signature Mechanics» le gana a «Mechanics» sin adivinar la redacción.
        const encabezados = String(contenido).split('\n')
          .filter(l => /^#{1,4}\s+\S/.test(l))
          .map(l => l.replace(/^#{1,4}\s+/, '').replace(/\*/g, '').trim())
        const seccionDePlacement = p => {
          const t = String(p || '').toLowerCase()
          let mejor = null
          for (const h of encabezados) if (t.includes(h.toLowerCase()) && (!mejor || h.length > mejor.length)) mejor = h
          return mejor
        }

        const etiqueta = defs.find(o => (o.key || o.name) === hermano)?.label || hermano
        for (const u of urls) {
          const d = decl[u.i]
          // El id con el que se generó manda: es el que el documento ancló.
          imagenes.push({ title: u.id || seccionDePlacement(d?.placement) || d?.label || `${etiqueta} ${u.i + 1}`, url: u.url })
        }
      }
    }

    // NO se cae a `concept_data.approved_images[]`. Esas son las imágenes de REFERENCIA que llegan
    // de arriba —el hilo visual—, el insumo del que este nodo deriva las suyas: misma paleta, mismo
    // registro. Incrustarlas cuando el nodo no generó las propias produce un documento que parece
    // correcto y no lo es, y de paso tapa el fallo que hay que ver: que no se emitió el sobre.
    // Un documento vacío se revisa; uno lleno de las imágenes equivocadas, no.
    if (imagenes.length) return imagenes
  }

  // 2) Heredadas: se arma el índice título → imagen con lo que produjeron los nodos upstream.
  //
  // La instancia se saca de la SESIÓN, que ya sabe en qué lane está. Buscarla por `node_id` con
  // `maybeSingle()` fallaba en cuanto el nodo vivía en dos lanes —devuelve PGRST116 y `null`— y
  // esta función cortaba acá: los PDF del 2.1 salían sin ninguna imagen incrustada, en los dos
  // lanes, mientras que en un proyecto sin fan-out funcionaba.
  let pnode = null
  if (sessionId) {
    const { data: ses } = await db().from('forge_sessions')
      .select('project_node_id').eq('id', sessionId).maybeSingle()
    if (ses?.project_node_id) {
      const { data: p } = await db().from('forge_project_nodes')
        .select('id, bound_item_ref').eq('id', ses.project_node_id).maybeSingle()
      pnode = p ?? { id: ses.project_node_id }
    }
  }
  if (!pnode) pnode = await resolverInstancia(db, { projectId, nodeId, select: 'id, bound_item_ref' }).catch(() => null)
  if (!pnode) return imagenes

  // Se sube por el grafo hasta encontrar quién generó. Antes solo se miraba UN salto: para el 2.1,
  // eso es el 1.4, que selecciona pero no genera — y las imágenes viven en el 1.1, un nivel más
  // arriba. Se devolvía cero y el PDF salía sin nada.
  //
  // El emparejamiento sigue siendo por TÍTULO, que es lo que hace seguro atravesar un nodo de
  // selección: de cinco seeds sobreviven dos, y cada documento se queda con la imagen del suyo.
  // Tres niveles alcanzan de sobra para 1.1 → 1.4 → 2.x y frenan cualquier ciclo.
  const MAX_NIVELES = 3
  const porTitulo = new Map()
  let frontera = [pnode.id]
  const vistos = new Set(frontera)

  for (let nivel = 0; nivel < MAX_NIVELES && frontera.length && !porTitulo.size; nivel++) {
    const { data: edges } = await db().from('forge_project_edges')
      .select('source_node_id').eq('project_id', projectId).in('target_node_id', frontera)
    const siguiente = []

    for (const e of (edges || [])) {
      if (vistos.has(e.source_node_id)) continue
      vistos.add(e.source_node_id)
      siguiente.push(e.source_node_id)

      const { data: src } = await db().from('forge_project_nodes')
        .select('node_id').eq('id', e.source_node_id).maybeSingle()
      if (!src?.node_id) continue

      const { data: sesiones } = await db().from('forge_sessions')
        .select('output_key, output_images, output_asset_id')
        .eq('project_id', projectId).eq('node_id', src.node_id)
        .not('output_images', 'is', null)
      if (!sesiones?.length) continue

      // El texto de los ítems del origen, para saber a qué título corresponde cada índice. Una vez
      // por nodo: antes se pedía dentro del bucle de outputs, repitiendo la misma consulta.
      const { data: asset } = await db().from('forge_assets')
        .select('content').eq('project_id', projectId).eq('node_id', src.node_id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      const origen = asset?.content ? parseItems(asset.content) : []

      for (const s of sesiones) {
        for (const items of Object.values(s.output_images || {})) {
          for (const it of (items || [])) {
            const url = it?.variations?.length ? it.variations[it.variations.length - 1]?.url : it?.url
            const t   = tituloDeItem(origen[it?.index]?.title ?? origen[it?.index] ?? '')
            if (url && t) porTitulo.set(t, url)
          }
        }
      }
    }
    frontera = siguiente
  }
  if (!porTitulo.size) return imagenes

  // Y ahora, en el orden de ESTE documento: solo los ítems que sobrevivieron.
  // Solo los ítems que sobrevivieron en ESTE documento, en su orden.
  for (const it of parseItems(contenido)) {
    const t = tituloDeItem(it?.title ?? it)
    const u = t ? porTitulo.get(t) : null
    if (u) imagenes.push({ title: it?.title ?? it, url: u })
  }

  // Un nodo de lane no enumera los ítems de arriba: habla de UNO. El pitch del 2.1 no tiene una
  // sección por seed —tiene el logline de su seed—, así que emparejar por título del documento no
  // encuentra nada. Lo que le corresponde es la imagen de SU ítem, que es lo que dice
  // `bound_item_ref`: por eso el lane A lleva la de «SMACK: Drift» y el B la de «SMACK: The
  // Current», sin riesgo de cruzarlas.
  const atado = pnode.bound_item_ref?.title
  if (!imagenes.length && atado) {
    const u = porTitulo.get(tituloDeItem(atado))
    if (u) imagenes.push({ title: atado, url: u })
  }
  return imagenes
}

// `signal` es opcional y va DECLARADO: el corte por Stop lo usa dentro del bucle, y sin estar en
// la firma cualquier llamada moría con «ReferenceError: signal is not defined» en la primera
// iteración. Los dos que llaman —el Run por output y el de imagen— no lo pasan, así que el Run
// quedó roto entero desde que se añadió el corte.
async function runReActLoop({ finalSystemPrompt, baseUserMsg, executorStr, activeTools, resolvedInputs = [], visualRefs = [], projectId, nodeId, nodeName = '', sessionId = null, targetOutput = null, signal = null }) {
  const { db } = require('./supabase.service')
  const { callLLM }                          = require('./llm.service')
  const { parseToolCalls, executeTool }      = require('./tools.service')

  const MAX_TOOL_ITERS = 5
  // Lo ya ejecutado en ESTA corrida, por firma. Vive fuera del bucle: el modelo puede repetir
  // la misma llamada en iteraciones distintas, no solo dentro de una.
  const yaEjecutadas = new Map()
  let currentUserMsg   = baseUserMsg
  let replyText        = ''
  let allToolCalls     = []
  let meta             = null
  let docUrl           = null
  let docFormat        = null

  // Se bajan UNA vez, antes del bucle: reenviarlas en cada iteración de herramientas
  // multiplicaría el costo de input sin agregar nada nuevo a la conversación.
  const { collectVisualRefs } = require('./vision.service')
  const { images: visionImages, nota: visionNota } = await collectVisualRefs(visualRefs)
  if (visionNota) currentUserMsg += visionNota

  for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
    // Entre iteraciones también: el bucle puede llamar al LLM hasta cinco veces, y sin este corte
    // apretar Stop en la primera igual pagaba las otras cuatro.
    if (signal?.aborted) { const e = new Error('cancelado por el usuario'); e.code = 'ABORTED'; throw e }
    const result = await callLLM(finalSystemPrompt, currentUserMsg, {
      signal,
      images: visionImages,
      // 16K de techo: documentos largos (GDD 14 secciones, TDD) se truncaban con 8192.
      // Es un límite, no un objetivo — solo se paga por lo generado; 16384 es seguro
      // cross-provider (32K excede el cap de salida de algunos modelos groq/openai).
      model: executorStr, rawText: true, temperature: 0.7, maxOutputTokens: 64000,
    })
    meta      = result.meta
    replyText = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)

    const calls = activeTools.length ? parseToolCalls(replyText) : []
    if (!calls.length) break

    const toolResultParts = []
    for (const tc of calls) {
      // ── Una herramienta no se ejecuta dos veces por lo mismo en la misma corrida ──────────────
      //
      // El bucle ejecutaba cada llamada que el modelo emitiera, sin memoria. Medido el 02-09 en el
      // 2.5: trece `doc_gen_pptx` seguidos, uno cada dos o tres segundos, trece PPTX de doce
      // diapositivas — y el modelo aún no había escrito su respuesta. El resultado que se le
      // devuelve ya le dice «no repitas el contenido»; la instrucción no bastó.
      //
      // Los generadores de documento se limitan a UNO por corrida: un nodo produce un documento
      // por output, y una segunda llamada es el modelo repitiéndose, no un segundo documento. Las
      // demás herramientas se deduplican por argumentos, que es lo que distingue «otra búsqueda»
      // de «la misma búsqueda otra vez».
      const esDoc = /^doc_gen_/.test(tc.tool)
      const firma = esDoc ? `doc:${tc.tool}` : `${tc.tool}:${JSON.stringify(tc.args ?? {})}`
      if (yaEjecutadas.has(firma)) {
        const previo = yaEjecutadas.get(firma)
        console.warn(`[react] ${tc.tool}: repetida en la misma corrida — se reusa el resultado anterior`
          + `${previo?.url ? ` (${previo.url.slice(-28)})` : ''}`)
        allToolCalls.push({ ...tc, result: previo, reused: true })
        toolResultParts.push(`<tool_result tool="${tc.tool}">\nAlready generated in this run. `
          + `Reuse this: ${previo?.url || JSON.stringify(previo)}\nDo not call this tool again.\n</tool_result>`)
        continue
      }

      const toolResult = await executeTool(tc.tool, tc.args, { project_id: projectId, node_id: nodeId })
      yaEjecutadas.set(firma, toolResult)
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
  const { isDataDump } = require('./tools.service')
  if (hasDocxTool && !docxAlreadyCalled && replyText.trim().length > 200 && !isDataDump(replyText)) {
    try {
      const { executeTool: et } = require('./tools.service')
      // Incluir el OUTPUT en el título: si no, todos los PDFs del mismo nodo salen con portada
      // idéntica y parecen el mismo archivo (ver el mismo fix en forge-canvas.routes).
      const outLabel = targetOutput
        ? (typeof targetOutput === 'object' ? (targetOutput.label || targetOutput.name || targetOutput.key || '') : String(targetOutput))
        : ''
      const docTitle = outLabel ? `${nodeName} · ${outLabel}` : nodeName

      // Imágenes para incrustar al pie de cada ítem del PDF, en el orden en que salen.
      const outKey = typeof targetOutput === 'object' ? targetOutput?.key : null
      const itemImages = await resolverImagenesDeItems({
        db, projectId, nodeId, sessionId, outKey, contenido: replyText,
      })

      const docResult = await et(
        'doc_gen_docx',
        { title: docTitle, content: replyText, item_images: itemImages },
        { project_id: projectId, node_id: nodeId },
      )
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

/**
 * Bolsas de contenido para el ENSAMBLADOR, indexadas POR CLAVE (no formateadas como prompt).
 * Distinto de resolveNodeInputs, que devuelve bloques markdown listos para el system prompt:
 * acá el ensamblador necesita poder pedir "input:world_lore" o "sibling:gdd_source_md" y
 * recibir ese contenido exacto, sin encabezados ni recortes.
 *
 *   inputs[<puerto>]   = contenido del asset upstream conectado a ese puerto por un edge tipado
 *   siblings[<output>] = contenido del asset propio del nodo para ese output, ya aprobado
 *
 * Sólo se miran edges TIPADOS (in-<key>): un cable generico no dice a que puerto entra, y el
 * ensamblador necesita la clave exacta para resolver el slot.
 */
async function resolveAssemblyPools(db, { projectId, currentPNodeId, node, outputDefs }) {
  const inputs = {}, siblings = {}

  const norm = normAssetName

  const { data: edges } = await db()
    .from('forge_project_edges')
    .select('source_node_id, source_handle, target_handle')
    .eq('project_id', projectId)
    .eq('target_node_id', currentPNodeId)

  for (const e of (edges || [])) {
    const th = e.target_handle || ''
    if (!th.startsWith('in-')) continue
    const portKey = th.slice(3)
    if (inputs[portKey]) continue
    const outKey = (e.source_handle || '').startsWith('out-') ? e.source_handle.slice(4) : null
    if (!outKey) continue

    const { data: src } = await db()
      .from('forge_project_nodes')
      .select('node_id, forge_nodes(title, outputs)')
      .eq('id', e.source_node_id)
      .maybeSingle()
    if (!src?.node_id) continue

    const defs  = src.forge_nodes?.outputs ?? []
    const def   = defs.find(o => (o.key || o.name) === outKey)
    if (!def) continue
    const label = def.label || def.name || def.key

    const { data: cand } = await db()
      .from('forge_assets')
      .select('name, content, forge_sessions!session_id(output_key)')
      .eq('project_id', projectId)
      .eq('node_id', src.node_id)
      .in('status', ['approved', 'auto_approved'])
      .neq('format', 'png')
      .order('created_at', { ascending: false })

    // Por output_key de la sesión (el contrato); el name normalizado queda de respaldo.
    const want  = norm(`${src.forge_nodes?.title} — ${label}`)
    const asset = (cand || []).find(a => a.forge_sessions?.output_key === outKey)
               || (cand || []).find(a => norm(a.name) === want)

    if (asset?.content) inputs[portKey] = asset.content
  }

  const { data: own } = await db()
    .from('forge_assets')
    .select('name, content, forge_sessions!session_id(output_key)')
    .eq('project_id', projectId)
    .eq('node_id', node.id)
    .in('status', ['approved', 'auto_approved'])
    .neq('format', 'png')
    .order('created_at', { ascending: false })

  const labelOf = o => (typeof o === 'object' ? (o.label || o.name || o.key) : o)
  for (const def of (outputDefs || [])) {
    const k = def.key || def.name
    if (!k) continue
    const want = norm(`${node.title} — ${labelOf(def)}`)
    const hit = (own || []).find(a => a.forge_sessions?.output_key === k)
             || (own || []).find(a => norm(a.name) === want)
    if (hit?.content) siblings[k] = hit.content
  }

  return { inputs, siblings }
}

module.exports = {
  resolverImagenesDeItems, buildSystemPrompt, resolveNodeInputs, resolveAssemblyPools, runReActLoop, propagateStale, injectVars, injectSkillVars, resolverInstancia }
