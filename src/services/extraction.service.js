const AdmZip  = require('adm-zip')
const pdfParse = require('pdf-parse')
const mammoth  = require('mammoth')

// ─── Dispatcher principal ─────────────────────────────────────────────────────

/**
 * Extrae texto de un buffer según su mimeType.
 * Para imágenes devuelve null (se maneja por separado con visión LLM).
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<string|null>}
 */
async function extractText(buffer, mimeType) {
  const mime = (mimeType || '').toLowerCase()

  if (mime === 'application/pdf')
    return extractPdf(buffer)

  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword')
    return extractDocx(buffer)

  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    return extractPptx(buffer)

  if (mime.startsWith('text/') || mime === 'application/json')
    return extractRaw(buffer)

  // imágenes y modelos 3D — sin extracción de texto
  return null
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function extractPdf(buffer) {
  try {
    const data = await pdfParse(buffer)
    return data.text?.trim() || null
  } catch (err) {
    console.error('[extraction] PDF parse failed:', err.message)
    return null
  }
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────

async function extractDocx(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer })
    return result.value?.trim() || null
  } catch (err) {
    console.error('[extraction] DOCX parse failed:', err.message)
    return null
  }
}

// ─── PPTX ─────────────────────────────────────────────────────────────────────
// PPTX es un ZIP — cada slide es un XML en ppt/slides/slideN.xml

async function extractPptx(buffer) {
  try {
    const zip    = new AdmZip(buffer)
    const entries = zip.getEntries()

    const slideEntries = entries
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/\d+/)?.[0] || '0')
        const numB = parseInt(b.entryName.match(/\d+/)?.[0] || '0')
        return numA - numB
      })

    const texts = slideEntries.map(entry => {
      const xml = entry.getData().toString('utf8')
      // Extraer contenido de tags <a:t> (texto en Open XML)
      const matches = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
      return matches.map(m => m[1]).join(' ').trim()
    }).filter(Boolean)

    return texts.join('\n\n') || null
  } catch (err) {
    console.error('[extraction] PPTX parse failed:', err.message)
    return null
  }
}

// ─── Texto plano / JSON / Markdown ───────────────────────────────────────────

function extractRaw(buffer) {
  try {
    return buffer.toString('utf8').trim() || null
  } catch (err) {
    console.error('[extraction] Raw text parse failed:', err.message)
    return null
  }
}

// ─── Detectar asset_type desde mimeType ──────────────────────────────────────

function detectAssetType(mimeType) {
  const mime = (mimeType || '').toLowerCase()
  if (mime.startsWith('image/'))                                          return 'image'
  if (mime.includes('pdf') || mime.includes('word') || mime.includes('presentation') || mime.startsWith('text/')) return 'document'
  if (mime.includes('gltf') || mime.includes('model') || ['model/obj', 'model/stl', 'application/octet-stream'].includes(mime)) return 'model_3d'
  return 'other'
}

module.exports = { extractText, detectAssetType }
