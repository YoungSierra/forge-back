const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')

const STORAGE_BASE = process.env.STORAGE_PATH || './storage/forge-assets'

// ── R2 bucket registry ────────────────────────────────────────────────────────
// Same credentials for all buckets; only name + public URL differ per bucket.
const R2_ENDPOINT = `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`

const BUCKET_CONFIG = {
  'forge-assets': {
    name:      process.env.CF_R2_BUCKET          || 'forge-assets',
    publicUrl: process.env.CF_R2_PUBLIC_URL      || '',
  },
  'feedback-screenshots': {
    name:      process.env.CF_R2_FEEDBACK_BUCKET      || 'feedback-screenshots',
    publicUrl: process.env.CF_R2_FEEDBACK_PUBLIC_URL  || '',
  },
}

const DEFAULT_BUCKET = 'forge-assets'

function getR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.CF_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
    },
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const w = width  || 256
  const h = height || 256
  const c = color  || textToColor(text)

  const png = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx    = (w * y + x) * 4
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

// ── Core upload ───────────────────────────────────────────────────────────────

/**
 * Upload a buffer to Cloudflare R2.
 * @param {Buffer}  buffer
 * @param {string}  storagePath  e.g. "projects/abc/sprites/hero.jpg"
 * @param {string}  mimeType
 * @param {string}  bucketKey    key from BUCKET_CONFIG (default: 'forge-assets')
 * @returns {Promise<string>}    public URL
 */
async function uploadToStorage(buffer, storagePath, mimeType = 'image/jpeg', bucketKey = DEFAULT_BUCKET) {
  const cfg = BUCKET_CONFIG[bucketKey] || BUCKET_CONFIG[DEFAULT_BUCKET]

  const client = getR2Client()
  await client.send(new PutObjectCommand({
    Bucket:      cfg.name,
    Key:         storagePath,
    Body:        buffer,
    ContentType: mimeType,
  }))

  const publicUrl = `${cfg.publicUrl}/${storagePath}`
  return publicUrl
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
  STORAGE_BASE,
  BUCKET_CONFIG,
}
