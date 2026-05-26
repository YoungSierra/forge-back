const express = require('express')
const router  = express.Router()
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3')
const { db } = require('../services/supabase.service')
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
      Key:    r2Path,
    }))
    return true
  } catch { return false }
}

// GET /api/admin/skill-configs
// Devuelve todos los skills únicos usados en forge_nodes, combinados con su config en DB
router.get('/skill-configs', async (req, res, next) => {
  try {
    // Extraer skills únicos de forge_nodes usando unnest en Postgres
    const { data: nodeRows, error: nodeErr } = await db()
      .rpc('get_unique_skills')

    // Fallback si no existe la función RPC: query manual
    let skillKeys = []
    if (nodeErr || !nodeRows) {
      const { data: nodes } = await db()
        .from('forge_nodes')
        .select('skills')
        .not('skills', 'is', null)
      const seen = new Set()
      for (const n of nodes || []) {
        for (const s of (n.skills || [])) {
          if (s && !seen.has(s)) { seen.add(s); skillKeys.push(s) }
        }
      }
    } else {
      skillKeys = nodeRows.map(r => r.skill_key)
    }

    skillKeys.sort()

    // Traer configs guardadas
    const { data: configs } = await db()
      .from('forge_skill_configs')
      .select('key, r2_path, description, updated_at')

    const configMap = Object.fromEntries((configs || []).map(c => [c.key, c]))

    const skill_configs = skillKeys.map(key => {
      const cfg = configMap[key] || {}
      return {
        key,
        r2_path:     cfg.r2_path     || null,
        description: cfg.description || null,
        updated_at:  cfg.updated_at  || null,
      }
    })

    res.json({ success: true, skill_configs })
  } catch (err) { next(err) }
})

// PATCH /api/admin/skill-configs/:key
router.patch('/skill-configs/:key', async (req, res, next) => {
  try {
    const { key } = req.params
    const { r2_path, description } = req.body

    if (r2_path) {
      const exists = await r2PathExists(r2_path)
      if (!exists) return res.status(422).json({ success: false, error: 'File not found in R2' })
    }

    const { data, error } = await db()
      .from('forge_skill_configs')
      .upsert({ key, r2_path: r2_path ?? null, description: description ?? null, updated_at: new Date().toISOString() })
      .select('key, r2_path, description, updated_at')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })

    invalidatePrompts()
    res.json({ success: true, skill_config: data })
  } catch (err) { next(err) }
})

module.exports = router
