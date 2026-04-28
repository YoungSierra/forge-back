const { generatePlaceholderPNG, uploadToStorage } = require('./storage.service')

const HF_MODEL   = 'black-forest-labs/FLUX.1-schnell'
const HF_URL     = `https://router.huggingface.co/hf-inference/models/${HF_MODEL}`
const TIMEOUT_MS = 120000  // HF can be slow while loading model

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const QUALITY_SUFFIX = ', concept art, detailed illustration, professional digital art, sharp focus, vibrant colors, 4k'

async function generateImage(prompt, width, height, storagePath) {
  const token = process.env.HF_TOKEN
  const enhancedPrompt = prompt + QUALITY_SUFFIX
  try {
    const res = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-wait-for-model': 'true',
      },
      body: JSON.stringify({
        inputs: enhancedPrompt,
        parameters: { num_inference_steps: 6, width, height },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`HF ${res.status}: ${body}`)
    }

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 1000) throw new Error('Response too small')

    const mime      = res.headers.get('content-type') || 'image/jpeg'
    const publicUrl = await uploadToStorage(buffer, storagePath, mime)
    console.log(`[IMAGE] Generated ${storagePath} (${Math.round(buffer.length / 1024)}kb) via HuggingFace`)
    return { url: publicUrl, size_bytes: buffer.length, source: 'huggingface' }
  } catch (err) {
    console.warn(`[IMAGE] HuggingFace failed (${err.message}), using placeholder`)
    const buffer    = generatePlaceholderPNG(prompt, null, width, height)
    const publicUrl = await uploadToStorage(buffer, storagePath, 'image/png')
    return { url: publicUrl, size_bytes: buffer.length, source: 'placeholder' }
  }
}

async function generateImagesSequential(tasks) {
  const results = []
  for (let i = 0; i < tasks.length; i++) {
    const result = await generateImage(tasks[i].prompt, tasks[i].width, tasks[i].height, tasks[i].storagePath)
    results.push(result)
    if (i < tasks.length - 1) await sleep(2000)
  }
  return results
}

module.exports = { generateImage, generateImagesSequential }
