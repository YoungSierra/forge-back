const { createFalClient } = require('@fal-ai/client')
const { generatePlaceholderPNG, uploadToStorage } = require('./storage.service')
const { generateImageComfyUI } = require('./providers/comfyui.provider')
const { generateImageOpenAI } = require('./providers/openai.image.provider')

const QUALITY_SUFFIX = ', concept art, detailed illustration, professional digital art, sharp focus, vibrant colors, 4k'

let _fal = null
function getFal() {
  if (!_fal) {
    _fal = createFalClient({ credentials: process.env.FAL_KEY })
  }
  return _fal
}

async function generateImageFal(prompt, width, height, storagePath) {
  const fal = getFal()
  const result = await fal.run('fal-ai/flux/schnell', {
    input: { prompt, image_size: { width, height }, num_inference_steps: 4 },
  })
  const imageUrl = result.data?.images?.[0]?.url
  if (!imageUrl) throw new Error('No image URL in fal response')

  const res = await fetch(imageUrl)
  if (!res.ok) throw new Error(`Failed to fetch fal image: ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length < 1000) throw new Error('fal image too small')

  const mime = res.headers.get('content-type') || 'image/jpeg'
  const publicUrl = await uploadToStorage(buffer, storagePath, mime)
  console.log(`[IMAGE] Generated ${storagePath} (${Math.round(buffer.length / 1024)}kb) via fal.ai`)
  return { url: publicUrl, size_bytes: buffer.length, source: 'fal' }
}

async function generateImageHF(prompt, width, height, storagePath) {
  const token = process.env.HF_TOKEN
  const HF_URL = 'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell'
  const res = await fetch(HF_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-wait-for-model': 'true',
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { num_inference_steps: 6, width, height },
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HF ${res.status}: ${body}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length < 1000) throw new Error('HF response too small')
  const mime = res.headers.get('content-type') || 'image/jpeg'
  const publicUrl = await uploadToStorage(buffer, storagePath, mime)
  console.log(`[IMAGE] Generated ${storagePath} (${Math.round(buffer.length / 1024)}kb) via HuggingFace`)
  return { url: publicUrl, size_bytes: buffer.length, source: 'huggingface' }
}

async function generateImage(prompt, width, height, storagePath) {
  const enhancedPrompt = prompt + QUALITY_SUFFIX

  if (process.env.FAL_KEY) {
    try {
      return await generateImageFal(enhancedPrompt, width, height, storagePath)
    } catch (err) {
      console.warn(`[IMAGE] fal.ai failed (${err.message}), trying HuggingFace`)
    }
  }

  if (process.env.HF_TOKEN) {
    try {
      return await generateImageHF(enhancedPrompt, width, height, storagePath)
    } catch (err) {
      console.warn(`[IMAGE] HuggingFace failed (${err.message}), using placeholder`)
    }
  }

  console.warn('[IMAGE] No image provider available, using placeholder')
  const buffer = generatePlaceholderPNG(prompt, null, width, height)
  const publicUrl = await uploadToStorage(buffer, storagePath, 'image/png')
  return { url: publicUrl, size_bytes: buffer.length, source: 'placeholder' }
}

async function generateImagesSequential(tasks) {
  const results = []
  for (const task of tasks) {
    const result = await generateImage(task.prompt, task.width, task.height, task.storagePath)
    results.push(result)
  }
  return results
}

async function generateImageForNode(nodeKey, prompt, width, height, storagePath) {
  const { getStepConfig, getWorkflowById } = require('./config.service')
  const config = await getStepConfig(nodeKey)

  if (!config?.image_enabled) return { url: null, skipped: true }

  const type = config.image_integration_type

  if (type === 'comfyui') {
    if (!config.image_workflow_id) {
      console.warn(`[IMAGE] ${nodeKey}: image_integration_type=comfyui but no image_workflow_id set — skipping`)
      return { url: null, skipped: true }
    }
    const workflow = await getWorkflowById(config.image_workflow_id)
    if (!workflow) throw new Error(`[IMAGE] ${nodeKey}: image workflow not found (id: ${config.image_workflow_id})`)
    return generateImageComfyUI(workflow.name, prompt, width, height, storagePath)
  }

  if (type === 'n8n') {
    // n8n image generation — deferred
    console.warn(`[IMAGE] ${nodeKey}: n8n image generation not yet implemented — skipping`)
    return { url: null, skipped: true }
  }

  if (type === 'llm') {
    const modelStr = config.image_model || 'fal:flux/schnell'
    const [provider, ...modelParts] = modelStr.split(':')
    const modelId = modelParts.join(':')
    if (provider === 'openai') return generateImageOpenAI(modelId, prompt, width, height, storagePath)
    if (provider === 'fal')    return generateImageFal(prompt + QUALITY_SUFFIX, width, height, storagePath)
    return generateImage(prompt, width, height, storagePath)
  }

  console.warn(`[IMAGE] ${nodeKey}: unknown image_integration_type "${type}" — skipping`)
  return { url: null, skipped: true }
}

module.exports = { generateImage, generateImagesSequential, generateImageForNode }
