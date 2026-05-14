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

async function submitWorkflow(workflowName, prompt, width, height, extras = {}) {
  const entry = await getWorkflowByName(workflowName)
  if (!entry) throw new Error(`Unknown ComfyUI workflow: "${workflowName}"`)

  const workflow = JSON.parse(JSON.stringify(entry.workflow_json))
  const inject   = entry.inject_config

  injectPoint(workflow, inject.prompt, prompt)
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

module.exports = { generateImageComfyUI, uploadImageToComfyUI, submitWorkflow, pollUntilDone, downloadOutput }
