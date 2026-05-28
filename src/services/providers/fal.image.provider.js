const { fal }          = require('@fal-ai/client')
const { uploadToStorage } = require('../storage.service')

// Mapeo de dimensiones a image_size de fal.ai
function falImageSize(width, height) {
  if (width === height)     return 'square_hd'
  if (width > height)       return 'landscape_4_3'
  return 'portrait_4_3'
}

async function generateImageFal(modelId, prompt, width = 1024, height = 1024, storagePath) {
  fal.config({ credentials: process.env.FAL_KEY })

  const startTime = Date.now()

  const result = await fal.subscribe(modelId, {
    input: {
      prompt,
      image_size: falImageSize(width, height),
      num_images: 1,
    },
    logs: false,
  })

  const imageUrl = result?.data?.images?.[0]?.url
  if (!imageUrl) throw new Error(`fal.ai: no image URL en respuesta para modelo "${modelId}"`)

  // Descargar imagen y subir a R2
  const imgRes = await fetch(imageUrl)
  if (!imgRes.ok) throw new Error(`fal.ai: error descargando imagen generada: ${imgRes.status}`)
  const buffer  = Buffer.from(await imgRes.arrayBuffer())
  const mime    = imgRes.headers.get('content-type') || 'image/png'

  if (buffer.length < 1000) throw new Error('fal.ai: respuesta de imagen demasiado pequeña')

  console.log(`[fal.ai] Generated ${storagePath} (${Math.round(buffer.length / 1024)}kb) model:${modelId} in ${Date.now() - startTime}ms`)

  const publicUrl = await uploadToStorage(buffer, storagePath, mime)
  return { url: publicUrl, size_bytes: buffer.length, source: 'fal' }
}

module.exports = { generateImageFal }
