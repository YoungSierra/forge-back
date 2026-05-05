const { getWorkflowByName } = require('../config.service')
const { uploadToStorage } = require('../storage.service')

const BASE_URL = () => (process.env.COMFYUI_BASE_URL || 'https://cloud.comfy.org').replace(/\/$/, '')
const API_KEY  = () => process.env.COMFYUI_API_KEY

function headers() {
  return { 'X-API-Key': API_KEY(), 'Content-Type': 'application/json' }
}

async function submitWorkflow(workflowName, prompt, width, height) {
  const entry = await getWorkflowByName(workflowName)
  if (!entry) throw new Error(`Unknown ComfyUI workflow: "${workflowName}"`)

  const workflow = JSON.parse(JSON.stringify(entry.workflow_json))
  const inject   = entry.inject_config

  workflow[inject.prompt.node].inputs[inject.prompt.field] = prompt
  workflow[inject.width.node].inputs[inject.width.field]   = width
  workflow[inject.height.node].inputs[inject.height.field] = height
  workflow[inject.seed.node].inputs[inject.seed.field]     = Math.floor(Math.random() * 2 ** 32)

  const res = await fetch(`${BASE_URL()}/api/prompt`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ prompt: workflow }),
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
      throw new Error(`ComfyUI job ${promptId} ended with status: ${status}`)
    }
    console.log(`[ComfyUI] job ${promptId} → ${status}`)
  }

  throw new Error(`ComfyUI job ${promptId} timed out after ${timeoutMs / 1000}s`)
}

async function downloadOutput(promptId, storagePath) {
  const histRes = await fetch(`${BASE_URL()}/api/jobs/${promptId}`, { headers: headers() })
  if (!histRes.ok) throw new Error(`ComfyUI jobs fetch failed: ${histRes.status}`)

  const jobData = await histRes.json()

  // shape: { outputs: { "9": { images: [{filename, subfolder, type}] } } }
  const outputs = jobData?.outputs ?? jobData?.[promptId]?.outputs
  const outputNode = outputs?.['9']
  const imageEntry = outputNode?.images?.[0]

  if (!imageEntry?.filename) {
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

async function generateImageComfyUI(workflowName, prompt, width, height, storagePath) {
  const startTime = Date.now()
  const promptId = await submitWorkflow(workflowName, prompt, width, height)
  console.log(`[ComfyUI] Submitted job ${promptId} workflow:${workflowName}`)
  await pollUntilDone(promptId)
  const result = await downloadOutput(promptId, storagePath)
  console.log(`[ComfyUI] Done in ${Date.now() - startTime}ms`)
  return result
}

module.exports = { generateImageComfyUI }
