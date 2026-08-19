// ─── Servicio de generación de imágenes ───────────────────────────────────────
// Núcleo reutilizable extraído de la ruta generate-item-image. Lo usan:
//  · la ruta on-demand /generate-item-image (botón ✦ del frontend)
//  · executeImageOutput() en el auto-run (Run All / scoped runs)
//
// Principio: el ADN manda. El conteo de imágenes NO se hardcodea — sale de cuántos
// ítems produzca el contenido del output (parseOutputItems), tal como pida su prompt.

const { logExecution } = require('./execution-log.service')

// ─── Filtro estricto de outputs de imagen auto-generables ──────────────────────
// Solo png/image con image_gen:true. Los outputs prose/markdown con image_gen:true
// (botón ✦ manual) quedan user-decided y NO se auto-generan.
function imageOutputsOf(node) {
  const outs = (Array.isArray(node?.outputs) ? node.outputs : []).map(o => ({ ...o, key: o.key || o.name }))
  return outs.filter(o => o.key && o.image_gen === true && (o.format === 'png' || o.format === 'image'))
}

// ─── Port de parseOutputItems (frontend NodeChatWindow.tsx) ────────────────────
// Diferencia clave con el frontend: NO se colapsa png/image a 1 ítem. El contenido
// se parsea en N ítems (la lista de prompts que escribe el agente) → N imágenes.
// Respeta el ADN: si el prompt pide "2–3 imágenes", el agente produce 2–3 prompts.
function parseOutputItems(content, format) {
  if (format === 'json') {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) return parsed.map(String).filter(s => s.trim().length > 0)
    } catch { /* continúa */ }
  }

  // Bullet list: "- item", "* item", "• item"
  const bulletRx   = /^[ \t]*[-*•][ \t]+(.+)$/gm
  // Numbered list: "1. item", "1) item"
  const numberedRx = /^[ \t]*\d+[.)]\s+(.+)$/gm
  // Markdown heading con número: "## 1. title", "### Variation 1: title"
  const headingRx  = /^#{1,4}\s+(?:\*{0,2})(?:[A-Za-z]+\s+)?\d+[:.)]?\s+(.+)$/gm

  const bullets = [...content.matchAll(bulletRx)].map(m => m[1].trim())
  if (bullets.length > 0) return bullets

  const numbered = [...content.matchAll(numberedRx)].map(m => m[1].trim())
  if (numbered.length > 0) return numbered

  // Labeled con descripción: dividir por cada "Variation N:" y capturar el bloque completo
  const labeledParts = content
    .split(/(?=^[A-Za-z]+[ \t]+\d+[:.]\s)/m)
    .map(p => p.trim())
    .filter(p => /^[A-Za-z]+[ \t]+\d+[:.]\s/.test(p))
  if (labeledParts.length > 0) return labeledParts

  // Heading con número + contenido subsiguiente (bloque completo por ítem)
  const richBlocks = []
  const richRx = /^#{1,4}[ \t]+([^\n]+(?:\n(?!#{1,4}[ \t])[^\n]*)*)/gm
  for (const m of content.matchAll(richRx)) {
    const block = m[1].trim()
    if (/^(?:\*{0,2})(?:[A-Za-z]+[ \t]+)+\d+/.test(block)) richBlocks.push(block)
  }
  if (richBlocks.length > 0) return richBlocks

  const headings = [...content.matchAll(headingRx)].map(m => m[1].trim())
  if (headings.length > 0) return headings

  // Bloques tipo "Seed 001" / "Concept 002" — encabezado plano sin # ni delimitador
  const seedBlocks = content
    .split(/(?=^[A-Za-z][A-Za-z ]*[ \t]+\d{1,4}\s*$)/m)
    .map(p => p.trim())
    .filter(p => /^[A-Za-z][A-Za-z ]*[ \t]+\d{1,4}/.test(p) && p.length > 40)
  if (seedBlocks.length > 1) return seedBlocks

  // Fallback: el contenido completo es un solo prompt → 1 imagen
  const trimmed = content.trim()
  return trimmed ? [trimmed.slice(0, 700)] : []
}

