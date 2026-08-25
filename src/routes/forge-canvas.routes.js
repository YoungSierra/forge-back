const express    = require('express')
const router     = express.Router({ mergeParams: true })
const multer     = require('multer')
const { db, dbAsUser } = require('../services/supabase.service')
const { autoWire, cleanupAndRewire } = require('../services/auto-wire.service')
const { extractSection } = require('../utils/extract-section')
const { canRun } = require('../services/credits.service')

// Frente 4: gate de crédito. Bloquea correr un nodo si la org no tiene saldo, o si el proyecto/miembro
// alcanzó su sub-tope (el más restrictivo manda). Devuelve true si se puede seguir; si no, responde 402.
async function creditGate(project_id, res, memberId = null) {
  const { data: proj } = await db().from('projects').select('org_id').eq('id', project_id).maybeSingle()
  if (!proj?.org_id) return true // sin org (dato viejo) -> no bloquear
  const r = await canRun(proj.org_id, { projectId: project_id, memberId })
  if (!r.ok) {
    const msg = r.reason === 'PROJECT_CAP'
      ? `This project reached its ${r.period === 'total' ? 'total' : 'monthly'} spending cap. Ask an org admin to raise it.`
      : r.reason === 'MEMBER_CAP'
        ? `You reached your ${r.period === 'total' ? 'total' : 'monthly'} spending cap. Ask an org admin to raise it.`
        : 'Insufficient credits to run. Please top up.'
    res.status(402).json({ success: false, error: msg, code: 'NO_CREDIT', reason: r.reason, balance: r.balance, cap: r.cap, spent: r.spent })
    return false
  }
  return true
}

// ─── ¿El blueprint está sellado? (gate ACCEPT) ───────────────────────────────
// forge_project_blueprints acumula varias filas por blueprint (historial de loads).
// Por eso NO se puede usar .maybeSingle() — con >1 fila devuelve error + data null y
// el guard fallaría abierto. Se sella si CUALQUIER fila tiene gate_decision = 'ACCEPT'.
async function isBlueprintSealed(project_id, blueprint_id) {
  if (!blueprint_id) return false
  const { data } = await db()
    .from('forge_project_blueprints')
    .select('gate_decision')
    .eq('project_id', project_id)
    .eq('blueprint_id', blueprint_id)
  return (data || []).some(r => r.gate_decision === 'ACCEPT')
}

// ─── Outputs de texto/asset de un nodo (Decision 5: imágenes fuera de scope v1) ──
// Los outputs de imagen (image_gen + format png/image) los maneja la tarea #8, no Run.
function textOutputsOf(node) {
  const outs = (Array.isArray(node?.outputs) ? node.outputs : []).map(o => ({ ...o, key: o.key || o.name }))
  return outs.filter(o => o.key && !(o.image_gen === true && (o.format === 'png' || o.format === 'image')))
}

// ─── Outputs PENDIENTES de un nodo — qué debe correr Run (bug A, per-output-aware) ──
// Reglas locked:
//  · Decision 3A: si el nodo está stale → se re-corren TODOS sus outputs.
//  · Decision 2A: una sesión general aprobada "tapa" el nodo completo (retro-compat blob).
//  · un output con sesión per-output aprobada está satisfecho → no se vuelve a correr.
async function pendingOutputsForNode(project_id, node_id, isStale, node) {
  const textOuts = textOutputsOf(node)
  if (!textOuts.length) return []
  if (isStale) return textOuts.map(o => o.key)

  // Sesión general aprobada → nodo satisfecho (no se toca)
  const { data: gen } = await db()
    .from('forge_sessions')
    .select('id')
    .eq('project_id', project_id)
    .eq('node_id', node_id)
    .is('output_key', null)
    .in('status', ['approved', 'auto_approved'])
    .limit(1)
  if ((gen || []).length) return []

  // Outputs con sesión per-output aprobada → satisfechos
  const { data: outSess } = await db()
    .from('forge_sessions')
    .select('output_key')
    .eq('project_id', project_id)
    .eq('node_id', node_id)
    .not('output_key', 'is', null)
    .in('status', ['approved', 'auto_approved'])
  const approved = new Set((outSess || []).map(s => s.output_key))

  return textOuts.filter(o => !approved.has(o.key)).map(o => o.key)
}

