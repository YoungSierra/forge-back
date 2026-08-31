const { getWorkflowByName } = require('../config.service')
const { uploadToStorage } = require('../storage.service')

const BASE_URL = () => (process.env.COMFYUI_BASE_URL || 'https://cloud.comfy.org').replace(/\/$/, '')
const API_KEY  = () => process.env.COMFYUI_API_KEY

function headers() {
  return { 'X-API-Key': API_KEY(), 'Content-Type': 'application/json' }
}

function injectPoint(workflow, point, value) {
  if (!point?.node || !point?.field) return
  const node = workflow[point.node]
  if (!node) { console.warn(`[ComfyUI] inject: node "${point.node}" not found in workflow`); return }
  node.inputs[point.field] = value
}

async function submitWorkflow(workflowName, prompt, width, height, extras = {}, opciones = null) {
  const entry = await getWorkflowByName(workflowName)
  if (!entry) throw new Error(`Unknown ComfyUI workflow: "${workflowName}"`)

  const workflow = JSON.parse(JSON.stringify(entry.workflow_json))
  const inject   = entry.inject_config

  // `mode: 'token'` — el prompt del usuario va DENTRO del prompt del workflow, en el lugar que el
  // workflow marca, no en lugar de él. Pisarlo entero le saca al modelo la instrucción de qué
  // hacer con la imagen: medido el 25-ago, una hoja de personaje con «cambiá el turquesa a
  // naranja» devolvió una Environment Sheet inventada. Lo hacía bien `design-edit`, que arma el
  // payload a mano; acá se replica para que cualquier camino se comporte igual.
  if (inject.mode === 'token' && inject.prompt?.node && workflow[inject.prompt.node]) {
    const campo = inject.prompt.field
    const base  = String(workflow[inject.prompt.node].inputs[campo] || '')
    const token = inject.prompt.token || '[ USER PROMPT ]'
    workflow[inject.prompt.node].inputs[campo] = base.includes(token)
      ? base.split(token).join(prompt || '')
      : `${prompt || ''}\n\n${base}`   // si alguien saca el token, el pedido igual llega
  } else {
    injectPoint(workflow, inject.prompt, prompt)
  }

  // Punto `image` de primer nivel: la imagen a editar, ya subida por el llamador. No estaba
  // contemplado acá —solo `extra`— así que un workflow declarado así corría con la imagen de
  // ejemplo que trae adentro, sin fallar y sin avisar.
  if (inject.image?.node && extras.image) injectPoint(workflow, inject.image, extras.image)

  injectPoint(workflow, inject.width,  width)
  injectPoint(workflow, inject.height, height)
  injectPoint(workflow, inject.seed,   Math.floor(Math.random() * 2147483647))

  // Extra injection points (string, int, float, image)
  if (inject.extra) {
    for (const [key, point] of Object.entries(inject.extra)) {
      if (key in extras) {
        const raw = extras[key]
        const value = point.type === 'int'   ? Math.round(Number(raw))
                    : point.type === 'float' ? Number(raw)
                    : raw
        injectPoint(workflow, point, value)
      }
    }
  }

  // Segunda imagen opcional: se sube, se carga en su propio LoadImage y RECIÉN ahí se conecta al
  // modelo. El enganche viene declarado en el workflow (`ref_proyecto`), no hardcodeado, y si el
  // caller no manda imagen el nodo queda huérfano y ComfyUI lo ignora — que es justo lo que
  // queremos: sin arte del proyecto, el modelo no recibe una imagen ajena en su lugar.
  if (inject.ref_proyecto && extras.ref_proyecto) {
    const { load_node, model_node, field } = inject.ref_proyecto
    if (workflow[load_node] && workflow[model_node]) {
      try {
        const subida = await uploadImageToComfyUI(extras.ref_proyecto)
        workflow[load_node].inputs.image = subida
        workflow[model_node].inputs[field] = [String(load_node), 0]
        console.log(`[ComfyUI] arte del proyecto → ${field} (${subida})`)
      } catch (e) {
        console.warn('[ComfyUI] no se pudo adjuntar el arte del proyecto:', e.message)
      }
    }
  }

  // Las opciones de generación que eligió el usuario (informe v3, punto 12). Van al final, encima
  // de todo lo demás: son una decisión explícita y tienen que ganarle a los valores que el
  // workflow trae guardados. Un valor que no existe se rechaza acá y no en ComfyUI, que lo
  // descubriría recién al cobrar la corrida.
  if (opciones && Object.keys(opciones).length) {
    const { opcionesDe, aplicarOpciones } = require('../workflow-options.service')
    try {
      const catalogo = await opcionesDe(entry.workflow_json)
      const { escrituras, avisos } = aplicarOpciones(workflow, opciones, catalogo)
      console.log(`[ComfyUI] opciones del usuario: ${escrituras} escritura(s) en ${workflowName}`)
      avisos.forEach(a => console.warn(`[ComfyUI] opción ignorada: ${a}`))
    } catch (e) {
      // Sin object_info no hay catálogo, y sin catálogo no se puede validar. Correr con los
      // valores por defecto es peor que no correr: el usuario pidió otra cosa y pagaría por ésta.
      throw new Error(`No pude aplicar las opciones de generación: ${e.message}`)
    }
  }

  const extra_data = {}
  if (process.env.COMFYUI_API_KEY) extra_data.api_key_comfy_org = process.env.COMFYUI_API_KEY

  console.log(`[ComfyUI] Payload for /api/prompt (workflow: ${workflowName}):\n${JSON.stringify({ prompt: workflow, ...(Object.keys(extra_data).length ? { extra_data } : {}) }, null, 2)}`)

  const res = await fetch(`${BASE_URL()}/api/prompt`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ prompt: workflow, ...(Object.keys(extra_data).length ? { extra_data } : {}) }),
  })

  if (!res.ok) {
    const body = await res.text()
    const err = new Error(`ComfyUI submit failed: ${res.status} ${body}`)
    if (res.status === 401) err.code = 'COMFYUI_AUTH'
    if (res.status === 402) err.code = 'COMFYUI_CREDITS'
    throw err
  }

  const json = await res.json()
  if (!json.prompt_id) throw new Error(`ComfyUI: no prompt_id in response: ${JSON.stringify(json)}`)
  return json.prompt_id
}

