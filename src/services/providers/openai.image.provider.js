const OpenAI = require('openai')
const { uploadToStorage } = require('../storage.service')

let _client = null
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _client
}

// DALL-E 3 only supports these sizes
const SUPPORTED_SIZES = ['1024x1024', '1792x1024', '1024x1792']

function nearestSize(width, height) {
  if (width > height) return '1792x1024'
  if (height > width) return '1024x1792'
  return '1024x1024'
}

async function generateImageOpenAI(modelId, prompt, width, height, storagePath) {
  const client = getClient()
  const size = nearestSize(width, height)
  const startTime = Date.now()

  const response = await client.images.generate({
    model: modelId,       // dall-e-3 | dall-e-2
    prompt,
    n: 1,
    size,
    quality: 'standard', // 'hd' for higher quality at double cost
    response_format: 'url',
  })

  const imageUrl = response.data?.[0]?.url
  if (!imageUrl) throw new Error('OpenAI images.generate: no URL in response')

  const imgRes = await fetch(imageUrl)
  if (!imgRes.ok) throw new Error(`Failed to fetch OpenAI image: ${imgRes.status}`)

  const buffer = Buffer.from(await imgRes.arrayBuffer())
  if (buffer.length < 1000) throw new Error('OpenAI image response too small')

  const mime = imgRes.headers.get('content-type') || 'image/png'
  const publicUrl = await uploadToStorage(buffer, storagePath, mime)

  console.log(`[OpenAI] Generated ${storagePath} (${Math.round(buffer.length / 1024)}kb) model:${modelId} size:${size} in ${Date.now() - startTime}ms`)
  return { url: publicUrl, size_bytes: buffer.length, source: 'openai' }
}

module.exports = { generateImageOpenAI }
