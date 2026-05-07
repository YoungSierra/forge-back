const express = require('express')
const router  = express.Router()
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3')
const { db }  = require('../services/supabase.service')
const { invalidatePrompts } = require('../services/prompt.service')

function getR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.CF_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
    },
  })
}

async function r2PathExists(r2Path) {
  try {
    await getR2Client().send(new HeadObjectCommand({
      Bucket: process.env.CF_R2_PROMPTS_BUCKET,
      Key: r2Path,
    }))
    return true
  } catch {
    return false
  }
}

// GET /api/admin/prompt-configs
router.get('/prompt-configs', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('prompt_configs')
      .select('key, r2_path, description, updated_at')
      .order('key')

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, prompt_configs: data })
  } catch (err) { next(err) }
})

// PATCH /api/admin/prompt-configs/:key
router.patch('/prompt-configs/:key', async (req, res, next) => {
  try {
    const { key } = req.params
    const { r2_path, description } = req.body

    if (r2_path) {
      const exists = await r2PathExists(r2_path)
      if (!exists) return res.status(422).json({ success: false, error: 'File not found in R2' })
    }

    const updates = { key, updated_at: new Date().toISOString() }
    if (r2_path    !== undefined) updates.r2_path    = r2_path    || null
    if (description !== undefined) updates.description = description || null

    const { data, error } = await db()
      .from('prompt_configs')
      .upsert(updates, { onConflict: 'key' })
      .select('key, r2_path, description, updated_at')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })

    invalidatePrompts()
    res.json({ success: true, prompt_config: data })
  } catch (err) { next(err) }
})

module.exports = router
