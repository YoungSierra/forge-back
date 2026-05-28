const OpenAI = require('openai')
const { uploadToStorage } = require('../storage.service')

let _client = null
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _client
}

function nearestDallESize(width, height) {
  if (width > height) return '1792x1024'
  if (height > width) return '1024x1792'
  return '1024x1024'
}

function nearestGptImageSize(width, height) {
  if (width > height) return '1536x1024'
  if (height > width) return '1024x1536'
  return '1024x1024'
}

async function generateImageOpenAI(modelId, prompt, width, height, storagePath) {
  const client = getClient()
  const startTime = Date.now()
  const isGptImage = modelId.startsWith('gpt-image')

  let buffer, mime

  if (isGptImage) {
    // gpt-image-1 / gpt-image-1.5 / gpt-image-2:
    // no response_format param; returns b64_json by default
    const size = nearestGptImageSize(width, height)
    const response = await client.images.generate({ model: modelId, prompt, n: 1, size, quality: 'medium' })
    const b64 = response.data?.[0]?.b64_json
    if (!b64) throw new Error('OpenAI images.generate: no b64_json in response')
    buffer = Buffer.from(b64, 'base64')
    mime   = 'image/png'
    console.log(`[OpenAI] Generated ${storagePath} (${Math.round(buffer.length / 1024)}kb) model:${modelId} size:${size} in ${Date.now() - startTime}ms`)
  } else {
    // dall-e-2 / dall-e-3: URL-based response
    const size = nearestDallESize(width, height)
    const response = await client.images.generate({
      model: modelId,
      prompt,
      n: 1,
      size,
      quality: 'standard',
    })
    const imageUrl = response.data?.[0]?.url
    if (!imageUrl) throw new Error('OpenAI images.generate: no URL in response')
    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error(`Failed to fetch OpenAI image: ${imgRes.status}`)
    buffer = Buffer.from(await imgRes.arrayBuffer())
    mime   = imgRes.headers.get('content-type') || 'image/png'
    console.log(`[OpenAI] Generated ${storagePath} (${Math.round(buffer.length / 1024)}kb) model:${modelId} size:${size} in ${Date.now() - startTime}ms`)
  }

  if (buffer.length < 1000) throw new Error('OpenAI image response too small')
  const publicUrl = await uploadToStorage(buffer, storagePath, mime)
  return { url: publicUrl, size_bytes: buffer.length, source: 'openai' }
}

module.exports = { generateImageOpenAI }
