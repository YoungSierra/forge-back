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

  // Find the first output node that has images (node id varies by workflow)
  const outputs = jobData?.outputs ?? jobData?.[promptId]?.outputs
  let imageEntry = null
  for (const node of Object.values(outputs || {})) {
    const img = node?.images?.[0]
    if (img?.filename) { imageEntry = img; break }
  }

  if (!imageEntry) {
    console.error(`[ComfyUI] downloadOutput: outputs dump for job ${promptId}:`, JSON.stringify(outputs))
    throw new Error(`ComfyUI: could not find output image in history for job ${promptId}`)
  }

  const { filename, subfolder = '', type = 'output' } = imageEntry
  const viewUrl = `${BASE_URL()}/api/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`

  // /api/view returns 302 → signed URL; follow redirects
  const imgRes = await fetch(viewUrl, { headers: headers(), redirect: 'follow' })
  if (!imgRes.ok) throw new Error(`ComfyUI view fetch failed: ${imgRes.status}`)

  const buffer = Buffer.from(await imgRes.arrayBuffer())
  if (buffer.length < 1000) throw new Error('ComfyUI image response too small')

  const mime = imgRes.headers.get('content-type') || 'image/png'
  const publicUrl = await uploadToStorage(buffer, storagePath, mime)
  console.log(`[ComfyUI] Generated ${storagePath} (${Math.round(buffer.length / 1024)}kb) job:${promptId}`)
  return { url: publicUrl, size_bytes: buffer.length, source: 'comfyui' }
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

async function generateImageComfyUI(workflowName, prompt, width, height, storagePath, extras = {}) {
  const startTime = Date.now()
  const promptId = await submitWorkflow(workflowName, prompt, width, height, extras)
  console.log(`[ComfyUI] Submitted job ${promptId} workflow:${workflowName}`)
  await pollUntilDone(promptId)
  const result = await downloadOutput(promptId, storagePath)
  console.log(`[ComfyUI] Done in ${Date.now() - startTime}ms`)
  return result
}

module.exports = { generateImageComfyUI, uploadImageToComfyUI, submitWorkflow, pollUntilDone, downloadOutput }
