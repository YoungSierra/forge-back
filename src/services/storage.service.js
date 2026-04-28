const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')
const { getClient } = require('./supabase.service')

const STORAGE_BASE = process.env.STORAGE_PATH || './storage/forge-assets'
const BUCKET = 'forge-assets'

function textToColor(text) {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash)
  }
  const r = (hash >> 16) & 255
  const g = (hash >> 8) & 255
  const b = hash & 255
  return { r: Math.abs(r), g: Math.abs(g), b: Math.abs(b) }
}

function ensureProjectDir(project_id) {
  const base = path.join(STORAGE_BASE, 'projects', project_id)
  fs.mkdirSync(path.join(base, 'code'), { recursive: true })
  fs.mkdirSync(path.join(base, 'export'), { recursive: true })
  return base
}

function getAssetUrl(project_id, filename) {
  return `/assets/projects/${project_id}/${filename}`
}

function generatePlaceholderPNG(text, color, width, height) {
  const w = width || 256
  const h = height || 256
  const c = color || textToColor(text)

  const png = new PNG({ width: w, height: h })

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (w * y + x) * 4
      const border = x < 8 || x >= w - 8 || y < 8 || y >= h - 8
      const factor = border ? 0.6 : 1
      png.data[idx]     = Math.round(c.r * factor)
      png.data[idx + 1] = Math.round(c.g * factor)
      png.data[idx + 2] = Math.round(c.b * factor)
      png.data[idx + 3] = 255
    }
  }

  return PNG.sync.write(png)
}

async function uploadToStorage(buffer, storagePath, mimeType = 'image/jpeg') {
  const supabase = getClient()
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: true })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

module.exports = {
  ensureProjectDir,
  getAssetUrl,
  generatePlaceholderPNG,
  uploadToStorage,
  slugify,
  STORAGE_BASE
}