// ─── Limpieza de markdown del texto del ítem para usarlo como prompt visual ────
function cleanItemText(text) {
  return (text || '').trim()
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')  // quitar negrita/cursiva
    .replace(/^[-*]\s+/, '')                    // quitar bullet inicial
    .replace(/^(Variation\s+\d+:\s*)/i, '')     // quitar prefijo "Variation N:"
}

// ─── Genera UNA imagen y devuelve { url } ──────────────────────────────────────
// No toca la base de datos (salvo el log de costo no bloqueante). El caller decide
// cómo persistir (output_images / forge_assets).
async function generateOneImage({
  project_id, node_id, session_id, node_key,
  output_key, image_gen_model, item_index, item_text, condition, member_id,
}) {
  if (!image_gen_model) {
    throw new Error(`Output "${output_key}" no tiene image_gen_model definido`)
  }

  // Parsear "provider:model_o_workflow"
  const colonIdx = image_gen_model.indexOf(':')
  if (colonIdx < 0) {
    throw new Error(`image_gen_model debe tener formato "provider:model" — recibido: "${image_gen_model}"`)
  }
  const provider  = image_gen_model.slice(0, colonIdx)
  const modelOrWf = image_gen_model.slice(colonIdx + 1)

  const storagePath = `projects/${project_id}/item-images/${node_key}/${output_key}-${session_id}-${item_index}-${Date.now()}.png`

  // Construir prompt final con la condición de variación opcional
  const cleanText = cleanItemText(item_text)
  const imagePrompt = condition?.trim()
    ? `${cleanText}\n\nAdditional visual requirement: ${condition.trim()}`
    : cleanText

  const imgStart = Date.now()

  let result
  if (provider === 'comfyui') {
    const { generateImageComfyUI } = require('./providers/comfyui.provider')
    result = await generateImageComfyUI(modelOrWf, imagePrompt, 1024, 1024, storagePath)
  } else if (provider === 'openai') {
    const { generateImageOpenAI } = require('./providers/openai.image.provider')
    result = await generateImageOpenAI(modelOrWf, imagePrompt, 1024, 1024, storagePath)
  } else if (provider === 'fal') {
    const { generateImageFal } = require('./providers/fal.image.provider')
    result = await generateImageFal(modelOrWf, imagePrompt, 1024, 1024, storagePath)
  } else {
    throw new Error(`Provider de imagen no soportado: "${provider}"`)
  }

  // Registrar costo estimado (no bloqueante, nunca rompe el flujo)
  try {
    logExecution({
      project_id, node_id, session_id,
      triggered_by:  member_id || null,
      trigger_type:  'image_gen',
      executor_type: provider === 'openai' ? 'openai_image' : provider,
      provider,
      model:         modelOrWf,
      is_estimated:  true,
      duration_ms:   Date.now() - imgStart,
      started_at:    new Date(imgStart).toISOString(),
      status:        'success',
      metadata:      { output_key, item_index, width: 1024, height: 1024, node_key },
    })
  } catch (logErr) {
    console.error('[image-gen.service] logExec failed (non-fatal):', logErr.message)
  }

  return { url: result.url, provider, model: modelOrWf }
}

// ¿Este output es un DECK? Lo decide el workflow que declara la DNA, no una lista de node_keys:
// si está registrado `per_page`, sus páginas van en un solo job. Devuelve false ante cualquier
// duda —modelo mal formado, workflow sin registrar— para que el camino de siempre siga andando.
async function esDeck(outDef) {
  const modelo = outDef?.image_gen_model
  if (!modelo || !String(modelo).startsWith('comfyui:')) return false
  try {
    const { getWorkflowByName } = require('./config.service')
    const entry = await getWorkflowByName(String(modelo).slice('comfyui:'.length))
    return entry?.inject_config?.mode === 'per_page'
  } catch { return false }
}