async function pollUntilDone(promptId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  const INTERVAL = 3000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, INTERVAL))

    const res = await fetch(`${BASE_URL()}/api/job/${promptId}/status`, { headers: headers() })
    if (!res.ok) {
      console.warn(`[ComfyUI] poll ${promptId} → HTTP ${res.status}, retrying`)
      continue
    }

    const json = await res.json()
    const status = json.status ?? json.state

    if (status === 'completed' || status === 'success') return
    if (status === 'failed' || status === 'cancelled' || status === 'error') {
      const detail = json.error || json.message || json.error_message || JSON.stringify(json)
      console.error(`[ComfyUI] job ${promptId} failed — ${detail}`)
      throw new Error(`ComfyUI job failed: ${detail}`)
    }
    console.log(`[ComfyUI] job ${promptId} → ${status}`)
  }

  throw new Error(`ComfyUI job ${promptId} timed out after ${timeoutMs / 1000}s`)
}

async function downloadOutput(promptId, storagePath) {
  const histRes = await fetch(`${BASE_URL()}/api/jobs/${promptId}`, { headers: headers() })
  if (!histRes.ok) throw new Error(`ComfyUI jobs fetch failed: ${histRes.status}`)

  const jobData = await histRes.json()
  const outputs = jobData?.outputs ?? jobData?.[promptId]?.outputs

  let imageEntry = null
  const glbEntries = []

  for (const node of Object.values(outputs || {})) {
    // Buscar imágenes PNG/JPEG (excluir GLB que a veces aparece en images[])
    if (!imageEntry && Array.isArray(node?.images)) {
      for (const f of node.images) {
        const name = (f?.filename || '').toLowerCase()
        if (f?.filename && !name.endsWith('.glb') && !name.endsWith('.gltf')) {
          imageEntry = f
          break
        }
      }
    }

    // Buscar archivos GLB/GLTF — SaveGLB puede usar '3d', 'gltf', 'mesh' o 'files'; deduplicar por filename
    for (const key of ['3d', 'gltf', 'mesh', 'files', 'images']) {
      if (!Array.isArray(node?.[key])) continue
      for (const f of node[key]) {
        const name = (f?.filename || '').toLowerCase()
        if ((name.endsWith('.glb') || name.endsWith('.gltf')) && !glbEntries.some(e => e.filename === f.filename)) {
          glbEntries.push(f)
        }
      }
    }
  }

  const basePath = storagePath.replace(/\.[^.]+$/, '')
  let primaryResult = null

  // Descargar imagen de preview (si existe)
  if (imageEntry) {
    const { filename, subfolder = '', type = 'output' } = imageEntry
    const viewUrl = `${BASE_URL()}/api/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
    const imgRes  = await fetch(viewUrl, { headers: headers(), redirect: 'follow' })
    if (imgRes.ok) {
      const buffer = Buffer.from(await imgRes.arrayBuffer())
      if (buffer.length >= 1000) {
        const mime = imgRes.headers.get('content-type') || 'image/png'
        const url  = await uploadToStorage(buffer, storagePath, mime)
        primaryResult = { url, size_bytes: buffer.length }
        console.log(`[ComfyUI] Image → ${storagePath} (${Math.round(buffer.length / 1024)}kb) job:${promptId}`)
      }
    }
  }

  // Descargar archivos GLB
  const glbUrls = []
  for (let i = 0; i < glbEntries.length; i++) {
    const { filename, subfolder = '', type = 'output' } = glbEntries[i]
    const viewUrl = `${BASE_URL()}/api/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
    const glbRes  = await fetch(viewUrl, { headers: headers(), redirect: 'follow' })
    if (!glbRes.ok) { console.warn(`[ComfyUI] GLB download failed: ${glbRes.status} ${filename}`); continue }
    const buffer  = Buffer.from(await glbRes.arrayBuffer())
    const glbPath = `${basePath}_${i}.glb`
    const url     = await uploadToStorage(buffer, glbPath, 'model/gltf-binary')
    glbUrls.push(url)
    console.log(`[ComfyUI] GLB → ${glbPath} (${Math.round(buffer.length / 1024)}kb) job:${promptId}`)
    if (!primaryResult) primaryResult = { url, size_bytes: buffer.length }
  }

  if (!primaryResult) {
    console.error(`[ComfyUI] downloadOutput: outputs dump for job ${promptId}:`, JSON.stringify(outputs))
    throw new Error(`ComfyUI: no output found (image or GLB) for job ${promptId}`)
  }

  return { url: primaryResult.url, size_bytes: primaryResult.size_bytes, glb_urls: glbUrls, source: 'comfyui' }
}

