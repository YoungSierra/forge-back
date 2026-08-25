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
    // Arte del proyecto como segunda imagen, si el workflow lo pide.
    //
    // El one-pager del 2.5 recibe DOS imágenes con papeles distintos: la plantilla de layout, que
    // viene con el workflow y de la que se copia la composición, y el arte del juego, del que se
    // toma el aspecto. Ese segundo hueco viene desconectado a propósito: si no hay arte del
    // proyecto NO se enchufa nada. Conectar un relleno sería decirle al modelo «así se ve este
    // juego» con una imagen ajena — el error que nos costó una corrida del ASG.
    const refProyecto = await imagenDelProyecto(project_id, node_id).catch(() => null)
    result = await generateImageComfyUI(modelOrWf, imagePrompt, 1024, 1024, storagePath,
      refProyecto ? { ref_proyecto: refProyecto } : {})
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

// ─── El arte del proyecto que le entra a un nodo ──────────────────────────────
// Se busca entre lo que ESTE nodo recibe por sus cables, no en todo el proyecto: el 2.5 declara
// `orientation_images` y `pitch_images` como entradas, y esas son las que deben ilustrarlo. Gana
// la más reciente aprobada; si no hay ninguna, se devuelve null y el hueco queda sin conectar.
async function imagenDelProyecto(projectId, nodeId) {
  const { db } = require('./supabase.service')
  const { data: pns } = await db()
    .from('forge_project_nodes').select('id').eq('project_id', projectId).eq('node_id', nodeId).eq('removed', false)
  if (!pns?.length) return null

  const { data: edges } = await db()
    .from('forge_project_edges').select('source_node_id')
    .eq('project_id', projectId).in('target_node_id', pns.map(p => p.id))
  if (!edges?.length) return null

  const { data: fuentes } = await db()
    .from('forge_project_nodes').select('node_id').in('id', [...new Set(edges.map(e => e.source_node_id))])
  const ids = [...new Set((fuentes || []).map(f => f.node_id).filter(Boolean))]
  if (!ids.length) return null

  const { data: png } = await db()
    .from('forge_assets').select('storage_url')
    .eq('project_id', projectId).in('node_id', ids)
    .eq('format', 'png').in('status', ['approved', 'auto_approved'])
    .not('storage_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  return png?.storage_url ?? null
}

// ─── La imagen de referencia de una página, por el NOMBRE del nodo que la produce ─────
//
// El prompt de la página nombra su fuente en prosa: «coming from Pitch Document», «coming from
// Concept Exploration + Visual Orientation». Se resuelve contra el título del nodo en el catálogo
// en vez de contra una tabla acá adentro: si mañana una página cambia de fuente, el motor la
// sigue sin tocar código.
//
// Con varias fuentes («A + B») gana la primera que tenga imagen: el orden en que están escritas
// es el orden de preferencia de quien armó la plantilla.
// ─── La página del ASG que una página del Art Bible toma como canon ───────────
//
// El Art Bible no parte de una plantilla: cada página recibe la página YA RENDERIZADA del Art
// Style Guide de ese mismo proyecto y pinta la obra final de ese tema. El prompt la cita por
// número y nombre —«Art Style Guide (ASG · 05 Character Design Language)»—, y el ASG guarda sus
// páginas como assets llamados «Art Style Guide — 05_CharacterDesign».
//
// El emparejamiento va por NÚMERO. Los nombres no coinciden entre los dos lados («05 Character
// Design Language» contra `05_CharacterDesign`) y el número sí es el mismo en ambos.
async function paginaDelASG(db, projectId, numero) {
  const { data: n } = await db().from('forge_nodes').select('id').eq('node_key', '3.20').maybeSingle()
  if (!n) return null
  const { data: assets } = await db()
    .from('forge_assets')
    .select('name, storage_url, created_at')
    .eq('project_id', projectId).eq('node_id', n.id)
    .eq('format', 'png').in('status', ['approved', 'auto_approved'])
    .not('storage_url', 'is', null)
    .order('created_at', { ascending: false })
  // Se busca el número y nada más. Atar el patrón al guion largo del nombre —«Art Style Guide —
  // 01_KeyArt»— es frágil: ese carácter ya causó un problema de emparejamiento antes, y basta que
  // alguien renombre el separador para que deje de encontrar nada.
  const dosDigitos = String(numero).padStart(2, '0')
  const hit = (assets || []).find(a => new RegExp(`(?:^|\\D)${dosDigitos}_`).test(a.name || ''))
  return hit?.storage_url ?? null
}

async function imagenDeNodoPorTitulo(db, projectId, fuente) {
  const nombres = String(fuente || '').split('+').map(s => s.trim()).filter(Boolean)
  if (!nombres.length) return null

  // Solo entre los nodos que este proyecto tiene en el canvas. El catálogo repite títulos —hay un
  // «Pitch Document» archivado con clave 99.2.1 además del 2.1 vivo— y buscar en él a secas
  // devuelve el equivocado, que además nunca produjo nada en este proyecto.
  const { data: pns } = await db()
    .from('forge_project_nodes').select('node_id').eq('project_id', projectId).eq('removed', false)
  const enProyecto = new Set((pns || []).map(p => p.node_id).filter(Boolean))
  const { data: catalogo } = await db().from('forge_nodes').select('id, title')
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  for (const nombre of nombres) {
    const nodo = (catalogo || []).find(n => enProyecto.has(n.id) && norm(n.title) === norm(nombre))
    if (!nodo) continue

    // Aprobadas primero, y la más reciente: es la que el usuario dejó como buena.
    const { data: png } = await db()
      .from('forge_assets')
      .select('storage_url, created_at')
      .eq('project_id', projectId).eq('node_id', nodo.id)
      .eq('format', 'png').in('status', ['approved', 'auto_approved'])
      .not('storage_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle()
    if (png?.storage_url) return png.storage_url

    // Sin asset png, las que viven en la sesión: un output de imagen recién corrido todavía no
    // pasó por Accept y aun así sirve como referencia.
    const { data: ses } = await db()
      .from('forge_sessions')
      .select('output_images')
      .eq('project_id', projectId).eq('node_id', nodo.id)
      .not('output_images', 'is', null)
      .order('created_at', { ascending: false })
    for (const s of (ses || [])) {
      for (const items of Object.values(s.output_images || {})) {
        for (const it of (items || [])) {
          const url = it?.variations?.length ? it.variations[it.variations.length - 1]?.url : it?.url
          if (url) return url
        }
      }
    }
  }
  return null
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
  image_gen_model, deck, member_id, onPage, fills = null, solo = null, outDef = null,
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

  // ¿Qué páginas del workflow le tocan a este output? El ASG se parte en 31 de contenido + 3 de
  // síntesis sobre el MISMO workflow, así que sin acotar cada output renderizaría las 34.
  //
  // Tiene que venir declarado en `outDef.pages`. NO se deduce: probamos las dos vías obvias y las
  // dos fallan. Por número, porque el prompt de la síntesis dice «summarise the other 31» y ese
  // 31 se cuela como si fuera una página. Por nombre, porque la pasada A no nombra sus slides
  // —solo da rangos— y la B las llama distinto que el workflow («One-Page Style Summary» contra
  // `26_OnePageSummary`). Adivinar acá cuesta renderizar 34 páginas cuando querías 3.
  if (!solo && outDef?.image_count && outDef.image_count !== entry.inject_config.pages.length) {
    throw new Error(
      `El output "${output_key}" declara ${outDef.image_count} de las ${entry.inject_config.pages.length} ` +
      `páginas del workflow, pero no dice CUÁLES. Hace falta el campo \`pages\` en la DNA del output.`)
  }

  // 1. Poblar: se clona el grafo y se le escribe a cada página su prompt.
  const armado = await composeDeck({ db, projectId: project_id, deck, fills, solo })
  let wf = JSON.parse(JSON.stringify(entry.workflow_json))
  for (const p of armado.paginas) {
    if (wf[p.prompt_node]?.inputs) wf[p.prompt_node].inputs.prompt = p.prompt
  }

  // 1a. El nombre del juego. Las 26 páginas del Art Bible abren con un recuadro «FILL IN ONCE ·
  // GAME NAME ▶ [ PASTE THE CURRENT GAME'S TITLE HERE ]» y todo el prompt se refiere después a
  // «the GAME NAME above». Sin rellenarlo, esa instrucción viaja literal al modelo.
  {
    const { data: proyecto } = await db().from('projects').select('name').eq('id', project_id).maybeSingle()
    const titulo = (proyecto?.name || '').trim()
    if (titulo) {
      for (const p of armado.paginas) {
        const n = wf[p.prompt_node]
        if (typeof n?.inputs?.prompt === 'string') {
          n.inputs.prompt = n.inputs.prompt.replace(/\[\s*PASTE THE CURRENT GAME'?S TITLE HERE\s*\]/gi, titulo)
        }
      }
    }
  }

  // 1b. La SEGUNDA imagen de las páginas que la piden.
  //
  // Desde la revisión del 24-ago, algunas páginas reciben dos imágenes: la plantilla y una
  // referencia de estilo. El propio prompt dice de dónde sale esa referencia —«IMAGE 2 = a VISUAL
  // REFERENCE for this page coming from Pitch Document»— y en el workflow viene con una imagen de
  // relleno, un caballero de fantasía que no tiene nada que ver con el juego. Sin reemplazarla, el
  // modelo tomaría ESA como el estilo del proyecto: peor que no darle ninguna referencia.
  //
  // El nodo de origen se resuelve por el nombre que declara el prompt, no por una tabla acá: si
  // mañana una página cambia de fuente, cambia sola.
  const avisosRef = []
  const sinRef    = new Set()
  {
    const conBatch = armado.paginas.filter(p => {
      const gpt = wf[p.prompt_node]
      const src = Object.values(gpt?.inputs || {}).find(v => Array.isArray(v))
      return wf[src?.[0]]?.class_type === 'ImageBatch'
    })

    if (conBatch.length) {
      const { uploadImageToComfyUI } = require('./providers/comfyui.provider')
      const subidas = new Map()   // url del proyecto → nombre ya subido a ComfyUI

      for (const p of conBatch) {
        const gpt   = wf[p.prompt_node]
        const batch = wf[Object.values(gpt.inputs).find(v => Array.isArray(v))[0]]
        // La segunda entrada del batch es la referencia; la primera es la plantilla.
        const refId = Object.values(batch.inputs).map(v => v?.[0])[1]
        if (!wf[refId] || wf[refId].class_type !== 'LoadImage') continue

        // Sin referencia, la página se renderiza SOLO con su plantilla — que es exactamente como
        // se renderizaba antes de que el workflow tuviera batches, así que es un resultado
        // conocido y bueno, no una degradación inventada.
        //
        // Hay que PUENTEAR el batch, no vaciarlo: `ImageBatch` declara `image1` e `image2` como
        // requeridos y no admite opcionales, así que dejarlo con una sola entrada es un grafo
        // inválido. Se reconecta el nodo del modelo directo a la plantilla y el batch queda
        // huérfano; la poda posterior lo descarta.
        const sinAncla = motivo => {
          const plantillaId = Object.values(batch.inputs).map(v => v?.[0])[0]
          const puerto = Object.entries(gpt.inputs).find(([, v]) => Array.isArray(v))?.[0]
          if (plantillaId && puerto) {
            gpt.inputs[puerto] = [String(plantillaId), 0]
            avisosRef.push(`${p.nombre}: ${motivo} — se renderiza solo con la plantilla`)
          } else {
            avisosRef.push(`${p.nombre}: ${motivo}`)
            sinRef.add(p.nombre)
          }
        }

        const fuente = (gpt.inputs.prompt || '').match(/IMAGE 2 = [^\n]*coming from ([^.]+)\./)?.[1] || ''
        const url    = await imagenDeNodoPorTitulo(db, project_id, fuente)
        if (!url) { sinAncla(`sin imagen de «${fuente.trim()}» en el proyecto`); continue }
        try {
          if (!subidas.has(url)) subidas.set(url, await uploadImageToComfyUI(url))
          wf[refId].inputs.image = subidas.get(url)
        } catch (e) {
          sinAncla(`no se pudo subir la referencia (${e.message})`)
        }
      }
      console.log(`[deck] referencias de estilo: ${conBatch.length - sinRef.size}/${conBatch.length} páginas`)
    }

    // 1c. El Art Bible: su ÚNICA entrada es la página ya renderizada del ASG que el prompt cita.
    // No hay plantilla que conservar —el prompt le pide descartar layout, marcos y todo el texto
    // de la referencia y pintar la obra nueva—, así que la imagen embebida en el workflow es un
    // relleno y reemplazarla no es opcional: sin esto el bible se pinta a partir de un ejemplo
    // ajeno al juego.
    const desdeASG = armado.paginas.filter(p => {
      const gpt = wf[p.prompt_node]
      const src = Object.values(gpt?.inputs || {}).find(v => Array.isArray(v))
      return wf[src?.[0]]?.class_type === 'LoadImage' && /Art Style Guide \(ASG/i.test(gpt?.inputs?.prompt || '')
    })

    if (desdeASG.length) {
      const { uploadImageToComfyUI } = require('./providers/comfyui.provider')
      const subidas = new Map()

      for (const p of desdeASG) {
        const gpt    = wf[p.prompt_node]
        const loadId = Object.values(gpt.inputs).find(v => Array.isArray(v))[0]
        const cita   = (gpt.inputs.prompt || '').match(/Art Style Guide \(ASG\s*[·.\-]?\s*(\d{1,2})/i)
        if (!cita) { avisosRef.push(`${p.nombre}: el prompt no dice qué página del ASG usa`); sinRef.add(p.nombre); continue }

        const url = await paginaDelASG(db, project_id, cita[1])
        if (!url) {
          avisosRef.push(`${p.nombre}: la página ${cita[1]} del ASG todavía no está renderizada`)
          sinRef.add(p.nombre)
          continue
        }
        try {
          if (!subidas.has(url)) subidas.set(url, await uploadImageToComfyUI(url))
          wf[loadId].inputs.image = subidas.get(url)
        } catch (e) {
          avisosRef.push(`${p.nombre}: no se pudo subir la página del ASG (${e.message})`)
          sinRef.add(p.nombre)
        }
      }
      console.log(`[deck] páginas del ASG como canon: ${desdeASG.length - sinRef.size}/${desdeASG.length}`)
    }
  }

  // Una página que pide referencia y no la consiguió NO se manda. Dejarla pasar significa
  // renderizarla contra la imagen de relleno del workflow —un caballero de fantasía— y presentar
  // eso como el estilo del juego: sale caro y hay que tirarlo. Mejor falta que equivocada.
  if (sinRef.size) {
    armado.paginas = armado.paginas.filter(p => !sinRef.has(p.nombre))
    armado.avisos  = [...(armado.avisos || []), ...avisosRef]
    console.log(`[deck] ${sinRef.size} página(s) omitidas por falta de referencia: ${[...sinRef].join(', ')}`)
    if (!armado.paginas.length) {
      throw new Error(
        `Ninguna página se puede renderizar: todas piden una imagen de referencia que el proyecto ` +
        `todavía no produjo.\n${avisosRef.join('\n')}`)
    }
  }

  // Con subconjunto hay que PODAR el grafo: si se manda entero, ComfyUI renderiza las 34 páginas
  // aunque solo queramos 31. Se conservan los nodos alcanzables desde los SaveImage elegidos,
  // caminando hacia atrás por los inputs — así sirve igual para el Art Bible, cuyas páginas
  // cuelgan de un ImageBatch con dos LoadImage.
  if (solo) {
    const vivos = new Set()
    const pendientes = armado.paginas.map(p => p.save_node)
    while (pendientes.length) {
      const id = pendientes.pop()
      if (!id || vivos.has(id) || !wf[id]) continue
      vivos.add(id)
      for (const v of Object.values(wf[id].inputs || {})) {
        if (Array.isArray(v) && typeof v[0] === 'string') pendientes.push(v[0])
      }
    }
    wf = Object.fromEntries(Object.entries(wf).filter(([id]) => vivos.has(id)))
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
  // Sin esto el despacho es invisible en la consola: cuatro minutos sin una línea se ven igual
  // que un proceso muerto, y eso llevó a disparar el mismo render tres veces.
  console.log(`[deck] ${output_key} · ${armado.paginas.length} páginas · job ${jobId} · workflow ${wfName}`)

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
          // La ruta lleva el job: sin eso cada render pisa al anterior en R2 y el versionado es
          // mentira — las dos versiones terminan apuntando al mismo archivo y la imagen vieja se
          // pierde. Costó perder el primer render de la página 09 descubrirlo.
          const dest = `projects/${project_id}/deck/${node_key}/${output_key}/${pag?.nombre || f.filename}-${jobId.slice(0, 8)}.png`
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

          console.log(`[deck]   ${String(vistos.size).padStart(2)}/${total}  ${item.name}`)
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

  console.log(`[deck] ${output_key} · ${paginas.length}/${total} en ${Math.round((Date.now() - t0) / 1000)}s · job ${jobId}`)

  return {
    jobId, paginas, esperadas: total, huecos,
    // Lo que REALMENTE se le mandó a ComfyUI. Es el contenido del prompt set: el output existe
    // para poder auditar qué se pidió, y hasta ahora se lo pedíamos a un modelo que no puede
    // escribirlo. Se emite el que se usó.
    prompts: armado.paginas.map(p => ({ indice: p.indice, nombre: p.nombre, prompt: p.prompt })),
    segundos: Math.round((Date.now() - t0) / 1000), avisos: armado.avisos,
  }
}

module.exports = { imageOutputsOf, parseOutputItems, cleanItemText, generateOneImage, generateDeck, esDeck, paginaDelASG, imagenDeNodoPorTitulo }