// ─── Ejecuta UN output de un nodo como sesión per-output auto-aprobada ──────────
// Núcleo reusable del auto-run. No toca otros outputs ya aprobados (bug A).
async function executeOneOutput({ project_id, node_id, targetOutputKey, member_id, project_node_id = null }) {
  const { buildSystemPrompt, runReActLoop } = require('../services/canvas-chat.service')
  const { logExecution } = require('../services/execution-log.service')

  // Sesión enfocada en este output (output_key = key)
  const { data: session, error: sessErr } = await db()
    .from('forge_sessions')
    .insert({
      project_id,
      node_id,
      project_node_id,
      output_key:      targetOutputKey,
      status:          'active',
      iteration_count: 0,
      started_at:      new Date().toISOString(),
      triggered_by:    member_id || null,
    })
    .select('id')
    .single()
  if (sessErr) throw sessErr

  const userMessage = 'Generate the output for this step'

  // La instancia viaja con la llamada: sin ella, un nodo que vive en varios lanes no puede saber
  // cuál de los dos es y se queda sin ningún input.
  const { finalSystemPrompt, baseUserMsg, executorStr, activeTools, resolvedInputs, visualRefs, node, targetOutput } =
    await buildSystemPrompt(db, { projectId: project_id, nodeId: node_id, sessionId: session.id, userMessage, targetOutputKey, projectNodeId: project_node_id })

  const { replyText, allToolCalls, docUrl, docFormat, meta } = await runReActLoop({
    finalSystemPrompt, baseUserMsg, executorStr, activeTools, resolvedInputs, visualRefs,
    projectId: project_id, nodeId: node_id, nodeName: node.title,
    sessionId: session.id, targetOutput,
  })

  try { logExecution({
    project_id, node_id, session_id: session.id, triggered_by: member_id || null,
    trigger_type: 'auto_run', executor_type: 'llm',
    provider: meta?.provider || null, model: meta?.model || null,
    tokens: meta?.tokens_used || null, duration_ms: meta?.duration_ms || null,
    started_at: new Date(Date.now() - (meta?.duration_ms || 0)).toISOString(),
    status: 'success', metadata: { node_key: node.node_key, output_key: targetOutputKey },
  }) } catch (logErr) { console.error('[auto-run] logExecution failed (non-fatal):', logErr.message) }

  await db().from('forge_messages').insert({ session_id: session.id, role: 'human', content: userMessage, order_index: 0, tool_calls: [] })
  await db().from('forge_messages').insert({ session_id: session.id, role: 'agent', content: replyText, order_index: 1, tool_calls: allToolCalls.length ? allToolCalls : [] })

  // Nombre del asset: usa el label del output cuando aplica
  const outDef = (Array.isArray(node.outputs) ? node.outputs : []).find(o => (o.key || o.name) === targetOutputKey)
  const assetName = outDef
    ? `${node.title} — ${outDef.label || outDef.name || targetOutputKey}`
    : `${node.title} — Output`

  const { data: asset, error: assetErr } = await db()
    .from('forge_assets')
    .insert({
      node_id, project_id, session_id: session.id, name: assetName,
      format:      docUrl ? (docFormat === 'pptx' ? 'pptx' : 'docx') : 'markdown',
      status:      'approved', content: replyText, storage_url: docUrl || null,
      approved_by: member_id || null, approved_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (assetErr) throw assetErr

  await db().from('forge_sessions')
    .update({ status: 'auto_approved', output_asset_id: asset.id, completed_at: new Date().toISOString(), iteration_count: 1 })
    .eq('id', session.id)

  return { output_key: targetOutputKey, session_id: session.id, asset_id: asset.id, reply: replyText, doc_url: docUrl || undefined, doc_format: docFormat || undefined }
}

// ─── Outputs de IMAGEN pendientes de un nodo (auto-gen, #8) ────────────────────
// Mismo criterio "satisfecho" que los de texto: sesión per-output aprobada = listo.
// stale → se re-generan todos. Condición estricta: image_gen && format∈{png,image}.
async function pendingImageOutputsForNode(project_id, node_id, isStale, node) {
  const { imageOutputsOf } = require('../services/image-gen.service')
  const imgOuts = imageOutputsOf(node)
  if (!imgOuts.length) return []
  if (isStale) return imgOuts.map(o => o.key)

  // Sesión general aprobada → nodo satisfecho (retro-compat blob, decision 2A)
  const { data: gen } = await db()
    .from('forge_sessions')
    .select('id')
    .eq('project_id', project_id)
    .eq('node_id', node_id)
    .is('output_key', null)
    .in('status', ['approved', 'auto_approved'])
    .limit(1)
  if ((gen || []).length) return []

  // Outputs con sesión per-output aprobada → satisfechos
  const { data: outSess } = await db()
    .from('forge_sessions')
    .select('output_key')
    .eq('project_id', project_id)
    .eq('node_id', node_id)
    .not('output_key', 'is', null)
    .in('status', ['approved', 'auto_approved'])
  const approved = new Set((outSess || []).map(s => s.output_key))

  return imgOuts.filter(o => !approved.has(o.key)).map(o => o.key)
}

// ─── Ejecuta UN output de imagen como sesión per-output auto-aprobada (#8) ──────
// Corre el ReAct del output (produce los prompts según su ADN, con siblings ya
// disponibles si se corrió después de los outputs de texto), parsea N ítems y
// genera 1 imagen por ítem. Persiste en forge_sessions.output_images Y forge_assets.
// El cuerpo de un prompt set ensamblado. Una sola función porque se emite desde dos caminos —el
// chat y el Run— y se veían distintos.
//
// En inglés como el resto de lo que lee el usuario, y los avisos RESUMIDOS: cuando el modelo se
// pasa del presupuesto en 16 de 34 líneas, dieciséis viñetas empujan el contenido fuera de la
// pantalla y tapan justo lo que uno viene a mirar. El detalle va al final, plegado.
function cuerpoDeck(titulo, wfName, fills, r) {
  const excedidas = (r.avisos || []).filter(a => /^line "/.test(a)).length
  const otros     = (r.avisos || []).filter(a => !/^line "/.test(a))
  return [
    `# ${titulo}`,
    '',
    `**${r.paginas.length} prompts** ready to dispatch · workflow \`${wfName}\``,
    fills
      ? 'Workflow scaffold copied verbatim + the model\'s fills. Assembly, not generation: the same fills produce the same result.'
      : '⚠ No fills yet — values were extracted from the approved document.',
    r.fills
      ? `\nFills: digest ${r.fills.digest_chars}/${r.fills.digest_limite} chars · longest line ${r.fills.linea_max}/${r.fills.linea_limite}`
      : '',
    excedidas
      ? `\n⚠ ${excedidas} of ${r.paginas.length} slide lines exceed the ${r.fills?.linea_limite ?? 250}-character budget. ` +
        'Prompts still fit the workflow limit, but the DNA sets that budget for a reason — the digest multiplies across every slide.'
      : '',
    otros.length ? `\n${otros.map(a => `⚠ ${a}`).join('\n')}` : '',
    '',
    ...r.paginas.map(p => `## ${String(p.indice).padStart(2, '0')} · ${p.nombre}\n\n\`\`\`\n${p.prompt}\n\`\`\``),
    excedidas
      ? `\n---\n\n<details><summary>Lines over budget (${excedidas})</summary>\n\n` +
        (r.avisos || []).filter(a => /^line "/.test(a)).map(a => `- ${a}`).join('\n') + '\n\n</details>'
      : '',
  ].filter(Boolean).join('\n')
}

// ─── Output ENSAMBLADO (`assembly: true`) ─────────────────────────────────────
// No llama al LLM: compone. Para el prompt set de un deck eso significa andamiaje del workflow
// copiado tal cual + los fills que escribió el modelo. Mismos fills, mismo resultado byte a byte.
//
// De qué deck es lo dice la DNA: se busca el output de imagen que declara a ESTE como su hermano.
// Así no hay una lista de claves a mano que se desincronice cuando cambien los nombres.
async function executeAssemblyOutput({ project_id, node_id, targetOutputKey, member_id, project_node_id = null, nodeDna }) {
  const { composeDeck, DECKS } = require('../services/slide-composer.service')

  const outs = Array.isArray(nodeDna?.outputs) ? nodeDna.outputs : []
  const def  = outs.find(o => (o.key || o.name) === targetOutputKey)
  const img  = outs.find(o => o.image_gen && (o.uses?.siblings_if_present || []).includes(targetOutputKey))
  if (!img?.image_gen_model) {
    throw new Error(`"${targetOutputKey}" es assembly pero ningún output de imagen lo declara como hermano`)
  }
  const wfName = String(img.image_gen_model).replace(/^comfyui:/, '')
  const deck   = Object.entries(DECKS).find(([, c]) => c.workflow === wfName)?.[0]
  if (!deck) throw new Error(`No hay deck registrado para el workflow "${wfName}"`)

  // Los fills, que son la única entrada variable
  let fills = null
  for (const h of (def.uses?.siblings_if_present || [])) {
    const { data: hs } = await db().from('forge_sessions').select('output_asset_id')
      .eq('project_id', project_id).eq('node_id', node_id).eq('output_key', h)
      .in('status', ['approved', 'auto_approved']).order('completed_at', { ascending: false })
      .limit(1).maybeSingle()
    if (!hs?.output_asset_id) continue
    const { data: a } = await db().from('forge_assets').select('content').eq('id', hs.output_asset_id).single()
    if (a?.content) { fills = a.content; break }
  }

  const r = await composeDeck({ db, projectId: project_id, deck, fills })

  const cuerpo = cuerpoDeck(def.label || targetOutputKey, wfName, fills, r)

  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id, output_key: targetOutputKey, status: 'auto_approved', project_node_id,
    iteration_count: 1, started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id || null,
  }).select('id').single()

  await db().from('forge_messages').insert({ session_id: ses.id, role: 'human', content: 'Assemble this output', order_index: 0, tool_calls: [] })
  await db().from('forge_messages').insert({
    session_id: ses.id, role: 'agent', order_index: 1, tool_calls: [],
    content: `Assembled **${r.paginas.length}** prompts for \`${wfName}\`, largest ${Math.max(...r.paginas.map(p => p.prompt.length))} chars.` +
             (r.avisos.length ? `\n\n**Warnings:**\n${r.avisos.map(a => `- ${a}`).join('\n')}` : ''),
  })

  const { data: asset } = await db().from('forge_assets').insert({
    node_id, project_id, session_id: ses.id,
    name: `${nodeDna.title} — ${def.label || targetOutputKey}`,
    format: 'markdown', status: 'approved', content: cuerpo,
    approved_by: member_id || null, approved_at: new Date().toISOString(),
  }).select('id').single()

  await db().from('forge_sessions').update({ output_asset_id: asset?.id || null }).eq('id', ses.id)
  return { output_key: targetOutputKey, session_id: ses.id, asset_id: asset?.id || null, assembled: r.paginas.length }
}

async function executeImageOutput({ project_id, node_id, targetOutputKey, member_id, project_node_id = null }) {
  const { buildSystemPrompt, runReActLoop } = require('../services/canvas-chat.service')
  const { logExecution } = require('../services/execution-log.service')
  const { parseOutputItems, generateOneImage, esDeck, generateDeck } = require('../services/image-gen.service')

  // Sesión enfocada en este output de imagen
  const { data: session, error: sessErr } = await db()
    .from('forge_sessions')
    .insert({
      project_id, node_id, output_key: targetOutputKey, status: 'active', project_node_id,
      iteration_count: 0, started_at: new Date().toISOString(), triggered_by: member_id || null,
    })
    .select('id')
    .single()
  if (sessErr) throw sessErr

  // ── Rama DECK ──────────────────────────────────────────────────────────────
  // Un deck no se enumera ni se pide de a una: sus páginas son nodos fijos del mismo grafo y
  // van en un solo job. Se corta ANTES del LLM porque acá no hay nada que enumerar — el poblado
  // sale de los documentos aprobados, no de una respuesta del modelo.
  {
    const { data: dna } = await db().from('forge_nodes').select('node_key,title,outputs').eq('id', node_id).single()
    const def = (Array.isArray(dna?.outputs) ? dna.outputs : []).find(o => (o.key || o.name) === targetOutputKey)

    if (await esDeck(def)) {
      // Los fills (v2.9.7) los escribe el LLM en el output hermano. Si están, mandan; si no, el
      // compositor extrae del documento como venía haciendo. Eso permite que este código conviva
      // con la DNA vieja y con la nueva sin bifurcar el motor.
      let fills = null
      for (const h of (def.uses?.siblings_if_present || [])) {
        if (!/_fills$/.test(h)) continue
        const { data: hs } = await db().from('forge_sessions').select('output_asset_id')
          .eq('project_id', project_id).eq('node_id', node_id).eq('output_key', h)
          .in('status', ['approved', 'auto_approved']).order('completed_at', { ascending: false })
          .limit(1).maybeSingle()
        if (!hs?.output_asset_id) continue
        const { data: a } = await db().from('forge_assets').select('content').eq('id', hs.output_asset_id).single()
        if (a?.content) { fills = a.content; break }
      }

      // Qué páginas le tocan a este output lo resuelve `generateDeck`, que es quien conoce el
      // workflow. Acá solo se le entrega la definición de la DNA.
      //
      // ── EN SEGUNDO PLANO ────────────────────────────────────────────────────
      // Un deck tarda ~4 minutos y el navegador no sostiene una petición así: la suelta con
      // «Failed to fetch» mientras el servidor sigue renderizando. El usuario no ve nada, vuelve
      // a apretar, y salen tres despachos en paralelo — pasó, y costó crédito.
      //
      // Se despacha sin esperar y se responde enseguida con la sesión. El avance ya es visible:
      // `output_images` se llena página por página, así que el front consulta esa sesión en vez
      // de colgarse de la respuesta.
      const trabajo = generateDeck({
        db, project_id, node_id, session_id: session.id, node_key: dna.node_key,
        output_key: targetOutputKey, image_gen_model: def.image_gen_model, member_id,
        fills, outDef: def, solo: Array.isArray(def.pages) && def.pages.length ? def.pages : null,
      })

      // El cierre — mensajes, assets y estado — corre cuando el despacho termina, ya sin nadie
      // esperando del otro lado.
      trabajo.then(async r => {
      // El chat del nodo lleva el parte de lo que hizo el motor. No es una conversación
      // simulada: es el reporte de la composición, que es justo lo que hay que poder auditar.
      const parte = [
        `Composed and dispatched **${r.paginas.length}/${r.esperadas}** pages in ${r.segundos}s (single job \`${r.jobId}\`).`,
        '',
        "Pages are populated from the project's approved documents by name, not written by a model —",
        'the result can be audited page by page against the source.',
        r.huecos.length
          ? `\n**${r.huecos.length} page(s) with no source upstream** — rendered with the gap declared, never invented:\n` +
            r.huecos.map(h => `- ${h.pagina}: ${h.falta.join(', ')}`).join('\n')
          : '\nEvery page found its source.',
        r.avisos.length ? `\n**Warnings:**\n${r.avisos.map(a => `- ${a}`).join('\n')}` : '',
      ].filter(Boolean).join('\n')

      await db().from('forge_messages').insert({ session_id: session.id, role: 'human', content: 'Generate the output for this step', order_index: 0, tool_calls: [] })
      await db().from('forge_messages').insert({ session_id: session.id, role: 'agent',  content: parte, order_index: 1, tool_calls: [] })

      // Una fila por página. El nombre termina en el nombre de la página y NADA más: el moodboard
      // corta por el último guion largo para saber qué es, y el `label` de la DNA ya trae uno
      // («Art Style Guide — Content»), asi que sumarlo dejaba «… — Content 01_KeyArt» y las
      // páginas salían desordenadas porque nadie encontraba su número.
      let primero = null
      for (const p of r.paginas.sort((a, b) => a.index - b.index)) {
        const { data: asset } = await db().from('forge_assets').insert({
          node_id, project_id, session_id: session.id, name: `${dna.title} — ${p.name}`,
          format: 'png', status: 'approved', storage_url: p.url,
          approved_by: member_id || null, approved_at: new Date().toISOString(),
        }).select('id').single()
        if (!primero) primero = asset?.id || null
      }

      await db().from('forge_sessions').update({
        status: r.paginas.length === r.esperadas ? 'auto_approved' : 'active',
        output_asset_id: primero, completed_at: new Date().toISOString(), iteration_count: 1,
      }).eq('id', session.id)

      // ── El prompt set, escrito por quien de verdad lo produjo ────────────────
      // La DNA lo declara como trabajo del LLM, pero son ~6.000 caracteres por página: un
      // modelo no emite 34 de esos. Lo llena el compositor con los prompts que REALMENTE se
      // despacharon, así el output sirve para lo único que importa — auditar qué se pidió.
      // El hermano sale de la propia DNA (`uses.siblings_if_present`), no de una lista a mano.
      for (const hermano of (def.uses?.siblings_if_present || [])) {
        const hDef = dna.outputs.find(o => (o.key || o.name) === hermano)
        if (!hDef || hDef.type !== 'connection') continue

        const { data: yaHay } = await db().from('forge_sessions').select('id')
          .eq('project_id', project_id).eq('node_id', node_id).eq('output_key', hermano)
          .in('status', ['approved', 'auto_approved']).maybeSingle()
        if (yaHay) continue

        const cuerpo = [
          `# ${hDef.label || hermano}`,
          '',
          `${r.prompts.length} prompts dispatched to \`${def.image_gen_model}\` in job \`${r.jobId}\`.`,
          'Populated from the approved project documents by section name — not written by a model.',
          '',
          ...r.prompts.map(p => `## ${String(p.indice).padStart(2, '0')} · ${p.nombre}\n\n\`\`\`\n${p.prompt}\n\`\`\``),
        ].join('\n')

        const { data: hSes } = await db().from('forge_sessions').insert({
          project_id, node_id, output_key: hermano, status: 'auto_approved', project_node_id,
          iteration_count: 1, started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
          triggered_by: member_id || null,
        }).select('id').single()

        const { data: hAsset } = await db().from('forge_assets').insert({
          node_id, project_id, session_id: hSes.id,
          name: `${dna.title} — ${hDef.label || hermano}`,
          format: 'markdown', status: 'approved', content: cuerpo,
          approved_by: member_id || null, approved_at: new Date().toISOString(),
        }).select('id').single()

        await db().from('forge_sessions').update({ output_asset_id: hAsset?.id || null }).eq('id', hSes.id)
      }
      }).catch(async e => {
        // Sin nadie esperando la respuesta, un fallo silencioso dejaría la sesión en `active`
        // para siempre y el front consultando sin fin. Se marca y se registra.
        console.error(`[deck] ${targetOutputKey} falló:`, e.message)
        await db().from('forge_sessions').update({
          status: 'abandoned', completed_at: new Date().toISOString(),
        }).eq('id', session.id)
        await db().from('forge_messages').insert({
          session_id: session.id, role: 'agent', order_index: 0, tool_calls: [],
          content: `The dispatch did not complete: ${e.message}`,
        }).catch(() => {})
      })

      // Se responde YA. El trabajo sigue solo y su avance se lee en la sesión.
      return {
        output_key: targetOutputKey, session_id: session.id, asset_id: null,
        dispatched: true, expected: (Array.isArray(def.pages) && def.pages.length) || def.image_count || null,
      }
    }
  }

  const userMessage = 'Generate the output for this step'

  const { finalSystemPrompt, baseUserMsg, executorStr, activeTools, resolvedInputs, visualRefs, node, targetOutput } =
    await buildSystemPrompt(db, { projectId: project_id, nodeId: node_id, sessionId: session.id, userMessage, targetOutputKey, projectNodeId: project_node_id })

  const { replyText, allToolCalls, meta } = await runReActLoop({
    finalSystemPrompt, baseUserMsg, executorStr, activeTools, resolvedInputs, visualRefs,
    projectId: project_id, nodeId: node_id, nodeName: node.title,
    sessionId: session.id, targetOutput,
  })

  // Log del run LLM (no bloqueante)
  try { logExecution({
    project_id, node_id, session_id: session.id, triggered_by: member_id || null,
    trigger_type: 'auto_run', executor_type: 'llm',
    provider: meta?.provider || null, model: meta?.model || null,
    tokens: meta?.tokens_used || null, duration_ms: meta?.duration_ms || null,
    started_at: new Date(Date.now() - (meta?.duration_ms || 0)).toISOString(),
    status: 'success', metadata: { node_key: node.node_key, output_key: targetOutputKey },
  }) } catch (logErr) { console.error('[auto-run img] logExecution failed (non-fatal):', logErr.message) }

  await db().from('forge_messages').insert({ session_id: session.id, role: 'human', content: userMessage, order_index: 0, tool_calls: [] })
  const { data: msgAgente } = await db().from('forge_messages')
    .insert({ session_id: session.id, role: 'agent', content: replyText, order_index: 1, tool_calls: allToolCalls.length ? allToolCalls : [] })
    .select('id').single()

  // DNA del output + parseo de ítems (el conteo lo dicta el contenido, no se hardcodea)
  const outDef = (Array.isArray(node.outputs) ? node.outputs : []).find(o => (o.key || o.name) === targetOutputKey)
  const items  = parseOutputItems(replyText || '', outDef?.format || 'png')

  // Generar 1 imagen por ítem en paralelo (acota latencia en runs por tiers)
  const results = await Promise.all(items.map((itemText, idx) =>
    generateOneImage({
      project_id, node_id, session_id: session.id, node_key: node.node_key,
      output_key: targetOutputKey, image_gen_model: outDef?.image_gen_model,
      item_index: idx, item_text: itemText, condition: null, member_id,
    })
      .then(r => ({ idx, url: r.url, itemText }))
      .catch(err => { console.error(`[auto-run img] item ${idx} failed:`, err.message); return null })
  ))

  const ok = results.filter(Boolean)

  // Persistir en forge_sessions.output_images (formato nuevo con variations[])
  const outputItems = ok.map(r => ({ index: r.idx, variations: [{ url: r.url, condition: null }] }))
  await db().from('forge_sessions')
    .update({ output_images: { [targetOutputKey]: outputItems } })
    .eq('id', session.id)

  // Y colgadas del turno que las produjo, que es lo que hace que iterar no repinte las viejas.
  if (msgAgente?.id) {
    const { error: e } = await db().from('forge_messages')
      .update({ output_images: { [targetOutputKey]: outputItems } }).eq('id', msgAgente.id)
    if (e) console.warn('[auto-run img] sin historial por mensaje:', e.message)
  }

  // Crear una fila forge_assets png por imagen → downstream las encuentra
  const baseName = `${node.title} — ${outDef?.label || outDef?.name || targetOutputKey}`
  let firstAssetId = null
  for (const r of ok) {
    const assetName = ok.length > 1 ? `${baseName} ${r.idx + 1}` : baseName
    const { data: asset } = await db()
      .from('forge_assets')
      .insert({
        node_id, project_id, session_id: session.id, name: assetName,
        format: 'png', status: 'approved', content: r.itemText, storage_url: r.url,
        approved_by: member_id || null, approved_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (!firstAssetId) firstAssetId = asset?.id || null
  }

  await db().from('forge_sessions')
    .update({ status: 'auto_approved', output_asset_id: firstAssetId, completed_at: new Date().toISOString(), iteration_count: 1 })
    .eq('id', session.id)

  return { output_key: targetOutputKey, session_id: session.id, asset_id: firstAssetId, images: ok.length }
}

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
    // RLS (Frente 3 etapa 2): esta vista corre como el USUARIO -> Postgres filtra por org en cada
    // lectura. Handler read-only, así que todo va por asUser. Un proyecto de otra org devuelve vacío.
    const asUser = dbAsUser(req.auth.token)

    // Nodos activos del canvas — forge_nodes y asset-nodes
    const { data: projectNodes, error: nodesError } = await asUser
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

    // Blueprints sellados (gate ACCEPT) del proyecto — para marcar nodos no-runnable.
    // Una fila ACCEPT en cualquiera de las (posibles varias) filas del blueprint lo sella.
    const sealedBpIds = new Set()
    {
      const { data: allBpRows } = await asUser
        .from('forge_project_blueprints')
        .select('blueprint_id, gate_decision')
        .eq('project_id', project_id)
      for (const r of (allBpRows || [])) {
        if (r.gate_decision === 'ACCEPT') sealedBpIds.add(r.blueprint_id)
      }
    }

    // Sesiones por nodo: generales (output_key null) y por output específico
    const nodeIds = (projectNodes || []).filter(pn => pn.node_id).map(pn => pn.node_id)
    // Por INSTANCIA: es lo que separa un lane de otro cuando ambos corren el mismo nodo.
    let sessionsByPNodeId       = {}    // project_node_id → última sesión general
    let outputSessionsByPNodeId = {}    // project_node_id → { [output_key]: última sesión }
    // Respaldo para lo anterior al fan-out, que no tiene project_node_id.
    let sessionsByNodeId       = {}     // node_id → última sesión general
    let outputSessionsByNodeId = {}     // node_id → { [output_key]: última sesión }
    let sessionsWithAgentMsg = new Set()

    if (nodeIds.length > 0) {
      // Intenta con output_key; si falla (migración 027 pendiente) reintenta sin ella
      let rawSessions = []
      {
        const { data, error } = await asUser
          .from('forge_sessions')
          .select('id, node_id, project_node_id, output_key, status, iteration_count, started_at, completed_at, output_asset_id, output_images')
          .eq('project_id', project_id)
          .in('node_id', nodeIds)
          .order('created_at', { ascending: false })

        if (error) {
          // Columna output_key no existe aún — fallback sin ella
          const { data: data2, error: err2 } = await asUser
            .from('forge_sessions')
            .select('id, node_id, project_node_id, status, iteration_count, started_at, completed_at, output_asset_id, output_images')
            .eq('project_id', project_id)
            .in('node_id', nodeIds)
            .order('created_at', { ascending: false })
          if (err2) throw err2
          rawSessions = (data2 || []).map(s => ({ ...s, output_key: null }))
        } else {
          rawSessions = data || []
        }
      }

      // Se indexa por INSTANCIA (project_node_id), no por nodo del catálogo. Con fan-out, los
      // lanes instancian el mismo nodo: indexando por node_id los dos lanes recibían la MISMA
      // sesión, así que el lane B mostraba la conversación y el output del lane A — se trabajaba
      // un concepto creyendo estar en el otro. La sesión ya guardaba su project_node_id; lo que
      // faltaba era usarlo al leer.
      //
      // Las sesiones anteriores al fan-out no tienen project_node_id: se guardan aparte, por
      // node_id, y se usan como respaldo. Sin eso se perdería el historial de todo lo previo.
      for (const s of rawSessions) {
        if (s.output_images) s.output_images = migrateOutputImages(s.output_images)
        const clave  = s.project_node_id || s.node_id
        const destino = s.output_key
          ? (s.project_node_id ? outputSessionsByPNodeId : outputSessionsByNodeId)
          : (s.project_node_id ? sessionsByPNodeId       : sessionsByNodeId)

        if (s.output_key) {
          if (!destino[clave]) destino[clave] = {}
          if (!destino[clave][s.output_key]) destino[clave][s.output_key] = s
        } else if (!destino[clave]) {
          destino[clave] = s
        }
      }
    }

    // Todas las sesiones activas para detectar crash (sin asset, con mensajes de agente)
    const allSessions = [
      ...Object.values(sessionsByPNodeId),
      ...Object.values(sessionsByNodeId),
      ...Object.values(outputSessionsByPNodeId).flatMap(m => Object.values(m)),
      ...Object.values(outputSessionsByNodeId).flatMap(m => Object.values(m)),
    ]

    // Detectar sesiones active sin asset pero con mensajes de agente (crash en run previo)
    const activeSessIds = allSessions
      .filter(s => s.status === 'active' && !s.output_asset_id)
      .map(s => s.id)
    if (activeSessIds.length > 0) {
      // Sin `.limit(activeSessIds.length)`: ese tope asumía un mensaje de agente por sesión, y en
      // cuanto una acumula varios turnos se come el cupo de las demás. Medido: con 3 sesiones
      // activas, el 2.1 (2 turnos) y un 2.4 (1 turno) llenaban las 3 filas y el otro 2.4 —el que
      // más se había iterado, 5 turnos— quedaba marcado como «sin contenido». El filtro por
      // sesiones activas ya acota el volumen.
      const { data: agentMsgs } = await asUser
        .from('forge_messages')
        .select('session_id')
        .in('session_id', activeSessIds)
        .eq('role', 'agent')
      for (const m of (agentMsgs || [])) sessionsWithAgentMsg.add(m.session_id)
    }

    // Cargar output assets de todas las sesiones aprobadas/auto_approved (batch — evita N+1)
    const outputAssetIds = allSessions
      .filter(s => (s.status === 'approved' || s.status === 'auto_approved') && s.output_asset_id)
      .map(s => s.output_asset_id)

    let outputAssetsMap = {}
    if (outputAssetIds.length > 0) {
      const { data: outputAssets } = await asUser
        .from('forge_assets')
        .select('id, name, format, storage_url, content')
        .in('id', outputAssetIds)
      for (const a of (outputAssets || [])) {
        outputAssetsMap[a.id] = { id: a.id, name: a.name, format: a.format, storage_url: a.storage_url || null, content: a.content || null }
      }
    }

    const nodes = (projectNodes || []).map(pn => {
      const nodeType     = pn.node_type || 'forge_node'
      const session      = nodeType === 'forge_node'
        ? (sessionsByPNodeId[pn.id] || sessionsByNodeId[pn.node_id] || null)
        : null
      const output_asset = session?.output_asset_id ? (outputAssetsMap[session.output_asset_id] ?? null) : null
      const has_content  = !!(output_asset || (session && sessionsWithAgentMsg.has(session.id)))

      // Construir mapa de sesiones por output_key
      const outputSessMap = nodeType === 'forge_node'
        ? (outputSessionsByPNodeId[pn.id] ?? outputSessionsByNodeId[pn.node_id] ?? {})
        : {}
      const output_sessions = {}
      for (const [ok, os] of Object.entries(outputSessMap)) {
        const oa = os.output_asset_id ? (outputAssetsMap[os.output_asset_id] ?? null) : null
        output_sessions[ok] = { ...os, output_asset: oa, has_content: !!(oa || sessionsWithAgentMsg.has(os.id)) }
      }

      return {
        project_node_id: pn.id,
        order_index:     pn.order_index,
        blueprint_id:    pn.blueprint_id,
        sealed:          sealedBpIds.has(pn.blueprint_id),
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

    // Blueprint activo = la fase MÁS AVANZADA con nodos cargados en el canvas.
    // No se deriva de forge_project_blueprints porque esa tabla puede no tener fila
    // para fases cargadas vía fan-out, y acumula filas selladas de fases viejas
    // (rompía la resolución: devolvía Ideation sellada en vez de Concept viva).
    const PHASE_SEQUENCE = ['ideation', 'concept', 'pre-production', 'production', 'live-ops']
    const loadedBpIds = [...new Set((projectNodes || []).map(n => n.blueprint_id).filter(Boolean))]
    let activeBlueprint = null
    if (loadedBpIds.length > 0) {
      const { data: bpDefs } = await asUser
        .from('forge_blueprints')
        .select('id, blueprint_key, name, phase, gate')
        .in('id', loadedBpIds)
      // La fase viva es la de mayor índice en la secuencia de fases
      const live = (bpDefs || [])
        .slice()
        .sort((a, b) => PHASE_SEQUENCE.indexOf(a.phase) - PHASE_SEQUENCE.indexOf(b.phase))
        .pop() || null
      if (live) {
        // gate_decision de esa fase: sellada si ALGUNA fila es ACCEPT (puede haber varias)
        const { data: gdRows } = await asUser
          .from('forge_project_blueprints')
          .select('gate_decision')
          .eq('project_id', project_id)
          .eq('blueprint_id', live.id)
        const gateDecision = (gdRows || []).some(r => r.gate_decision === 'ACCEPT')
          ? 'ACCEPT'
          : ((gdRows || []).find(r => r.gate_decision)?.gate_decision ?? null)
        activeBlueprint = { ...live, gate_decision: gateDecision }
      }
    }

    // Edges persistidos en DB (tabla puede no existir si la migración aún no se corrió)
    let edges = []
    try {
      const { data: edgeRows, error: edgeError } = await asUser
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
    const { data: projectRow } = await asUser
      .from('projects')
      .select('canvas_layout')
      .eq('id', project_id)
      .single()

    // Lanes del proyecto (tabla puede no existir si la migración 029 no se corrió aún)
    let lanes = []
    try {
      const { data: lanesData } = await asUser
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
      active_blueprint: activeBlueprint,
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
    const PHASE_SEQUENCE = ['ideation', 'concept', 'pre-production', 'production', 'live-ops']

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

    // Idempotencia (#5): si el siguiente blueprint YA tiene nodos cargados, no recrear
    // nada (evita lanes/nodos/edges duplicados al re-aceptar el gate o en el loop de pipeline).
    {
      const { data: alreadyLoaded } = await db()
        .from('forge_project_nodes')
        .select('id')
        .eq('project_id', project_id)
        .eq('blueprint_id', nextBp.id)
        .eq('removed', false)
        .limit(1)
      if ((alreadyLoaded || []).length > 0) {
        return res.json({ success: true, decision, next_blueprint: { id: nextBp.id, name: nextBp.name, phase: nextPhase }, already_loaded: true })
      }
    }

    // ── Fan-out: detección type-driven (Instancing Brief v1.2) ──────────────────
    // Busca Connection outputs tipo list<T> aprobados en el blueprint actual.
    // Si el próximo blueprint tiene nodos con single<T> input → fan-out.
    // Sin flags en blueprints ni nodos; todo se deriva de port cardinalities.
    {
      const { fanOut, classifySequenceNodes, parseItemsFromContent } = require('../services/fan-out.service')

      const { data: bpNodes } = await db()
        .from('forge_project_nodes')
        .select('id, node_id, order_index')
        .eq('project_id', project_id)
        .eq('blueprint_id', blueprint_id)
        .eq('removed', false)

      const bpNodeIds = (bpNodes || []).map(n => n.node_id).filter(Boolean)
      // order_index por node_id — para priorizar el GATE (último nodo) al elegir la fuente del fan-out
      const orderByNodeId = Object.fromEntries((bpNodes || []).map(n => [n.node_id, n.order_index ?? 0]))

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

        // Prioridad al GATE: recorrer los nodos del blueprint de MAYOR a MENOR order_index.
        // Así el fan-out usa el output curado del gate (ej. 1.4 selected_seeds = la selección
        // real) y NO el de un nodo anterior (ej. 1.1 concept_seeds), que también es
        // list<concept_seed> pero contiene TODAS las seeds, no las que el usuario seleccionó.
        const sortedDna = [...(currentDna || [])].sort(
          (a, b) => (orderByNodeId[b.id] ?? 0) - (orderByNodeId[a.id] ?? 0)
        )

        for (const node of sortedDna) {
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

    // Un nodo aprobado no se borra. El front ya lo impide en sus tres caminos (panel, arrastre al
    // panel izquierdo y atajo), pero eso es la puerta, no la cerradura: una pantalla desactualizada
    // o una llamada directa se llevaban por delante trabajo aceptado sin que nada lo frenara.
    const { data: aprobadas } = await db()
      .from('forge_sessions')
      .select('id, output_key')
      .eq('project_node_id', project_node_id)
      .in('status', ['approved', 'auto_approved'])
      .limit(1)
    if (aprobadas?.length) {
      return res.status(409).json({
        success: false,
        error: 'This node has approved output and cannot be removed. Reopen it and undo the approval first.',
      })
    }

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

    // El front manda doc_url/doc_format en el body, pero si el usuario acepta desde una vista que
    // no los tiene en estado (recarga de página, otro modal), el archivo YA generado se pierde: el
    // asset queda 'markdown' con storage_url null aunque el PDF/PPTX exista en R2 — y el botón de
    // descarga nunca aparece. El backend puede recuperarlo solo: el resultado de la herramienta
    // quedó guardado en tool_calls del mensaje del agente de esa misma sesión.
    let docUrlFinal = doc_url, docFormatFinal = doc_format
    if (!docUrlFinal && session_id) {
      const { data: msgs } = await db()
        .from('forge_messages')
        .select('tool_calls')
        .eq('session_id', session_id)
        .eq('role', 'agent')
        .order('created_at', { ascending: false })
      outer: for (const m of (msgs || [])) {
        for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
          if (/^doc_gen_(docx|pptx)$/.test(tc?.tool || '') && tc?.result?.url) {
            docUrlFinal    = tc.result.url
            docFormatFinal = tc.result.format || (tc.tool === 'doc_gen_pptx' ? 'pptx' : 'pdf')
            console.log(`[accept] doc_url recuperado de tool_calls: ${docUrlFinal}`)
            break outer
          }
        }
      }
    }

    // Crear el forge_asset con el contenido de texto aceptado
    const { data: asset, error: assetErr } = await db()
      .from('forge_assets')
      .insert({
        node_id,
        project_id,
        session_id,
        name:           assetName,
        format:         docUrlFinal ? (docFormatFinal === 'pptx' ? 'pptx' : 'docx') : 'markdown',
        status:         'approved',
        content:        content.trim(),
        storage_url:    docUrlFinal || null,
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
      // `output_images` se indexa por KEY; buscar por `name` no encontraba nada cuando difieren.
      const items = (outputImages[outDef.key || outDef.name] || outputImages[outDef.name] || [])
      return items.flatMap(item => {
        // Formato nuevo: variations[] — el historial del ítem.
        if (Array.isArray(item.variations)) {
          // Aprobar SOLO la última. Cada iteración agrega una variación, así que aprobar todas
          // metía en el proyecto la imagen vieja junto a la nueva y aguas abajo llegaban las dos
          // como si ambas fueran el resultado. Lo aceptado es lo vigente; lo anterior queda en el
          // historial del ítem, que para eso está.
          const v = [...item.variations].reverse().find(x => x.url)
          if (!v) return []
          return [{
            node_id,
            project_id,
            session_id,
            // Con el índice, para que el orden y la identidad de cada imagen sobrevivan.
            name:        items.length > 1
              ? `${node.title} — ${outDef.label || outDef.name} ${(item.index ?? 0) + 1}`
              : `${node.title} — ${outDef.label || outDef.name}`,
            format:      'png',
            status:      'approved',
            content:     null,
            storage_url: v.url,
            approved_by: member_id || null,
            approved_at: new Date().toISOString(),
          }]
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
    const { output_key, item_index, item_text, condition, message_id = null } = req.body

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

    // Un DECK no se genera de a un ítem: sus páginas son nodos fijos del mismo grafo y van en un
    // solo job desde el Run. Pedirlo por acá devolvía un 500 sin explicación.
    if (outputDef && await require('../services/image-gen.service').esDeck(outputDef)) {
      return res.status(400).json({
        success: false,
        error: `"${output_key}" es un deck de ${outputDef.image_count ?? '?'} páginas: se despacha completo desde Run, no ítem por ítem`,
      })
    }
    // `production: deferred` se produce en otra etapa y no debe dispararse desde el chat.
    if (outputDef?.production === 'deferred') {
      return res.status(400).json({
        success: false,
        error: `"${output_key}" está declarado como deferred: se produce en otra etapa`,
      })
    }

    if (!outputDef?.image_gen) {
      return res.status(400).json({ success: false, error: `Output "${output_key}" no tiene image_gen habilitado` })
    }

    const memberId = req.headers['x-member-id'] || null

    // Núcleo de generación reutilizable (provider dispatch + cost log) en image-gen.service
    const { generateOneImage } = require('../services/image-gen.service')
    const result = await generateOneImage({
      project_id, node_id, session_id, node_key: node.node_key,
      output_key, image_gen_model: outputDef.image_gen_model,
      item_index, item_text, condition, member_id: memberId,
    })

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

    // Y la imagen queda además colgada del TURNO que la pidió. El mapa de la sesión es «lo último
    // vigente» —lo que leen el canvas, el moodboard y el PDF—; este es el historial: iterar
    // reescribe los prompts sin mover los índices, así que sin esto la respuesta nueva se pintaba
    // con la imagen de la respuesta anterior.
    if (message_id) {
      const { data: msg } = await db()
        .from('forge_messages').select('output_images').eq('id', message_id).maybeSingle()
      const mias  = migrateOutputImages(msg?.output_images || {})
      const lista = Array.isArray(mias[output_key]) ? [...mias[output_key]] : []
      const i     = lista.findIndex(e => e.index === item_index)
      if (i >= 0) lista[i] = { ...lista[i], variations: [...(lista[i].variations || []), newVariation] }
      else        lista.push({ index: item_index, variations: [newVariation] })
      lista.sort((a, b) => a.index - b.index)
      // Si la columna todavía no existe (migración 051 sin correr), no se rompe la generación:
      // la imagen ya está guardada en la sesión.
      const { error: msgErr } = await db()
        .from('forge_messages').update({ output_images: { ...mias, [output_key]: lista } }).eq('id', message_id)
      if (msgErr) console.warn('[generate-item-image] sin historial por mensaje:', msgErr.message)
    }

    res.json({ success: true, image_url: result.url, output_images: updatedImages })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:node_id/generate-pdf ─
// Genera (o devuelve cached) el PDF de UN output del nodo.
//
// Antes tomaba la sesión aprobada más reciente sin mirar de qué output era, así que en un nodo
// con varios outputs siempre devolvía el mismo archivo: en el 2.1, el del pitch_document
// estuvieras parado donde estuvieras. El PDF se genera la primera vez que lo piden y queda
// guardado en el asset, así que la segunda llamada no vuelve a renderizar.
router.post('/nodes/:node_id/generate-pdf', async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params
    const { output_key = null, project_node_id = null } = req.body ?? {}

    let q = db()
      .from('forge_sessions')
      .select('id, output_asset_id, status')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .in('status', ['approved', 'auto_approved'])
      .order('completed_at', { ascending: false })
      .limit(1)

    // Con fan-out el mismo nodo del catálogo vive en varios lanes; sin acotar por instancia se
    // devolvería el documento del lane vecino. Igual que en GET /session.
    if (project_node_id) q = q.eq('project_node_id', project_node_id)

    let session = null
    if (output_key) {
      const { data, error } = await q.eq('output_key', output_key).maybeSingle()
      // La columna output_key puede no existir en instalaciones viejas: se cae al comportamiento
      // de antes en vez de romper la descarga.
      session = error ? (await q.maybeSingle()).data : data
    } else {
      session = (await q.maybeSingle()).data
    }

    if (!session?.output_asset_id) {
      return res.status(404).json({
        success: false,
        error: output_key
          ? `El output "${output_key}" no tiene un documento aprobado del que sacar PDF`
          : 'No approved session with asset found',
      })
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

    // Las imágenes del documento se resolvían SOLO cuando el PDF nacía dentro de la corrida. Este
    // botón llamaba al generador con título y texto, así que todo PDF pedido a mano salía sin una
    // sola imagen — en cualquier proyecto, no solo en los de fan-out.
    let itemImages = []
    try {
      const { resolverImagenesDeItems } = require('../services/canvas-chat.service')
      itemImages = await resolverImagenesDeItems({
        db, projectId: project_id, nodeId: node_id,
        sessionId: session.id, outKey: output_key, contenido: docContent,
      })
    } catch (e) { console.error('[generate-pdf] imágenes:', e.message) }

    const { executeTool } = require('../services/tools.service')
    const docResult = await executeTool('doc_gen_docx', {
      title:   asset.name,
      content: docContent,
      item_images: itemImages,
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
    const { output_key = null, project_node_id = null } = req.query
    const asUser = dbAsUser(req.auth.token)  // RLS: lecturas del nodo como el usuario

    let baseQuery = asUser
      .from('forge_sessions')
      .select('id, status, iteration_count, started_at, completed_at, output_asset_id, output_images')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .order('created_at', { ascending: false })
      .limit(1)

    // Con fan-out, cada lane instancia el MISMO nodo del catálogo: sin acotar por instancia, el
    // lane B abría la sesión del lane A y se trabajaba un concepto creyendo estar en el otro.
    // Solo se acota cuando el front manda la instancia; sin ella se conserva el comportamiento
    // de siempre, que es lo que necesitan los proyectos anteriores al fan-out.
    if (project_node_id) baseQuery = baseQuery.eq('project_node_id', project_node_id)

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
      let qPer = asUser
        .from('forge_sessions')
        .select('id, output_key, output_images, output_asset_id, status')
        .eq('project_id', project_id)
        .eq('node_id', node_id)
        .not('output_key', 'is', null)
        .order('created_at', { ascending: false })
      if (project_node_id) qPer = qPer.eq('project_node_id', project_node_id)
      const { data: perOutSessions } = await qPer

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
          const { data: aData } = await asUser
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

    // `output_images` por mensaje es el historial: cada respuesta conserva lo que ella generó.
    // Si la migración 051 no corrió todavía, la consulta falla y se cae a la de siempre — el chat
    // sigue funcionando, solo sin historial por turno.
    let { data: msgs } = await asUser
      .from('forge_messages')
      .select('id, role, content, order_index, tool_calls, output_images')
      .eq('session_id', session.id)
      .order('order_index')
    if (!msgs) {
      const { data: basicos } = await asUser
        .from('forge_messages')
        .select('id, role, content, order_index, tool_calls')
        .eq('session_id', session.id)
        .order('order_index')
      msgs = basicos
    }

    // Cargar attachments de la sesión agrupados por message_id
    const { data: attachments } = await asUser
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
      id:            m.id,
      role:          m.role === 'human' ? 'user' : 'assistant',
      content:       m.content,
      attachments:   attachmentsByMsg[m.id] || [],
      tool_calls:    m.tool_calls?.length ? m.tool_calls : undefined,
      output_images: m.output_images ? migrateOutputImages(m.output_images) : undefined,
    }))

    // Cargar asset si existe
    let asset = null
    let imageAssets = []
    if (session.output_asset_id) {
      const { data: assetData } = await asUser
        .from('forge_assets')
        .select('id, name, format, content, storage_url')
        .eq('id', session.output_asset_id)
        .maybeSingle()
      asset = assetData

      const { data: imgData } = await asUser
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
      const { data: lastAgentMsg } = await asUser
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

    // Merge de output_images de per-output sessions (si existen).
    // Acotado a la instancia: sin esto, el 2.4 del lane B mostraba las 7 imágenes que el 2.4 del
    // lane A había generado para OTRO concepto — mismo node_id del catálogo, distinto lane.
    let qMerge = asUser
      .from('forge_sessions')
      .select('output_images')
      .eq('project_id', project_id)
      .eq('node_id', node_id)
      .not('output_key', 'is', null)
    if (project_node_id) qMerge = qMerge.eq('project_node_id', project_node_id)
    const { data: perOutForMerge } = await qMerge

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

// ─── POST /api/projects/:id/canvas/nodes/:node_id/chat ────────
// Conversación multi-turno con un nodo usando forge_sessions/forge_messages
router.post('/nodes/:node_id/chat', chatUpload.single('attachment'), async (req, res, next) => {
  try {
    const { id: project_id, node_id } = req.params
    let { user_message, session_id, member_id, attachment_url, target_output_key = null, project_node_id: explicit_project_node_id = null } = req.body

    if (!user_message?.trim()) {
      return res.status(400).json({ success: false, error: 'user_message es requerido' })
    }

    // Frente 4: gate de crédito ANTES de correr el LLM (bloquea sin gastar)
    if (!(await creditGate(project_id, res, req.auth?.memberId))) return

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
    // Un output `assembly` lo compone el ensamblador desde su plantilla: nunca llega al modelo.
    // Todo lo que se arma para el LLM —skills desde R2, inputs resueltos, outputs hermanos, el
    // system prompt entero— es trabajo tirado, y el log imprime una "LLM call" que jamás ocurre.
    // El ensamblador resuelve sus propias fuentes aparte (resolveAssemblyPools).
    const isAssembly = targetOutput?.assembly === true
    // Guard: si viene un target_output_key que NO es un output real del nodo (ej. un input como
    // visual_targets heredado de un focus stale en el front), tratarlo como sesión general. Evita
    // crear una sesión per-output con un key inválido que luego rompe el UI (modal de outputs sin
    // foco) y deja la respuesta del run general inaccesible.
    if (target_output_key && !targetOutput) {
      console.warn(`[forge-chat] target_output_key "${target_output_key}" no es output de ${node.node_key} — tratando como sesión general`)
      target_output_key = null
    }
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
        // Solo sustituir si la clave es una variable CONOCIDA; si no, dejar el texto intacto.
        // Protege los marcadores del skill ([REQUIRED], [PROJECTED], [TO-FILL:eng], [goal]…)
        // que antes se comían (→ vacío) y rompían las guías/fill-markers del template.
        const known = Object.prototype.hasOwnProperty.call(vars, normalized) || Object.prototype.hasOwnProperty.call(vars, key)
        if (!known) return match
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
    const skillDefs  = isAssembly ? [] : (Array.isArray(node.skills) ? node.skills : [])
    const skillTexts = await Promise.all(skillDefs.map(s => getSkill(s)))
    const skillsBlock = skillDefs
      .map((s, i) => {
        if (!skillTexts[i]) return ''
        const filledText = injectSkillVars(skillTexts[i], skillVars)
        return `\n## Skill Reference: ${s}\n> This is a GUIDE for HOW to build the output — it is NOT the output. Do NOT reproduce the guide itself: never output its own meta-sections (e.g. "When to use this", "Inputs", "Method", "Principles", "Worked example", "Output checklist", "Common mistakes", "Companion artifacts", "Playbook / Method", "A/B/C" headers) nor its instructions or examples. Produce the deliverable the task asks for, following this guidance. Only reuse EXACT field/section labels when the guide explicitly lists the fields of the DELIVERABLE itself (e.g. a GDD template's fields) — never the guide's own section names.\n\n${filledText}`
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
      // Sin instancia explícita: una sola es inequívoca, varias son ambiguas y hay que decirlo.
      // `maybeSingle()` acá devolvía null con error PGRST116 y el chat se quedaba sin inputs.
      const { resolverInstancia } = require('../services/canvas-chat.service')
      currentPNode = await resolverInstancia(db, {
        projectId: project_id, nodeId: node_id, select: 'id, bound_item_ref',
      })
    }

    // Inputs de edges + library assets: resolvedor compartido con buildSystemPrompt (preview),
    // para que el preview refleje exactamente lo que se genera. Aplica scoping uses.inputs y cap alto.
    const { resolveNodeInputs } = require('../services/canvas-chat.service')
    // Las referencias que el modelo tiene que VER se recogen acá y viajan aparte del texto.
    const visualRefs = []
    const resolvedInputs = (currentPNode && !isAssembly)
      ? await resolveNodeInputs(db, { projectId: project_id, currentPNodeId: currentPNode.id, targetOutput, visualRefs })
      : []
    // Cap para attachments de sesión (los inputs de edge/library ya los capó resolveNodeInputs).
    const INPUT_CAP = 120000
    // Anclaje de estilo para hermanos NO declarados como dependencia (ver canvas-chat.service.js).
    const ANCHOR_CAP = 2000

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
    if (allOutputDefs.length && !isAssembly) {
      const { data: siblingAssets } = await db()
        .from('forge_assets')
        .select('name, content')
        .eq('project_id', project_id)
        .eq('node_id', node_id)
        .in('status', ['approved', 'auto_approved'])
        .neq('format', 'png')
        .order('created_at', { ascending: false })

      const labelOf = o => (typeof o === 'object' ? (o.label || o.name || o.key) : o)
      const assetNameFor = key => {
        const od = allOutputDefs.find(o => (o.key || o.name) === key)
        return `${node.title} — ${labelOf(od || key)}`.toLowerCase().trim()
      }
      // Si el output objetivo declara uses.siblings_if_present[], inyectar ESOS outputs hermanos
      // COMPLETOS (no truncados): es una dependencia explícita, no anclaje. Caso clave: los ADI
      // (adi_segmentation) necesitan el master `art_direction_document` verbatim para extraer por número.
      // Se aceptan LAS DOS claves — v2.9.0 declara `siblings` en vez de `siblings_if_present`, y
      // leyendo sólo la segunda esos outputs caen al else, que excluye los outputs propios del nodo
      // ⇒ nunca ven su fuente. Ver el mismo fix en canvas-chat.service.js.
      const siblingsAllowed = targetOutput?.uses?.siblings_if_present ?? targetOutput?.uses?.siblings ?? null
      if (siblingsAllowed && siblingsAllowed.length) {
        const wantNames = new Set(siblingsAllowed.map(assetNameFor))
        for (const asset of (siblingAssets || [])) {
          if (!wantNames.has((asset.name || '').toLowerCase().trim())) continue
          const c = asset.content || ''
          const snippet = c.slice(0, INPUT_CAP) + (c.length > INPUT_CAP ? '\n[truncated]' : '')
          if (snippet) existingNodeOutputs.push(`### ${asset.name}\n${snippet}`)
        }
      } else {
        // Default: NO re-inyectar los outputs PROPIOS del nodo (ej. gdd_ref/gdd_complete): al
        // regenerar, mostrarle al modelo su salida anterior lo ANCLA a la estructura vieja y la copia,
        // pisando el field-spec del skill. asset.name = "NodeTitle — OutputLabel" (no == output_key).
        const ownOutputAssetNames = new Set(allOutputDefs.map(o => `${node.title} — ${labelOf(o)}`.toLowerCase().trim()))
        for (const asset of (siblingAssets || [])) {
          if (ownOutputAssetNames.has((asset.name || '').toLowerCase().trim())) continue
          const snippet = (asset.content || '').slice(0, ANCHOR_CAP)
          if (snippet) existingNodeOutputs.push(`### ${asset.name}\n${snippet}`)
        }
      }
    }

    const layer2Parts = [
      projectMeta             ? `## Project context\n${projectMeta}`                                    : '',
      resolvedInputs.length   ? `## Input references\n${resolvedInputs.join('\n\n')}`                   : '',
      existingNodeOutputs.length ? `## Existing outputs from this node\n${existingNodeOutputs.join('\n\n')}` : '',
    ].filter(Boolean)

    // ── Ensamblar system prompt ───────────────────────────────────
    const { getToolsBlock, getDocPolicyBlock, willExportDoc, isDataDump, parseToolCalls, executeTool } = require('../services/tools.service')

    const activeTools = Array.isArray(node.tools) && node.tools.length ? node.tools : []
    // doc_gen_docx se ejecuta automáticamente — no exponerla al LLM para evitar alucinaciones
    // doc_gen_pptx sí se expone: el modelo es responsable de llamarla con contenido + imágenes
    const llmVisibleTools = activeTools.filter(t => t !== 'doc_gen_docx')
    const toolsBlock      = getToolsBlock(llmVisibleTools)
    // Esconderla NO alcanza: hay que decirle que no tiene con qué generar archivos, o improvisa
    // un script y finge la ejecución (ver getDocPolicyBlock). Se omite si este output no se
    // exporta (una connection no se renderea): prometer un PDF que no llega es instrucción falsa.
    const docPolicyBlock  = getDocPolicyBlock(activeTools, targetOutput)

    // Fecha actual para el LLM: sin esto usa su corte de entrenamiento (ej. un scan competitivo
    // dice "as of June 2025"). Le damos la fecha real para toda afirmación time-sensitive.
    const dateBlock = `The current date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Use it as "today" for any time-sensitive or recency statement (market data, "as of", "current year", competitive scans); do NOT rely on your training cutoff.`
    const systemPrompt = [dateBlock, layer1, ...layer2Parts, toolsBlock, docPolicyBlock].filter(Boolean).join('\n\n')

    // ── Layer 3: session attachments (Reference Injection) ────────
    const { data: sessionAttachments } = await db()
      .from('forge_attachments')
      .select('file_name, mime_type, storage_url, extracted_text')
      .eq('session_id', session.id)
      .order('created_at')

    const attachmentParts = [
      ...(sessionAttachments || []).map(att =>
        att.extracted_text
          ? `### ${att.file_name}\n${att.extracted_text.slice(0, INPUT_CAP)}${att.extracted_text.length > INPUT_CAP ? '\n[truncated]' : ''}`
          : `### ${att.file_name}\nURL: ${att.storage_url}`
      ),
      ...(pendingAttachment ? [
        pendingAttachment.extracted_text
          ? `### ${pendingAttachment.file_name}\n${pendingAttachment.extracted_text.slice(0, INPUT_CAP)}${pendingAttachment.extracted_text.length > INPUT_CAP ? '\n[truncated]' : ''}`
          : `### ${pendingAttachment.file_name}\nURL: ${pendingAttachment.storage_url}`
      ] : []),
    ]

    // Los adjuntos del chat son un camino APARTE de los inputs del grafo, y también traen
    // material visual: un PDF de pitch adjuntado como contexto lleva su key art adentro, y una
    // imagen adjuntada directamente no tiene por qué llegar como una URL en un texto.
    for (const att of [...(sessionAttachments || []), ...(pendingAttachment ? [pendingAttachment] : [])]) {
      if (!att.storage_url) continue
      if (String(att.mime_type || '').startsWith('image/')) {
        visualRefs.push({ label: att.file_name, imageUrl: att.storage_url })
      } else {
        visualRefs.push({ label: att.file_name, docUrl: att.storage_url, docMime: att.mime_type })
      }
    }

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

    // El ensamble imprime su propio banner más abajo; este describiría una llamada que no ocurre.
    if (!isAssembly) {
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
    }

    // ── ReAct loop — ejecuta hasta que el LLM no emita más tool_calls ────────
    const MAX_TOOL_ITERS  = 5
    let   currentUserMsg  = baseUserMsg
    let   replyText       = ''
    let   allToolCalls    = []    // historial de calls para persistir
    let   meta            = null
    let   docUrl          = null
    let   docFormat       = null

    // ── Despacho POR OUTPUT ───────────────────────────────────────────────────
    // Un output marcado `assembly: true` NO lo genera el LLM: lo compone el ensamblador
    // siguiendo su plantilla de slots. Es determinista, cuesta 0 tokens y si falta una
    // fuente requerida corta antes de producir nada (hard-block) en vez de inventarla.
    // El resto de los outputs sigue el camino de siempre.
    let assemblyReport = null
    const docWarnings = []
    const asmKey = targetOutput ? (targetOutput.key ?? targetOutput.name) : null

    // `assembly: true` tiene DOS formas de ensamblar y hay que distinguirlas.
    //
    //   · por PLANTILLA de slots — la de siempre: el ensamblador llena `tpl_<nodo>_<output>`
    //     con lo que producen otros nodos.
    //   · por DECK — el prompt set de un deck: andamiaje copiado del workflow de ComfyUI + los
    //     fills del modelo. No hay slots ni plantilla, la fuente es el propio workflow.
    //
    // Sin esta distinción, pedir el prompt set del 3.20 fallaba con «no existe su plantilla
    // (tpl_3_20_asg_prompt_set)» — una plantilla que no debería existir.
    const esPromptSetDeDeck = targetOutput?.assembly === true && await (async () => {
      const { esDeck } = require('../services/image-gen.service')
      const img = allOutputDefs.find(o => o.image_gen && (o.uses?.siblings_if_present || []).includes(asmKey))
      return img ? esDeck(img) : false
    })()

    if (esPromptSetDeDeck) {
      const { composeDeck, DECKS } = require('../services/slide-composer.service')
      const img = allOutputDefs.find(o => o.image_gen && (o.uses?.siblings_if_present || []).includes(asmKey))
      const wfName = String(img.image_gen_model).replace(/^comfyui:/, '')
      const deck = Object.entries(DECKS).find(([, c]) => c.workflow === wfName)?.[0]

      // Los fills, si el modelo ya los escribió. Sin ellos el compositor extrae del documento,
      // que es el comportamiento previo a v2.9.7.
      let fills = null
      for (const h of (targetOutput.uses?.siblings_if_present || [])) {
        const { data: hs } = await db().from('forge_sessions').select('output_asset_id')
          .eq('project_id', project_id).eq('node_id', node.id).eq('output_key', h)
          .in('status', ['approved', 'auto_approved']).order('completed_at', { ascending: false })
          .limit(1).maybeSingle()
        if (!hs?.output_asset_id) continue
        const { data: a } = await db().from('forge_assets').select('content').eq('id', hs.output_asset_id).single()
        if (a?.content) { fills = a.content; break }
      }

      // El prompt set es el conjunto COMPLETO — la DNA dice «the 34 dispatch-ready prompts». La
      // partición en 31 + 3 ocurre al despachar, no acá.
      const r = await composeDeck({ db, projectId: project_id, deck, fills })
      const largos = r.paginas.map(p => p.prompt.length)

      console.log('\n─── [forge-chat] ENSAMBLE (deck) ────────────────────')
      console.log(`  nodo/output:  ${node.node_key}/${asmKey}`)
      console.log(`  workflow:     ${wfName}`)
      console.log(`  páginas:      ${r.paginas.length}  ·  prompt ${Math.min(...largos)}–${Math.max(...largos)} chars`)
      console.log(`  fills:        ${fills ? 'sí' : 'no — extraído del documento'}`)
      console.log('─────────────────────────────────────────────────────\n')

      replyText = cuerpoDeck(targetOutput.label || asmKey, wfName, fills, r)
      meta = { provider: 'assembler', model: `deck:${wfName}`, tokens_used: null, duration_ms: 0 }

    } else if (targetOutput?.assembly === true) {
      const { getTemplate, templateIdFor } = require('../services/prompt.service')
      const { assemble, defaultGlue }      = require('../services/assembler.service')
      const { resolveAssemblyPools }       = require('../services/canvas-chat.service')

      const tpl = await getTemplate(node.node_key, asmKey)
      if (!tpl) {
        return res.status(422).json({ success: false, error:
          `El output ${node.node_key}/${asmKey} está marcado como assembly pero no existe su plantilla (${templateIdFor(node.node_key, asmKey)}).` })
      }

      const pools = await resolveAssemblyPools(db, {
        projectId: project_id, currentPNodeId: currentPNode?.id, node, outputDefs: allOutputDefs,
      })
      const r = await assemble(tpl, pools.inputs, pools.siblings, { glue: defaultGlue })
      const glued = r.manifest.slots.filter(s => s.llm_generated).length

      console.log('\n─── [forge-chat] ENSAMBLE (por plantilla) ───────────')
      console.log(`  nodo/output:  ${node.node_key}/${asmKey}`)
      console.log(`  plantilla:    ${tpl.template_id} (${tpl.slots.length} slots)`)
      console.log(`  inputs:       ${Object.keys(pools.inputs).join(', ') || '(ninguno)'}`)
      console.log(`  siblings:     ${Object.keys(pools.siblings).join(', ') || '(ninguno)'}`)
      console.log(`  slots llenos: ${r.manifest.slots.filter(s => s.filled).length}/${r.manifest.slots.length}  (${glued} por pegamento LLM)`)
      console.log(`  verificador:  ${r.verifier.filter(v => v.pass).length}/${r.verifier.length}  ·  gate: ${r.gate}`)
      console.log('─────────────────────────────────────────────────────\n')

      if (!r.gate) {
        return res.status(422).json({
          success: false,
          error: 'El ensamble no pasó el gate: falta contenido requerido. No se generó nada.',
          missing_required: r.manifest.missing_required,
          verifier: r.verifier,
          hint: 'Aprobá primero los outputs que alimentan esos slots y volvé a ejecutar.',
        })
      }

      replyText      = r.assembled
      assemblyReport = { manifest: r.manifest, verifier: r.verifier }
      meta = { provider: 'assembler', model: tpl.template_id, tokens_used: null, duration_ms: 0 }
    }

    // Se bajan una sola vez, antes del bucle: reenviarlas en cada iteración de herramientas
    // multiplicaría el costo sin agregar nada.
    const { collectVisualRefs } = require('../services/vision.service')
    const { images: visionImages, nota: visionNota } = assemblyReport
      ? { images: [], nota: '' }
      : await collectVisualRefs(visualRefs)
    if (visionNota) currentUserMsg += visionNota

    for (let iter = 0; !assemblyReport && iter < MAX_TOOL_ITERS; iter++) {
      const result = await callLLM(finalSystemPrompt, currentUserMsg, {
        images:          visionImages,
        model:           executorStr,
        rawText:         true,
        temperature:     0.7,
        // 64K (máximo de Sonnet 4.x): outputs engineering-grade completos en UNA respuesta —
        // mechanics_engineering con 8 mecánicas §B/§C + §B-S ≈ 30K tokens; el TDD buildable
        // completo también entra. Evita truncado/continuación (que rompe el "Accept as output",
        // que toma solo el último mensaje). Este es el path del chat interactivo.
        maxOutputTokens: 64000,
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

    // Si el nodo tiene doc_gen_docx y el LLM no la llamó por su cuenta, generar automáticamente.
    const hasDocTool   = activeTools.includes('doc_gen_docx')
    const alreadyCalled = allToolCalls.some(tc => tc.tool === 'doc_gen_docx')
    // Solo generar doc si NO hay target (run general → produce el asset doc) o si el target es un
    // output de DOCUMENTO. Las connections (feel_statement, visual_targets, design_pillars…) son
    // datos estructurados/texto corto, no documentos → nada de PDF ni botón de descarga para ellas.
    // Un output de IMAGEN (image_gen / format png) tampoco es documento aunque su type sea 'asset':
    // su salida es la imagen que produce ComfyUI. Sin ese guard el doc_gen generaba una "hoja de
    // prompts" en PDF y el botón "Descargar PDF" para un output que es puramente png.
    // Mismo predicado que decide si el prompt lleva el bloque de política de documento — vive en
    // tools.service para que las dos decisiones no puedan contradecirse.
    const targetIsDoc = willExportDoc(targetOutput)

    // Un payload de datos cercado no es un documento: el PDF sale como volcado ilegible.
    const targetIsDump = isDataDump(replyText)
    if (targetIsDump) console.log('[forge-chat] auto doc_gen_docx OMITIDO — la respuesta es un bloque de datos, no un documento')

    if (hasDocTool && !alreadyCalled && replyText.trim().length > 200 && targetIsDoc && !targetIsDump) {
      try {
        // Extraer solo la sección del output principal (format: document/pdf)
        // para no incluir outputs secundarios (light_pitches, etc.) en el PDF
        let docContent = replyText
        // v1.3.0/v2.6.0 usan 'key'; legacy usaba 'name'. Resolver ambos para no romper.
        const outKeyOf = o => typeof o === 'object' ? (o.key ?? o.name ?? '') : o
        const docOutputDef = allOutputDefs.find(o => {
          const fmt = typeof o === 'object' ? (o.format ?? '') : ''
          return ['document', 'pdf', 'doc', 'docx', 'pptx'].includes(fmt.toLowerCase())
        }) || allOutputDefs[0]

        // En modo FOCUS (targetOutput seteado) el LLM produjo UN solo documento completo con muchas
        // sub-secciones (§0, §1, §2…): NO recortar — el recorte por outputs secundarios solo aplica
        // al run GENERAL (varios outputs emitidos como "## <output>"). Recortar en focus dejaba el
        // PDF con solo la 1ª sección (bug ADD: §0 nomás).
        if (targetOutput) {
          console.log(`[forge-chat] auto doc_gen_docx — focus "${outKeyOf(targetOutput)}" → doc completo (${docContent.length} chars)`)
        } else if (docOutputDef) {
          const outName        = outKeyOf(docOutputDef)
          const secondaryDefs  = allOutputDefs.filter(o => o !== docOutputDef)

          // Estrategia: localizar dónde empieza la primera sección SECUNDARIA y cortar ahí.
          // Más robusto que extraer la primaria, porque el LLM suele renombrar su heading
          // (e.g. "## High Level Concept" en vez de "## pitch_document") mientras que
          // los headings de secciones secundarias sí coinciden con variantes humanizadas.
          let cutIndex = -1
          for (const secDef of secondaryDefs) {
            const secName = outKeyOf(secDef)
            if (!secName) continue
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
            // Cortar donde empieza el PRIMER output secundario (por nombre). El documento primario
            // conserva TODAS sus sub-secciones ## (§0, §1, …). NO recortar al 2º ## — eso mutilaba
            // el doc dejando solo la 1ª sección.
            docContent = replyText.slice(0, cutIndex).trim()
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

        // Salvaguarda: si la extracción del output primario dejó un fragmento chico frente a la
        // respuesta completa (ej. agarró un preámbulo del template del skill y cortó el cuerpo),
        // descartarla y usar la respuesta completa. Mejor un doc con algo de más que casi vacío.
        if (docContent.trim().length < Math.max(2000, replyText.trim().length * 0.5)) {
          docContent = replyText
          console.log(`[forge-chat] auto doc_gen_docx — extracción descartada (fragmento < 50% del output), usando respuesta completa (${replyText.trim().length} chars)`)
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

        // docGenDocx parte el título en el primer ' — ': izquierda = etiqueta de portada, derecha =
        // título grande. Sin el nombre del OUTPUT, los dos PDFs de un mismo nodo (ej. concept_data y
        // concept_document del 2.2) salían con portada idéntica y parecían el mismo archivo.
        const outLabelOf   = o => (typeof o === 'object' ? (o.label || o.name || o.key || '') : String(o || ''))
        const targetLabel  = targetOutput ? outLabelOf(targetOutput) : ''
        const docTypeLabel = targetLabel ? `${node.title} · ${targetLabel}` : node.title

        const docResult = await executeTool('doc_gen_docx', {
          title:   `${docTypeLabel} — ${project?.name ?? 'Document'}`,
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

        // Un deck sin una sola imagen es formalmente válido y comercialmente inútil, y hasta ahora
        // salía en silencio: el 2.5 de Horror_casual_game generó 12 slides con cero arte porque el
        // 2.4 todavía no había producido las orientation_images. No se bloquea -un deck de texto
        // sigue sirviendo como borrador- pero se avisa, para que nadie lo mande creyendo que está
        // completo. Las imágenes llegan por los cables de entrada, no desde los assets del nodo.
        if (!pngImageUrls.length) {
          console.warn('[forge-chat] doc_gen_pptx SIN IMÁGENES — ningún input upstream aportó PNG; el deck sale solo con texto')
          docWarnings.push('El deck se generó sin ninguna imagen: ningún nodo conectado aportó arte. Revisá que el 2.4 haya generado sus imágenes y que esté conectado antes de presentarlo.')
        }

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

    const { data: agentMsg, error: agentInsertErr } = await db()
      .from('forge_messages')
      .insert(agentRecord)
      .select('id')
      .single()

    if (agentInsertErr) {
      console.error('[forge-chat] forge_messages agent insert error:', agentInsertErr)
      throw new Error(`Failed to save agent message: ${agentInsertErr.message}`)
    }

    // La generación de imágenes de una iteración la dispara el front (`triggerAutoImageGen`),
    // que ya trae el detalle de qué ítem cambió y pinta el spinner por ítem. Acá NO se genera:
    // hacerlo en los dos lados es pagar dos veces la misma imagen.

    // Incrementar contador de iteraciones
    await db()
      .from('forge_sessions')
      .update({ iteration_count: session.iteration_count + 1 })
      .eq('id', session.id)

    res.json({
      success:    true,
      reply:      replyText,
      session_id: session.id,
      message_id: agentMsg?.id ?? undefined,
      meta,
      doc_url:    docUrl    ?? undefined,
      doc_format: docFormat ?? undefined,
      // Trazabilidad del ensamble: qué slot se llenó desde qué fuente y cuál pasó por el
      // LLM de pegamento. Sin esto, un documento compuesto por código es una caja negra.
      assembly:   assemblyReport ?? undefined,
      warnings:   docWarnings.length ? docWarnings : undefined,
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
// Lista los nodos activos disponibles para agregar al canvas.
// Con ?include_preview=1 suma además los nodos preview (archived + metadata.preview=true),
// que se revelan en el canvas con Ctrl+Alt+P — nunca aparecen en producción normal.
router.get('/nodes-catalog', async (req, res, next) => {
  try {
    const SEL = 'id, node_key, title, phase, purpose, executor, metadata'
    const includePreview = req.query.include_preview === '1' || req.query.include_preview === 'true'

    const { data, error } = await db()
      .from('forge_nodes')
      .select(SEL)
      .eq('status', 'active')
      .order('phase')
      .order('node_key')
    if (error) throw error
    let nodes = data || []

    if (includePreview) {
      const { data: preview, error: pErr } = await db()
        .from('forge_nodes')
        .select(SEL)
        .eq('status', 'archived')
        .eq('metadata->>preview', 'true')
        .order('node_key')
      if (pErr) throw pErr
      nodes = nodes.concat(preview || [])
    }

    res.json({ success: true, nodes })
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

    // ── Fix orden-independiente del arrastre: normalizar order_index de los nodos SUELTOS
    // (forge_node sin blueprint y sin lane) según su node_key. Así el auto-wire conecta
    // productor→consumidor sin importar en qué orden se arrastraron (ej. 2.2 después de 3.1).
    // Es una PERMUTACIÓN de los order_index que esos nodos YA ocupan: no crea valores nuevos,
    // no toca nodos de blueprint ni de lanes/fan-out, no colisiona con nada.
    const { data: looseNodes } = await db()
      .from('forge_project_nodes')
      .select('id, order_index, forge_nodes(node_key)')
      .eq('project_id', project_id)
      .eq('node_type', 'forge_node')
      .is('blueprint_id', null)
      .is('lane_id', null)
      .or('removed.is.null,removed.eq.false')

    if (looseNodes && looseNodes.length > 1) {
      // nkOrder: "3.2" → 3002, "3.10" → 3010, "2.2" → 2002 (ordena entre fases y dentro de fase)
      const nkOrder = k => {
        const [maj, min] = String(k || '').split('.').map(x => parseInt(x, 10) || 0)
        return maj * 1000 + min
      }
      const slots  = looseNodes.map(n => n.order_index).sort((a, b) => a - b)
      const sorted = [...looseNodes].sort(
        (a, b) => nkOrder(a.forge_nodes?.node_key) - nkOrder(b.forge_nodes?.node_key)
      )
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].order_index !== slots[i]) {
          await db().from('forge_project_nodes').update({ order_index: slots[i] }).eq('id', sorted[i].id)
        }
      }
      console.log('[add-node] normalizados', sorted.length, 'nodos sueltos por node_key')
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
    const asUser = dbAsUser(req.auth.token)  // RLS: inputs del proyecto como el usuario

    const { data, error } = await asUser
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
    const asUser = dbAsUser(req.auth.token)  // RLS: inputs del nodo como el usuario (filtra por su project_id)

    const { data, error } = await asUser
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
// Disponible en todos los nodos — misma lógica de resolución que el chat, sin llamar al LLM.
router.get('/nodes/:project_node_id/context-inputs', async (req, res, next) => {
  try {
    const { id: project_id, project_node_id } = req.params
    const asUser = dbAsUser(req.auth.token)  // RLS: contexto del nodo como el usuario

    const { data: pNode, error: pnErr } = await asUser
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
      const { data: edgeData } = await asUser
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
      const { data: srcPN } = await asUser
        .from('forge_project_nodes')
        .select(`
          node_id, node_type, text_label, text_content,
          forge_nodes(title, outputs),
          forge_project_library_assets(display_name, extracted_text, storage_url, asset_type, mime_type)
        `)
        .eq('id', edge.source_node_id)
        .maybeSingle()
      if (!srcPN) continue

      if ((srcPN.node_type || 'forge_node') === 'library_asset') {
        const lib = srcPN.forge_project_library_assets
        if (!lib) continue
        if (lib.extracted_text) {
          // Un PDF aporta su texto Y sus imágenes embebidas: el key art de un pitch es contexto
          // visual, no decoración. `docUrl`/`docMime` los cosecha después vision.service.
          inputs.push({ label: lib.display_name, content: lib.extracted_text, source: 'edge', source_project_node_id: edge.source_node_id, output_key: null,
                        docUrl: lib.storage_url, docMime: lib.mime_type })
        } else if (lib.asset_type === 'image') {
          // El markdown se conserva: lo usa el frontend para pintar la miniatura y los tools
          // para pasar la URL. `imageUrl` es lo que hace que el MODELO la vea.
          inputs.push({ label: lib.display_name, content: `![${lib.display_name}](${lib.storage_url})`, source: 'edge', isImage: true, imageUrl: lib.storage_url, source_project_node_id: edge.source_node_id, output_key: null })
        }
      } else if (srcPN.node_type === 'text_input') {
        const content = (srcPN.text_content || '').trim()
        if (content) inputs.push({ label: srcPN.text_label || 'Text Input', content, source: 'edge', source_project_node_id: edge.source_node_id, output_key: null })
      } else {
        // Forge-node: buscar asset aprobado
        const { data: asset } = await asUser
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
        const { data: pngAssets } = await asUser
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
            inputs.push({ label: png.name, content: `![${png.name}](${png.storage_url})`, source: 'edge', isImage: true, imageUrl: png.storage_url, source_project_node_id: edge.source_node_id, output_key: null })
          }
        }
      }
    }

    // 3. Library assets asignados explícitamente al nodo
    const { data: libInputs } = await asUser
      .from('forge_project_node_inputs')
      .select(`
        input_label,
        forge_project_library_assets(display_name, extracted_text, storage_url, asset_type, mime_type)
      `)
      .eq('project_node_id', pNode.id)
      .eq('source_type', 'library_asset')
      .order('order_index')

    for (const inp of (libInputs || [])) {
      const lib = inp.forge_project_library_assets
      if (!lib) continue
      if (lib.extracted_text) {
        inputs.push({ label: lib.display_name, content: lib.extracted_text, source: 'library',
                      docUrl: lib.storage_url, docMime: lib.mime_type })
      } else if (lib.asset_type === 'image') {
        inputs.push({ label: lib.display_name, content: `![${lib.display_name}](${lib.storage_url})`, source: 'library', isImage: true, imageUrl: lib.storage_url })
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

    // Frente 4: gate de crédito antes de correr el pipeline
    if (!(await creditGate(project_id, res, req.auth?.memberId))) return

    // Alcance del run: pipeline (todo) | lane | blueprint. Default pipeline.
    const { type: scopeType = 'pipeline', lane_id: scopeLaneId, blueprint_id: scopeBlueprintId } = req.body || {}

    // Pre-gate lock: correr explícitamente una fase ya sellada (gate ACCEPT) está bloqueado en v1.
    if (scopeType === 'blueprint' && scopeBlueprintId) {
      if (await isBlueprintSealed(project_id, scopeBlueprintId)) {
        return res.json({ success: true, valid: false, errors: [{
          type:          'gate_sealed',
          projectNodeId: '',
          nodeKey:       '',
          nodeTitle:     'Phase sealed',
          reason:        'This phase was accepted at its gate — re-running its steps is locked',
        }] })
      }
    }

    // Cargar todos los nodos del canvas
    const { data: pNodes } = await db()
      .from('forge_project_nodes')
      .select('id, node_id, node_type, text_content, text_label, source_asset_id, lane_id, blueprint_id, is_stale')
      .eq('project_id', project_id)
      .eq('removed', false)

    // Solo se validan los forge_nodes dentro del alcance — los demás se ignoran (no se ejecutan)
    const scopedForgeNodes = (pNodes || [])
      .filter(n => n.node_type === 'forge_node')
      .filter(n => {
        if (scopeType === 'lane')      return n.lane_id === scopeLaneId
        if (scopeType === 'blueprint') return n.blueprint_id === scopeBlueprintId
        return true  // pipeline
      })

    // Cargar definiciones de nodos (inputs required + outputs para calcular pendientes)
    const nodeIds = scopedForgeNodes.map(n => n.node_id)
    const { data: nodeDefs } = await db()
      .from('forge_nodes')
      .select('id, node_key, title, inputs, outputs')
      .in('id', nodeIds)

    const defById = Object.fromEntries((nodeDefs || []).map(n => [n.id, n]))

    // Validar SOLO los nodos que realmente correrán: ni sellados ni ya satisfechos (bug A).
    // Un nodo de fase sellada o sin outputs pendientes no se ejecuta → no debe generar errores.
    const distinctBpIds = [...new Set(scopedForgeNodes.map(n => n.blueprint_id).filter(Boolean))]
    const sealedSet = new Set()
    for (const bpId of distinctBpIds) {
      if (await isBlueprintSealed(project_id, bpId)) sealedSet.add(bpId)
    }
    const forgeNodes = []
    for (const n of scopedForgeNodes) {
      if (sealedSet.has(n.blueprint_id)) continue
      const dna = defById[n.node_id]
      if (!dna) continue
      const pending = await pendingOutputsForNode(project_id, n.node_id, n.is_stale, dna)
      if (pending.length > 0) forgeNodes.push(n)
    }

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

// ─── POST /api/projects/:id/canvas/run-plan ──────────────────────
// Plan de un Run de pipeline completo: qué gates cruza, si hay fan-out y costo estimado (#4).
// El frontend lo usa para mostrar el modal de autorización antes de cruzar gates con auto-ACCEPT.
// Solo el scope 'pipeline' cruza gates; lane/blueprint devuelven requires_authorization=false.
router.post('/run-plan', async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    const { type: scopeType = 'pipeline' } = req.body || {}

    // Secuencia canónica de fases — idéntica a la del gate ACCEPT
    const PHASE_SEQUENCE = ['ideation', 'concept', 'pre-production', 'production', 'live-ops']
    const { detectFanOut } = require('../services/fan-out.service')

    // Decisión recordada por el usuario (run_config.gate_authorization con remember=true)
    const { data: projRow } = await db()
      .from('projects')
      .select('run_config')
      .eq('id', project_id)
      .single()
    const stored = projRow?.run_config?.gate_authorization || null
    const remembered = stored?.remember ? { mode: stored.mode } : null

    // lane/blueprint no cruzan gates → sin plan de autorización
    if (scopeType !== 'pipeline') {
      return res.json({ success: true, requires_authorization: false, phases: [], gates: [], estimated: null, remembered: null })
    }

    // Blueprint activo (última fila cargada) con su DNA completo
    const { data: activeRow } = await db()
      .from('forge_project_blueprints')
      .select('blueprint_id, gate_decision, forge_blueprints(id, name, phase, gate, node_sequence)')
      .eq('project_id', project_id)
      .order('loaded_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const activeBp = activeRow?.forge_blueprints || null
    if (!activeBp) {
      return res.json({ success: true, requires_authorization: false, phases: [], gates: [], estimated: null, remembered })
    }

    // Defaults por fase — son los que el gate ACCEPT carga en cada salto
    const { data: defaults } = await db()
      .from('forge_blueprints')
      .select('id, name, phase, gate, node_sequence')
      .eq('is_default', true)
      .in('phase', PHASE_SEQUENCE)
    const defaultByPhase = Object.fromEntries((defaults || []).map(b => [b.phase, b]))

    // Cadena de fases desde la actual hasta el final. La fase actual usa el blueprint activo;
    // las siguientes usan el default (lo que se cargaría al cruzar el gate).
    const startIdx = PHASE_SEQUENCE.indexOf(activeBp.phase)
    const chain = []
    if (startIdx >= 0) {
      chain.push({ ...activeBp, _isCurrent: true })
      for (let i = startIdx + 1; i < PHASE_SEQUENCE.length; i++) {
        const bp = defaultByPhase[PHASE_SEQUENCE[i]]
        if (bp) chain.push({ ...bp, _isCurrent: false })
      }
    }

    // Nodos pendientes (runnable) de la fase actual — los downstream aún no existen
    async function countRunnable(blueprint_id) {
      const { data: bpNodes } = await db()
        .from('forge_project_nodes')
        .select('node_id, is_stale')
        .eq('project_id', project_id)
        .eq('blueprint_id', blueprint_id)
        .eq('node_type', 'forge_node')
        .eq('removed', false)
      const ids = (bpNodes || []).map(n => n.node_id)
      if (!ids.length) return 0
      const { data: sess } = await db()
        .from('forge_sessions')
        .select('node_id, status, created_at')
        .eq('project_id', project_id)
        .is('output_key', null)
        .in('node_id', ids)
        .order('created_at', { ascending: false })
      const latest = {}
      for (const s of (sess || [])) if (!(s.node_id in latest)) latest[s.node_id] = s.status
      return (bpNodes || []).filter(n => {
        const s = latest[n.node_id]
        if (s === 'approved') return false
        if (s === 'auto_approved' && !n.is_stale) return false
        return true
      }).length
    }

    // Costo promedio por ejecución de nodo (suma por sesión) — desde el log de ejecución
    async function avgCostPerNode() {
      const { data: logs } = await db()
        .from('forge_execution_log')
        .select('session_id, cost_usd')
        .eq('project_id', project_id)
        .eq('executor_type', 'llm')
        .eq('status', 'success')
        .order('started_at', { ascending: false })
        .limit(500)
      const bySession = {}
      for (const l of (logs || [])) {
        if (!l.session_id) continue
        bySession[l.session_id] = (bySession[l.session_id] || 0) + (l.cost_usd || 0)
      }
      const totals = Object.values(bySession)
      if (!totals.length) return 0.015  // default cuando no hay historial
      return totals.reduce((a, b) => a + b, 0) / totals.length
    }

    const avgCost = await avgCostPerNode()

    // Construir fases + gates + estimación. Fan-out solo es detectable en el gate inmediato
    // (los outputs de fases futuras todavía no existen).
    const phases = []
    const gates  = []
    let totalRuns = 0
    let mult = 1  // multiplicador de lanes (se propaga hacia adelante cuando se conoce)

    for (let i = 0; i < chain.length; i++) {
      const bp = chain[i]
      const nodeCount = bp._isCurrent
        ? await countRunnable(bp.id)
        : (bp.node_sequence || []).length

      phases.push({
        blueprint_id: bp.id,
        name:         bp.name,
        phase:        bp.phase,
        node_count:   nodeCount,
        is_current:   !!bp._isCurrent,
        sealed:       bp._isCurrent ? activeRow.gate_decision === 'ACCEPT' : false,
      })
      totalRuns += nodeCount * mult

      // Gate entre esta fase y la siguiente
      const next = chain[i + 1]
      if (next) {
        const fan = await detectFanOut({
          project_id,
          current_blueprint_id: bp.id,
          nextBlueprint:        next,
          db,
        })
        gates.push({
          blueprint_id: bp.id,
          name:         bp.gate?.name || `${bp.phase} gate`,
          will_fan_out: fan.willFanOut,
          configured:   fan.configured,
          item_count:   fan.itemCount,
          item_type:    fan.itemType,
        })
        // Si este gate hace fan-out con N ítems, la fase siguiente corre N veces (lanes).
        // Cap a 5: el motor real (fan-out.service) limita a items.slice(0,5) lanes.
        if (fan.willFanOut && fan.itemCount) mult *= Math.min(fan.itemCount, 5)
      }
    }

    res.json({
      success:               true,
      requires_authorization: gates.length > 0,
      phases,
      gates,
      estimated: {
        node_runs:         totalRuns,
        avg_cost_per_node: parseFloat(avgCost.toFixed(6)),
        cost_usd:          parseFloat((totalRuns * avgCost).toFixed(4)),
        is_estimated:      true,
      },
      remembered,
    })
  } catch (err) { next(err) }
})

// ─── PATCH /api/projects/:id/canvas/run-config ───────────────────
// Persiste la autorización de gates en projects.run_config (merge no destructivo) (#4).
router.patch('/run-config', async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    const { data: projRow } = await db()
      .from('projects')
      .select('run_config')
      .eq('id', project_id)
      .single()
    const merged = { ...(projRow?.run_config || {}), ...(req.body || {}) }
    await db().from('projects').update({ run_config: merged }).eq('id', project_id)
    res.json({ success: true, run_config: merged })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/canvas/nodes/:project_node_id/auto-run ──
// Ejecuta un nodo en modo autopilot y lo auto-aprueba como auto_approved
router.post('/nodes/:project_node_id/auto-run', async (req, res, next) => {
  try {
    const { id: project_id, project_node_id } = req.params
    const { member_id } = req.body

    // Frente 4: gate de crédito antes de correr el nodo
    if (!(await creditGate(project_id, res, req.auth?.memberId))) return

    const { propagateStale } = require('../services/canvas-chat.service')

    // Obtener el forge_node_id desde el project_node_id
    const { data: pNode } = await db()
      .from('forge_project_nodes')
      .select('node_id, node_type, blueprint_id, is_stale')
      .eq('id', project_node_id)
      .eq('removed', false)
      .maybeSingle()

    if (!pNode || pNode.node_type !== 'forge_node') {
      return res.status(404).json({ success: false, error: 'Project node not found or not a forge_node' })
    }

    // Guard: no re-ejecutar nodos de un blueprint cuyo gate ya fue ACCEPT (sellado).
    // Es la garantía dura — protege re-runs directos y los del loop de pipeline (#5).
    if (await isBlueprintSealed(project_id, pNode.blueprint_id)) {
      return res.status(423).json({
        success:    false,
        error_code: 'gate_sealed',
        error:      'This step belongs to a sealed phase — re-running is locked after the gate was accepted',
      })
    }

    const node_id = pNode.node_id

    // DNA del nodo — para calcular qué outputs faltan
    const { data: nodeDna } = await db()
      .from('forge_nodes')
      .select('id, title, outputs')
      .eq('id', node_id)
      .single()

    // Targets: un output explícito (re-run manual de un output) o TODOS los pendientes.
    // Bug A: Run nunca rehace outputs ya aprobados — solo corre lo que falta o está stale.
    // #8: se separan texto e imagen — el texto corre primero para que los outputs de
    //     imagen tengan disponibles sus siblings_if_present al generar.
    const { imageOutputsOf } = require('../services/image-gen.service')
    const explicitKey = req.body.target_output_key || null
    const imageKeys   = new Set(imageOutputsOf(nodeDna || {}).map(o => o.key))

    // `production: "deferred"` — el output se produce en otra etapa y NUNCA bloquea al nodo.
    // El Art Bible es el caso: compone arte de producción aprobado, que en pre-producción no
    // existe. Sin este filtro, un Run despacharía sus 18 páginas contra ComfyUI para nada.
    // Un re-run explícito sí lo permite: si alguien lo pide por su clave, sabe lo que hace.
    const diferidos = new Set(
      (Array.isArray(nodeDna?.outputs) ? nodeDna.outputs : [])
        .filter(o => o.production === 'deferred')
        .map(o => o.key || o.name)
    )

    // El prompt set de un deck NO se le pide al LLM: lo escribe el compositor con los prompts
    // que realmente se despacharon. Son ~6.000 caracteres por página; pedirle 34 a un modelo es
    // quemar tokens para producir algo que nadie usa. Se resuelve en la corrida del deck.
    const { esDeck } = require('../services/image-gen.service')
    const porDeck = new Set()
    for (const o of (Array.isArray(nodeDna?.outputs) ? nodeDna.outputs : [])) {
      if (!(await esDeck(o))) continue
      for (const h of (o.uses?.siblings_if_present || [])) {
        const hDef = nodeDna.outputs.find(x => (x.key || x.name) === h)
        if (hDef?.type === 'connection') porDeck.add(h)
      }
    }

    let textTargets, imageTargets
    if (explicitKey) {
      // Re-run manual de un output concreto: rutea según su tipo
      textTargets  = imageKeys.has(explicitKey) ? [] : [explicitKey]
      imageTargets = imageKeys.has(explicitKey) ? [explicitKey] : []
    } else {
      textTargets  = (await pendingOutputsForNode(project_id, node_id, pNode.is_stale, nodeDna || {}))
        .filter(k => !diferidos.has(k) && !porDeck.has(k))
      imageTargets = (await pendingImageOutputsForNode(project_id, node_id, pNode.is_stale, nodeDna || {}))
        .filter(k => !diferidos.has(k))
    }

    if (!textTargets.length && !imageTargets.length) {
      // Nodo ya satisfecho — no se crea ninguna sesión ni se gasta costo
      return res.json({ success: true, ran: [], skipped: true, message: 'No pending outputs — node already satisfied' })
    }

    // 1) Outputs de texto (secuencial) — sesiones per-output auto-aprobadas.
    //    Un output `assembly: true` NO pasa por el LLM: se ensambla. Re-generar lo que ya está
    //    escrito es justamente el fallo que la DNA llama "regeneration failure".
    const ran = []
    for (const key of textTargets) {
      const d = (Array.isArray(nodeDna?.outputs) ? nodeDna.outputs : []).find(o => (o.key || o.name) === key)
      ran.push(d?.assembly === true
        ? await executeAssemblyOutput({ project_id, node_id, targetOutputKey: key, member_id, project_node_id, nodeDna })
        : await executeOneOutput({ project_id, node_id, targetOutputKey: key, member_id, project_node_id }))
    }

    // 2) Outputs de imagen (post-pass) — ya con los siblings de texto disponibles
    const ranImages = []
    for (const key of imageTargets) {
      // La instancia va con la sesión: con fan-out el mismo nodo del catálogo vive en varios
      // lanes, y sin esto el modal del lane B mostraría lo que produjo el lane A.
      ranImages.push(await executeImageOutput({ project_id, node_id, targetOutputKey: key, member_id, project_node_id }))
    }

    // Limpiar is_stale del nodo y propagar stale a descendientes (una sola vez)
    await db()
      .from('forge_project_nodes')
      .update({ is_stale: false })
      .eq('id', project_node_id)

    await propagateStale(db, project_id, project_node_id)

    res.json({
      success:    true,
      ran:        [...ran.map(r => r.output_key), ...ranImages.map(r => r.output_key)],
      sessions:   ran,
      images:     ranImages,  // [{ output_key, session_id, asset_id, images }]
      // Compat con callers viejos: primer resultado
      session_id: ran[0]?.session_id,
      reply:      ran[0]?.reply,
      doc_url:    ran[0]?.doc_url,
      doc_format: ran[0]?.doc_format,
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

// ─── Iteración de UNA página de un deck ───────────────────────────────────────
// Vuelve a renderizar una sola página y la guarda como VERSIÓN NUEVA del mismo asset. No pisa
// nada: la anterior queda y se puede volver a ella.
//
// Medido: una página tarda 33–36 s. Las 34 juntas tardan 220 s porque se renderizan en paralelo,
// así que una sola no se beneficia de eso — la llamada espera y devuelve la imagen.
//
// No hace falta variar la semilla: probado con el mismo payload dos veces, ComfyUI devolvió
// imágenes distintas. No hay caché por semilla y el modelo no es determinista con ella.
async function versionActual(asset_id) {
  const { data } = await db().from('forge_asset_versions')
    .select('id, version_number').eq('asset_id', asset_id)
    .order('version_number', { ascending: false }).limit(1).maybeSingle()
  return data?.version_number || 0
}

// ─── POST /api/projects/:id/canvas/assets/:asset_id/design-edit ──────────────
// «Design Edits» del moodboard: el usuario pide un cambio de diseño en palabras y la imagen se
// vuelve a generar aplicando SOLO eso.
//
// Se diferencia de /iterate en que no rehace la página desde el documento: parte de la imagen que
// ya existe y la edita. Sirve para cualquier activo de imagen, no solo para las páginas de un deck.
//
// El prompt del workflow trae un andamiaje alrededor de un token —«mantén la plantilla exacta:
// mismo layout, cajas, textos, tipografías…»— y ESE andamiaje es la garantía de que la iteración
// no destruya la página. Por eso se sustituye el token y no se reemplaza el prompt.
router.post('/assets/:asset_id/design-edit', async (req, res, next) => {
  try {
    const { id: project_id, asset_id } = req.params
    const member_id = req.body?.member_id || null
    const pedido    = String(req.body?.prompt || '').trim()
    if (!pedido) return res.status(400).json({ success: false, error: 'Describe the design change' })

    const { data: asset } = await db().from('forge_assets')
      .select('id, node_id, project_id, name, storage_url, format')
      .eq('id', asset_id).eq('project_id', project_id).single()
    if (!asset)             return res.status(404).json({ success: false, error: 'Asset not found' })
    if (!asset.storage_url) return res.status(400).json({ success: false, error: 'This asset has no image to edit' })

    const { getWorkflowByName } = require('../services/config.service')
    const entry = await getWorkflowByName('V57_STUDIO_Moodboard_Iteration')
    if (!entry) return res.status(500).json({ success: false, error: 'Moodboard iteration workflow is not registered' })

    const cfg = entry.inject_config || {}
    const wf  = JSON.parse(JSON.stringify(entry.workflow_json))

    // La imagen a editar: la versión vigente del asset, subida al input de ComfyUI.
    const { uploadImageToComfyUI, pollUntilDone, downloadOutput } = require('../services/providers/comfyui.provider')
    const subida = await uploadImageToComfyUI(asset.storage_url)
    if (cfg.image?.node) wf[cfg.image.node].inputs[cfg.image.field] = subida

    // El token, no el prompt entero.
    if (cfg.prompt?.node) {
      const campo = cfg.prompt.field
      const base  = String(wf[cfg.prompt.node].inputs[campo] || '')
      const token = cfg.prompt.token || '[ USER PROMPT ]'
      wf[cfg.prompt.node].inputs[campo] = base.includes(token)
        ? base.split(token).join(pedido)
        : `${pedido}\n\n${base}`   // si alguien quita el token, el pedido igual llega
    }
    if (cfg.seed?.node) wf[cfg.seed.node].inputs[cfg.seed.field] = Math.floor(Math.random() * 2 ** 31)

    const BASE = (process.env.COMFYUI_BASE_URL || '').replace(/\/$/, '')
    const KEY  = process.env.COMFYUI_API_KEY
    const r = await fetch(`${BASE}/api/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({ prompt: wf, ...(KEY ? { extra_data: { api_key_comfy_org: KEY } } : {}) }),
    })
    const txt = await r.text()
    if (!r.ok) throw new Error(`ComfyUI rechazó la edición: ${r.status} ${txt.slice(0, 300)}`)
    const jobId = JSON.parse(txt).prompt_id

    await pollUntilDone(jobId, 180000)
    const destino = `projects/${project_id}/design-edits/${asset_id}-${Date.now()}.png`
    const salida  = await downloadOutput(jobId, destino)
    if (!salida?.url) return res.status(502).json({ success: false, error: 'The workflow returned no image' })

    // Misma regla que la iteración del deck: la versión nueva pasa a ser la vigente, pero NO
    // aprobada. Aprobar es un acto del usuario.
    let ultima = await versionActual(asset_id)
    if (ultima === 0) {
      await db().from('forge_asset_versions').insert({
        asset_id, storage_url: asset.storage_url, version_number: 1, is_current: false,
        metadata: { origen: 'imagen original' },
      })
      ultima = 1
    }
    await db().from('forge_asset_versions').update({ is_current: false }).eq('asset_id', asset_id)
    const { data: ver, error: vErr } = await db().from('forge_asset_versions').insert({
      asset_id, storage_url: salida.url, version_number: ultima + 1, is_current: true,
      created_by: member_id,
      metadata: { job: jobId, design_edit: pedido, workflow: 'V57_STUDIO_Moodboard_Iteration' },
    }).select('id, version_number').single()
    if (vErr) throw vErr

    await db().from('forge_assets').update({ storage_url: salida.url }).eq('id', asset_id)

    res.json({
      success: true,
      version: { id: ver.id, version_number: ver.version_number, storage_url: salida.url },
      job: jobId,
    })
  } catch (err) { next(err) }
})

router.post('/assets/:asset_id/iterate', async (req, res, next) => {
  try {
    const { id: project_id, asset_id } = req.params
    const member_id = req.body?.member_id || null

    const { data: asset } = await db().from('forge_assets')
      .select('id, node_id, project_id, session_id, name, storage_url, format')
      .eq('id', asset_id).eq('project_id', project_id).single()
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' })

    const { data: ses } = await db().from('forge_sessions')
      .select('output_key, project_node_id').eq('id', asset.session_id).maybeSingle()
    const { data: dna } = await db().from('forge_nodes')
      .select('node_key, title, outputs').eq('id', asset.node_id).single()
    const outs = Array.isArray(dna?.outputs) ? dna.outputs : []

    // La página que es este asset: su nombre termina con el de la página («… — 09_ColorSystem»).
    const sufijo = String(asset.name).split('—').pop().trim()

    // Primero por la clave de la sesión. Si no aparece, se resuelve por NOMBRE DE PÁGINA: los
    // outputs se renombran —v2.9.7 partió `art_style_guide_images` en contenido y síntesis— y los
    // assets ya generados conservan la clave vieja. El nombre de la página no cambia.
    let def = outs.find(o => (o.key || o.name) === ses?.output_key)
    if (!def?.image_gen_model) {
      def = outs.find(o => o.image_gen && (o.page_prefixes || []).includes(sufijo))
    }
    if (!def?.image_gen_model) {
      return res.status(400).json({
        success: false,
        error: `This asset does not come from an image output (session key "${ses?.output_key}", page "${sufijo}")`,
      })
    }

    const { esDeck, generateDeck } = require('../services/image-gen.service')
    if (!await esDeck(def)) {
      return res.status(400).json({ success: false, error: 'Only deck pages can be iterated page by page' })
    }

    const { composeDeck, DECKS } = require('../services/slide-composer.service')
    const wfName = String(def.image_gen_model).replace(/^comfyui:/, '')
    const deck = Object.entries(DECKS).find(([, c]) => c.workflow === wfName)?.[0]
    const todas = await composeDeck({ db, projectId: project_id, deck })
    const pag = todas.paginas.find(p => p.nombre === sufijo)
    if (!pag) {
      return res.status(400).json({ success: false, error: `No page named "${sufijo}" in ${wfName}` })
    }

    // Sin `session_id`: generateDeck escribiría output_images con SOLO esta página y borraría
    // las otras 33 del listado. La persistencia de una iteración es la versión, no la sesión.
    const r = await generateDeck({
      db, project_id, node_id: asset.node_id, session_id: null,
      node_key: dna.node_key, output_key: ses.output_key,
      image_gen_model: def.image_gen_model, member_id, solo: [pag.indice],
    })
    const nueva = r.paginas[0]
    if (!nueva) return res.status(502).json({ success: false, error: 'The workflow returned no image' })

    // La v1 es lo que había ANTES. Si no existe se crea ahora, porque si no el historial arranca
    // en la 2 y no hay a dónde volver.
    let ultima = await versionActual(asset_id)
    if (ultima === 0 && asset.storage_url) {
      await db().from('forge_asset_versions').insert({
        asset_id, storage_url: asset.storage_url, version_number: 1, is_current: false,
        metadata: { origen: 'render inicial del deck' },
      })
      ultima = 1
    }

    await db().from('forge_asset_versions').update({ is_current: false }).eq('asset_id', asset_id)
    const { data: ver, error: vErr } = await db().from('forge_asset_versions').insert({
      asset_id, storage_url: nueva.url, version_number: ultima + 1, is_current: true,
      created_by: member_id,
      metadata: { job: r.jobId, pagina: pag.indice, nombre: pag.nombre, workflow: wfName, segundos: r.segundos },
    }).select('id, version_number').single()
    if (vErr) throw vErr

    // La vigente es la que ve la galería y la que consumen los nodos de aguas abajo.
    await db().from('forge_assets').update({ storage_url: nueva.url }).eq('id', asset_id)

    res.json({
      success: true,
      version: { id: ver.id, version_number: ver.version_number, storage_url: nueva.url },
      pagina: { indice: pag.indice, nombre: pag.nombre },
      job: r.jobId, segundos: r.segundos,
    })
  } catch (err) { next(err) }
})

// ─── Elegir qué versión queda ─────────────────────────────────────────────────
// Aprobar es del usuario y es distinto de «vigente»: una versión puede estar a la vista sin
// haber sido aprobada, que es justo como queda apenas termina una iteración.
router.post('/assets/:asset_id/versions/:version_id/approve', async (req, res, next) => {
  try {
    const { id: project_id, asset_id, version_id } = req.params
    const member_id = req.body?.member_id || null

    const { data: asset } = await db().from('forge_assets')
      .select('id').eq('id', asset_id).eq('project_id', project_id).single()
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' })

    const { data: ver } = await db().from('forge_asset_versions')
      .select('id, storage_url, version_number, metadata').eq('id', version_id).eq('asset_id', asset_id).single()
    if (!ver) return res.status(404).json({ success: false, error: 'Version not found' })

    await db().from('forge_asset_versions').update({ is_current: false }).eq('asset_id', asset_id)
    await db().from('forge_asset_versions').update({
      is_current: true,
      // La aprobación va en metadata y no en una columna nueva: no hace falta migrar, y el
      // `status` del asset se usa en otros lados donde esto no significa lo mismo.
      metadata: { ...(ver.metadata || {}), approved_at: new Date().toISOString(), approved_by: member_id },
    }).eq('id', version_id)

    await db().from('forge_assets').update({
      storage_url: ver.storage_url, approved_by: member_id, approved_at: new Date().toISOString(),
    }).eq('id', asset_id)

    res.json({ success: true, version_number: ver.version_number, storage_url: ver.storage_url })
  } catch (err) { next(err) }
})

module.exports = router
