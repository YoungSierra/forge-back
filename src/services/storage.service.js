const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3')

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

async function getFromStorage(storagePath, bucketKey = DEFAULT_BUCKET) {
  const cfg = BUCKET_CONFIG[bucketKey] || BUCKET_CONFIG[DEFAULT_BUCKET]
  const client = getR2Client()
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.name, Key: storagePath }))
  const chunks = []
  for await (const chunk of res.Body) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ── Storage cleanup ───────────────────────────────────────────────────────────

async function listStorageKeys(prefix, bucketKey = DEFAULT_BUCKET) {
  const cfg = BUCKET_CONFIG[bucketKey] || BUCKET_CONFIG[DEFAULT_BUCKET]
  const client = getR2Client()
  const keys = []
  let continuationToken

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: cfg.name,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }))
    for (const obj of res.Contents || []) keys.push(obj.Key)
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (continuationToken)

  return keys
}

async function deleteStorageKeys(keys, bucketKey = DEFAULT_BUCKET) {
  if (keys.length === 0) return
  const cfg = BUCKET_CONFIG[bucketKey] || BUCKET_CONFIG[DEFAULT_BUCKET]
  const client = getR2Client()
  // S3 DeleteObjects supports max 1000 keys per request
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map(Key => ({ Key }))
    await client.send(new DeleteObjectsCommand({
      Bucket: cfg.name,
      Delete: { Objects: batch, Quiet: true },
    }))
  }
}

/**
 * Delete all files under projects/{project_id}/{node}/
 */
async function clearNodeStorage(project_id, node, bucketKey = DEFAULT_BUCKET) {
  const prefix = `projects/${project_id}/${node}/`
  const keys = await listStorageKeys(prefix, bucketKey)
  await deleteStorageKeys(keys, bucketKey)
  return keys.length
}

/**
 * Delete all files under projects/{project_id}/{node}/{itemSlug}/
 */
async function clearItemStorage(project_id, node, itemSlug, bucketKey = DEFAULT_BUCKET) {
  const prefix = `projects/${project_id}/${node}/${itemSlug}/`
  const keys = await listStorageKeys(prefix, bucketKey)
  await deleteStorageKeys(keys, bucketKey)
  return keys.length
}

module.exports = {
  ensureProjectDir,
  getAssetUrl,
  generatePlaceholderPNG,
  uploadToStorage,
  getFromStorage,
  deleteStorageKeys,
  clearNodeStorage,
  clearItemStorage,
  slugify,
  STORAGE_BASE,
  BUCKET_CONFIG,
}
