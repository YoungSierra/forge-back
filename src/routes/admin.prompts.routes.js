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
    // Traemos todo para poder ordenar igual que la lista de step_configs
    const { data, error } = await db()
      .from('step_configs')
      .select('step_key, prompt_r2_path, label, updated_at, step_type, parent_key, order_index')
      .order('order_index')

    if (error) return res.status(500).json({ success: false, error: error.message })

    const rows = data || []

    // Ordenar: hijos de cada container (por order_index del container luego del hijo),
    // luego nodos top-level, luego services — idéntico al orden visual de step_configs
    const containers = rows.filter(r => r.step_type === 'container').sort((a, b) => a.order_index - b.order_index)
    const sorted = []

    for (const c of containers) {
      sorted.push(c)
      const children = rows
        .filter(r => r.parent_key === c.step_key && r.step_type === 'node')
        .sort((a, b) => a.order_index - b.order_index)
      sorted.push(...children)
    }

    const topNodes = rows
      .filter(r => r.step_type === 'node' && !r.parent_key)
      .sort((a, b) => a.order_index - b.order_index)
    sorted.push(...topNodes)

    const services = rows
      .filter(r => r.step_type === 'service')
      .sort((a, b) => a.order_index - b.order_index)
    sorted.push(...services)


    const prompt_configs = sorted.map(row => ({
      key:         row.step_key,
      r2_path:     row.prompt_r2_path || null,
      description: row.label || null,
      updated_at:  row.updated_at,
      step_type:   row.step_type,
      order_index: row.order_index,
      parent_key:  row.parent_key || null,
    }))

    res.json({ success: true, prompt_configs })
  } catch (err) { next(err) }
})

// PATCH /api/admin/prompt-configs/:key
router.patch('/prompt-configs/:key', async (req, res, next) => {
  try {
    const { key } = req.params
    const { r2_path } = req.body

    if (r2_path) {
      const exists = await r2PathExists(r2_path)
      if (!exists) return res.status(422).json({ success: false, error: 'File not found in R2' })
    }

    const { data, error } = await db()
      .from('step_configs')
      .update({ prompt_r2_path: r2_path ?? null, updated_at: new Date().toISOString() })
      .eq('step_key', key)
      .select('step_key, prompt_r2_path, label, updated_at')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    if (!data)  return res.status(404).json({ success: false, error: 'Step not found' })

    invalidatePrompts()
    res.json({
      success: true,
      prompt_config: {
        key:         data.step_key,
        r2_path:     data.prompt_r2_path || null,
        description: data.label || null,
        updated_at:  data.updated_at,
      },
    })
  } catch (err) { next(err) }
})

module.exports = router