// ─── Todas las salidas de un job, por nodo ───────────────────────────────────
//
// `downloadOutput` devuelve UNA imagen —la primera que encuentra— porque hasta ahora cada workflow
// producía una. La cadena de Character Sheet no: su paso 2 tiene cuatro `SaveImage` (el maestro y
// las tres vistas) y el paso 3 pide esas vistas por rol. Quedarse con la primera perdería tres
// imágenes ya pagadas, y peor: cuál es «la primera» depende del orden en que ComfyUI devuelva los
// nodos, así que el rol saldría distinto en cada corrida.
//
// Devuelve { [nodo]: { url, kind, size_bytes } }. El nodo es la clave porque es lo único estable:
// el `filename_prefix` puede repetirse y el orden no se puede pedir.
async function downloadOutputsByNode(promptId, basePath) {
  const histRes = await fetch(`${BASE_URL()}/api/jobs/${promptId}`, { headers: headers() })
  if (!histRes.ok) throw new Error(`ComfyUI jobs fetch failed: ${histRes.status}`)

  const jobData = await histRes.json()
  const outputs = jobData?.outputs ?? jobData?.[promptId]?.outputs
  const porNodo = {}

  for (const [nodo, salida] of Object.entries(outputs || {})) {
    // Un mismo nodo puede publicar bajo varias claves; se toma el primer archivo que sirva.
    const archivos = ['images', '3d', 'gltf', 'mesh', 'files']
      .flatMap(k => (Array.isArray(salida?.[k]) ? salida[k] : []))
      .filter(f => f?.filename)
    const vistos = new Set()

    for (const f of archivos) {
      if (vistos.has(f.filename)) continue
      vistos.add(f.filename)

      const nombre = f.filename.toLowerCase()
      const es3D   = nombre.endsWith('.glb') || nombre.endsWith('.gltf')
      const ext    = es3D ? '.glb' : '.png'
      const mime   = es3D ? 'model/gltf-binary' : 'image/png'

      const viewUrl = `${BASE_URL()}/api/view?filename=${encodeURIComponent(f.filename)}`
                    + `&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${f.type || 'output'}`
      const res = await fetch(viewUrl, { headers: headers(), redirect: 'follow' })
      if (!res.ok) { console.warn(`[ComfyUI] salida ${nodo} no se pudo bajar: ${res.status} ${f.filename}`); continue }

      const buffer = Buffer.from(await res.arrayBuffer())
      // Un PNG de menos de 1 KB es un placeholder, no un render — el mismo umbral que ya usaba
      // downloadOutput. Un GLB chico sí puede ser válido, así que el piso es solo para imágenes.
      if (!es3D && buffer.length < 1000) continue

      const url = await uploadToStorage(buffer, `${basePath}_${nodo}${ext}`, mime)
      porNodo[nodo] = { url, kind: es3D ? 'model' : 'image', size_bytes: buffer.length }
      console.log(`[ComfyUI] salida ${nodo} → ${url} (${Math.round(buffer.length / 1024)}kb) job:${promptId}`)
      break
    }
  }

  if (!Object.keys(porNodo).length) {
    console.error(`[ComfyUI] downloadOutputsByNode: outputs del job ${promptId}:`, JSON.stringify(outputs))
    throw new Error(`ComfyUI: el job ${promptId} no dejó ninguna salida`)
  }
  return porNodo
}