// ─── Despacho de un DECK (workflows `per_page`) ───────────────────────────────
// El modelo de arriba —un ítem, una llamada, una imagen— no sirve para los decks del 3.20: su
// workflow no es "una imagen por invocación", son 34 páginas fijas dentro del MISMO grafo, cada
// una con su plantilla y su prompt. Llamarlo 34 veces está mal por construcción; se manda UN
// job con las 34 páginas ya pobladas y las imágenes llegan progresivamente.
//
// Los prompts los arma `composeDeck` desde los documentos del proyecto, no el LLM: son ~6.000
// caracteres por página, y pedirle a un modelo que emita 34 de esos en una respuesta (~200.000
// caracteres) no es viable. El LLM sigue haciendo su trabajo en el nodo; lo que se resuelve por
// código es el poblado, que es determinista y verificable.
//
// Portado de `Moodboard/prueba_guia_completa.js`, que ya corrió 32/32 en 247 s.
async function generateDeck({
  db, project_id, node_id, session_id, node_key, output_key,
  image_gen_model, deck, member_id, onPage,
}) {
  const { composeDeck, DECKS } = require('./slide-composer.service')
  const { getWorkflowByName } = require('./config.service')
  const { uploadToStorage } = require('./storage.service')

  const colonIdx = String(image_gen_model || '').indexOf(':')
  if (colonIdx < 0) throw new Error(`image_gen_model debe ser "provider:workflow" — recibido: "${image_gen_model}"`)
  const provider = image_gen_model.slice(0, colonIdx)
  const wfName   = image_gen_model.slice(colonIdx + 1)
  if (provider !== 'comfyui') throw new Error(`Un deck solo se despacha por comfyui, no por "${provider}"`)

  // El deck se deduce del workflow que declara la DNA: quien llama no tiene por qué saber que
  // `V57_STUDIO_ArtStyleGuide_Template` se llama 'asg' acá adentro.
  deck = deck || Object.entries(DECKS).find(([, c]) => c.workflow === wfName)?.[0]
  if (!deck) throw new Error(`No hay deck registrado para el workflow "${wfName}"`)

  const entry = await getWorkflowByName(wfName)
  if (!entry) throw new Error(`Workflow no registrado: "${wfName}"`)
  if (entry.inject_config?.mode !== 'per_page') {
    throw new Error(`El workflow "${wfName}" no está marcado per_page; no es un deck`)
  }

  // 1. Poblar: se clona el grafo y se le escribe a cada página su prompt.
  const armado = await composeDeck({ db, projectId: project_id, deck })
  const wf = JSON.parse(JSON.stringify(entry.workflow_json))
  for (const p of armado.paginas) {
    if (wf[p.prompt_node]?.inputs) wf[p.prompt_node].inputs.prompt = p.prompt
  }
  const porSaveNode = Object.fromEntries(armado.paginas.map(p => [p.save_node, p]))

  const BASE = (process.env.COMFYUI_BASE_URL || '').replace(/\/$/, '')
  const KEY  = process.env.COMFYUI_API_KEY
  const H    = () => ({ 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) })

  const t0  = Date.now()
  const res = await fetch(`${BASE}/api/prompt`, {
    method: 'POST', headers: H(),
    body: JSON.stringify({ prompt: wf, ...(KEY ? { extra_data: { api_key_comfy_org: KEY } } : {}) }),
  })
  const txt = await res.text()
  if (!res.ok) throw new Error(`ComfyUI rechazó el deck: ${res.status} ${txt.slice(0, 400)}`)
  const jobId = JSON.parse(txt).prompt_id

  // 2. Poll con descarga PROGRESIVA: cada página se sube apenas llega, así una caída a mitad
  //    de camino no pierde lo ya rendido.
  const paginas = []
  const vistos  = new Set()
  const total   = armado.paginas.length
  for (let it = 0; it < 480 && vistos.size < total; it++) {
    await new Promise(r => setTimeout(r, 5000))
    let j = null
    try { j = await (await fetch(`${BASE}/api/jobs/${jobId}`, { headers: H() })).json() } catch { continue }
    const estado = j?.status || j?.execution_status || ''

    for (const [nodeId, nd] of Object.entries(j?.outputs || {})) {
      for (const f of (nd?.images || [])) {
        if (!f.filename || vistos.has(f.filename)) continue
        vistos.add(f.filename)
        const pag = porSaveNode[nodeId]
        const url = `${BASE}/api/view?filename=${encodeURIComponent(f.filename)}` +
                    `&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${f.type || 'output'}`
        try {
          const ir = await fetch(url, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {}, redirect: 'follow' })
          if (!ir.ok) continue
          const buf  = Buffer.from(await ir.arrayBuffer())
          const dest = `projects/${project_id}/deck/${node_key}/${output_key}/${pag?.nombre || f.filename}.png`
          const url2 = await uploadToStorage(buf, dest, 'image/png')
          const item = { index: (pag?.indice ?? paginas.length + 1) - 1, name: pag?.nombre || f.filename, url: url2 }
          paginas.push(item)

          // Se anota en la sesión apenas llega, no al final: es lo que lee el modal del nodo
          // (`forge_sessions.output_images`), y escribirlo progresivamente hace que las páginas
          // aparezcan mientras el deck todavía se está rindiendo. Sin esto el nodo corre, sube
          // las imágenes y en pantalla no se ve nada.
          if (session_id) {
            try {
              await db().from('forge_sessions').update({
                output_images: {
                  [output_key]: [...paginas]
                    .sort((x, y) => x.index - y.index)
                    .map(p => ({ index: p.index, name: p.name, variations: [{ url: p.url, condition: null }] })),
                },
              }).eq('id', session_id)
            } catch (e) { console.error('[deck] no se pudo anotar la página en la sesión:', e.message) }
          }

          onPage?.(item, vistos.size, total)
        } catch (e) { console.error('[deck] página perdida:', e.message) }
      }
    }
    if (/error|fail/i.test(estado) && it > 3) break
    if (/completed|success/i.test(estado) && vistos.size >= total) break
  }

  try {
    logExecution({
      project_id, node_id, session_id,
      triggered_by: member_id || null,
      trigger_type: 'image_gen', executor_type: 'comfyui', provider: 'comfyui', model: wfName,
      is_estimated: true, duration_ms: Date.now() - t0,
      started_at: new Date(t0).toISOString(),
      status: paginas.length === total ? 'success' : 'partial',
      metadata: { output_key, node_key, deck, jobId, paginas: paginas.length, esperadas: total },
    })
  } catch (e) { console.error('[deck] logExec falló (no fatal):', e.message) }

  // Los huecos viajan con el resultado: son lo que hay que ver ANTES de aprobar, no algo que se
  // descubre tres semanas después mirando una página en blanco.
  const huecos = armado.paginas
    .filter(p => p.faltantes.length)
    .map(p => ({ pagina: p.nombre, falta: p.faltantes }))

  return {
    jobId, paginas, esperadas: total, huecos,
    // Lo que REALMENTE se le mandó a ComfyUI. Es el contenido del prompt set: el output existe
    // para poder auditar qué se pidió, y hasta ahora se lo pedíamos a un modelo que no puede
    // escribirlo. Se emite el que se usó.
    prompts: armado.paginas.map(p => ({ indice: p.indice, nombre: p.nombre, prompt: p.prompt })),
    segundos: Math.round((Date.now() - t0) / 1000), avisos: armado.avisos,
  }
}

module.exports = { imageOutputsOf, parseOutputItems, cleanItemText, generateOneImage, generateDeck, esDeck }