async function uploadImageToComfyUI(imageUrl) {
  const imgRes = await fetch(imageUrl)
  if (!imgRes.ok) throw new Error(`Failed to fetch reference image: ${imgRes.status} ${imageUrl}`)
  const buffer = Buffer.from(await imgRes.arrayBuffer())
  const mime   = imgRes.headers.get('content-type') || 'image/png'
  const ext    = mime.includes('jpeg') ? 'jpg' : 'png'
  const filename = `ref_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`

  const form = new FormData()
  form.append('image', new Blob([buffer], { type: mime }), filename)
  form.append('type', 'input')
  form.append('overwrite', 'true')

  const uploadRes = await fetch(`${BASE_URL()}/api/upload/image`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY() },
    body: form,
  })
  if (!uploadRes.ok) {
    const body = await uploadRes.text()
    throw new Error(`ComfyUI upload failed: ${uploadRes.status} ${body}`)
  }
  const json = await uploadRes.json()
  const uploadedName = json.name ?? json.filename
  if (!uploadedName) throw new Error(`ComfyUI upload: no filename in response: ${JSON.stringify(json)}`)
  console.log(`[ComfyUI] Uploaded reference image → ${uploadedName}`)
  return uploadedName
}

async function generateImageComfyUI(workflowName, prompt, width, height, storagePath, extras = {}, timeoutMs = 120_000) {
  const startTime = Date.now()
  const promptId = await submitWorkflow(workflowName, prompt, width, height, extras)
  console.log(`[ComfyUI] Submitted job ${promptId} workflow:${workflowName} timeout:${timeoutMs / 1000}s`)
  await pollUntilDone(promptId, timeoutMs)
  const result = await downloadOutput(promptId, storagePath)
  console.log(`[ComfyUI] Done in ${Date.now() - startTime}ms`)
  return result
}

module.exports = { generateImageComfyUI, uploadImageToComfyUI, submitWorkflow, pollUntilDone, downloadOutput, downloadOutputsByNode }
