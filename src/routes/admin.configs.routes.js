const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')
const {
  invalidateStepConfigs,
  invalidateWorkflows,
  getWorkflowById,
} = require('../services/config.service')
const { submitWorkflow, pollUntilDone, downloadOutput } = require('../services/providers/comfyui.provider')
const { generateImageOpenAI } = require('../services/providers/openai.image.provider')
const { generateImageFal     } = require('../services/image.service')

// POST /api/admin/test-image
router.post('/test-image', async (req, res, next) => {
  try {
    const { model, prompt, width = 512, height = 512 } = req.body
    if (!model)  return res.status(400).json({ success: false, error: 'model is required' })
    if (!prompt) return res.status(400).json({ success: false, error: 'prompt is required' })

    const [provider, ...parts] = model.split(':')
    const modelId = parts.join(':')
    const storagePath = `admin/image-tests/${Date.now()}.jpg`

    let result
    if (provider === 'openai') {
      result = await generateImageOpenAI(modelId, prompt, Number(width), Number(height), storagePath)
    } else if (provider === 'fal') {
      result = await generateImageFal(prompt, Number(width), Number(height), storagePath)
    } else {
      return res.status(400).json({ success: false, error: `Unknown image provider: "${provider}". Use openai or fal.` })
    }

    console.log(`[admin test-image] model:${model} → ${storagePath}`)
    res.json({ success: true, image_url: result.url })
  } catch (err) {
    console.error(`[admin test-image] error:`, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// POST /api/admin/comfyui-upload — sube imagen a ComfyUI Cloud input folder
router.post('/comfyui-upload', async (req, res, next) => {
  try {
    const { image_base64, filename = `upload-${Date.now()}.png` } = req.body
    if (!image_base64) return res.status(400).json({ success: false, error: 'image_base64 required' })

    const buffer   = Buffer.from(image_base64, 'base64')
    const BASE_URL = (process.env.COMFYUI_BASE_URL || '').replace(/\/$/, '')
    const API_KEY  = process.env.COMFYUI_API_KEY

    const formData = new FormData()
    formData.append('image', new Blob([buffer], { type: 'image/png' }), filename)
    formData.append('overwrite', 'true')

    const uploadRes = await fetch(`${BASE_URL}/api/upload/image`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY },
      body: formData,
    })

    if (!uploadRes.ok) {
      const text = await uploadRes.text()
      return res.status(502).json({ success: false, error: `ComfyUI upload failed: ${uploadRes.status} ${text}` })
    }

    const result = await uploadRes.json()
    console.log(`[ComfyUI upload] ${filename} → ${result.name}`)
    res.json({ success: true, filename: result.name })
  } catch (err) {
    console.error('[ComfyUI upload] error:', err.message)
    next(err)
  }
})

// ─── Step Configs ─────────────────────────────────────────────────────────────

// GET /api/admin/step-configs
router.get('/step-configs', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('step_configs')
      .select('*, comfyui_workflows!comfyui_workflow_id(id, name)')
      .order('step_key')

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, step_configs: data })
  } catch (err) { next(err) }
})

// PATCH /api/admin/step-configs/:step_key
router.patch('/step-configs/:step_key', async (req, res, next) => {
  try {
    const { step_key } = req.params
    const {
      integration_type, model_name, comfyui_workflow_id, webhook_url, extra_params, is_active,
      image_enabled, image_integration_type, image_model, image_workflow_id, image_webhook_url,
    } = req.body

    const updates = { updated_by: req.adminMemberId, updated_at: new Date().toISOString() }
    if (integration_type    !== undefined) updates.integration_type    = integration_type
    if (model_name          !== undefined) updates.model_name          = model_name || null
    if (comfyui_workflow_id !== undefined) updates.comfyui_workflow_id = comfyui_workflow_id || null
    if (webhook_url         !== undefined) updates.webhook_url         = webhook_url || null
    if (extra_params        !== undefined) updates.extra_params        = extra_params
    if (is_active           !== undefined) updates.is_active           = is_active

    // Clear fields that don't apply to the new integration_type
    if (integration_type === 'llm') {
      updates.comfyui_workflow_id = null
      updates.webhook_url         = null
    } else if (integration_type === 'comfyui') {
      updates.webhook_url = null
    } else if (integration_type === 'n8n') {
      updates.comfyui_workflow_id = null
      updates.model_name          = null
    }

    // Image generation fields
    if (image_enabled           !== undefined) updates.image_enabled           = image_enabled
    if (image_integration_type  !== undefined) updates.image_integration_type  = image_integration_type || null
    if (image_model             !== undefined) updates.image_model             = image_model || null
    if (image_workflow_id       !== undefined) updates.image_workflow_id       = image_workflow_id || null
    if (image_webhook_url       !== undefined) updates.image_webhook_url       = image_webhook_url || null

    // Clear image fields that don't apply to image_integration_type
    if (image_integration_type === 'llm') {
      updates.image_workflow_id = null
      updates.image_webhook_url = null
    } else if (image_integration_type === 'comfyui') {
      updates.image_model       = null
      updates.image_webhook_url = null
    } else if (image_integration_type === 'n8n') {
      updates.image_model       = null
      updates.image_workflow_id = null
    }

    const { data, error } = await db()
      .from('step_configs')
      .update(updates)
      .eq('step_key', step_key)
      .select()
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    if (!data) return res.status(404).json({ success: false, error: 'Step config not found' })

    invalidateStepConfigs()
    res.json({ success: true, step_config: data })
  } catch (err) { next(err) }
})

// ─── ComfyUI Workflows ────────────────────────────────────────────────────────

// GET /api/admin/comfyui-workflows
router.get('/comfyui-workflows', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('comfyui_workflows')
      .select('id, name, description, inject_config, is_active, refinement_capable, mask_capable, created_at, updated_at')
      .order('name')

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, workflows: data })
  } catch (err) { next(err) }
})

// GET /api/admin/comfyui-workflows/:id — includes full workflow_json
router.get('/comfyui-workflows/:id', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('comfyui_workflows')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error || !data) return res.status(404).json({ success: false, error: 'Workflow not found' })
    res.json({ success: true, workflow: data })
  } catch (err) { next(err) }
})

// POST /api/admin/comfyui-workflows
router.post('/comfyui-workflows', async (req, res, next) => {
  try {
    const { name, description, workflow_json, inject_config, refinement_capable = false, mask_capable = false } = req.body

    if (!name)          return res.status(400).json({ success: false, error: 'name is required' })
    if (!workflow_json) return res.status(400).json({ success: false, error: 'workflow_json is required' })
    if (!inject_config) return res.status(400).json({ success: false, error: 'inject_config is required' })

    const { data, error } = await db()
      .from('comfyui_workflows')
      .insert({ name, description, workflow_json, inject_config, refinement_capable, mask_capable, created_by: req.adminMemberId, updated_by: req.adminMemberId })
      .select('id, name, description, inject_config, is_active, refinement_capable, mask_capable, created_at, updated_at')
      .single()

    if (error) {
      if (error.code === '23505') return res.status(409).json({ success: false, error: `Workflow "${name}" already exists` })
      return res.status(500).json({ success: false, error: error.message })
    }

    invalidateWorkflows()
    res.status(201).json({ success: true, workflow: data })
  } catch (err) { next(err) }
})

// PATCH /api/admin/comfyui-workflows/:id
router.patch('/comfyui-workflows/:id', async (req, res, next) => {
  try {
    const { name, description, workflow_json, inject_config, is_active, refinement_capable, mask_capable } = req.body

    const updates = { updated_by: req.adminMemberId, updated_at: new Date().toISOString() }
    if (name                !== undefined) updates.name                = name
    if (description         !== undefined) updates.description         = description
    if (workflow_json       !== undefined) updates.workflow_json       = workflow_json
    if (is_active           !== undefined) updates.is_active           = is_active
    if (inject_config       !== undefined) updates.inject_config       = inject_config
    if (refinement_capable  !== undefined) updates.refinement_capable  = refinement_capable
    if (mask_capable        !== undefined) updates.mask_capable        = mask_capable

    const { data, error } = await db()
      .from('comfyui_workflows')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, description, inject_config, is_active, refinement_capable, mask_capable, updated_at')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    if (!data) return res.status(404).json({ success: false, error: 'Workflow not found' })

    invalidateWorkflows()
    res.json({ success: true, workflow: data })
  } catch (err) { next(err) }
})

// POST /api/admin/comfyui-workflows/:id/test
router.post('/comfyui-workflows/:id/test', async (req, res, next) => {
  try {
    const { prompt, width, height, seed, extras = {} } = req.body

    // Consulta directa a DB — el test admin ignora is_active
    const { data: entry, error: entryErr } = await db()
      .from('comfyui_workflows')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (entryErr || !entry) return res.status(404).json({ success: false, error: 'Workflow not found' })
    if (!entry.workflow_json) return res.status(400).json({ success: false, error: 'Workflow has no workflow_json saved' })

    const inject = entry.inject_config || {}

    // Clonar el workflow y aplicar los valores inyectados
    const workflow = JSON.parse(JSON.stringify(entry.workflow_json))

    function injectPoint(point, value) {
      if (!point?.node || !point?.field) return
      const node = workflow[point.node]
      if (!node) return
      node.inputs[point.field] = value
    }

    if (prompt !== undefined) {
      console.log(`[ComfyUI test] prompt →\n${prompt}`)
      injectPoint(inject.prompt, prompt)
    }
    if (width   !== undefined) injectPoint(inject.width,  Number(width))
    if (height  !== undefined) injectPoint(inject.height, Number(height))
    if (seed !== undefined && seed !== null && seed !== '') injectPoint(inject.seed, Number(seed))

    if (inject.extra) {
      for (const [key, point] of Object.entries(inject.extra)) {
        if (!(key in extras)) continue
        const raw = extras[key]
        const value = point.type === 'int'   ? Math.round(Number(raw))
                    : point.type === 'float' ? Number(raw)
                    : raw
        injectPoint(point, value)
      }
    }

    const BASE_URL = (process.env.COMFYUI_BASE_URL || 'https://cloud.comfy.org').replace(/\/$/, '')
    const API_KEY  = process.env.COMFYUI_API_KEY
    const headers  = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' }

    const extra_data = {}
    if (process.env.COMFYUI_API_KEY) extra_data.api_key_comfy_org = process.env.COMFYUI_API_KEY

    const submitRes = await fetch(`${BASE_URL}/api/prompt`, {
      method: 'POST', headers,
      body: JSON.stringify({ prompt: workflow, ...(Object.keys(extra_data).length ? { extra_data } : {}) }),
    })
    if (!submitRes.ok) {
      const body = await submitRes.text()
      return res.status(502).json({ success: false, error: `ComfyUI submit failed: ${submitRes.status} ${body}` })
    }
    const { prompt_id } = await submitRes.json()
    if (!prompt_id) return res.status(502).json({ success: false, error: 'ComfyUI: no prompt_id' })

    console.log(`[ComfyUI test] job ${prompt_id} workflow:${entry.name}`)
    await pollUntilDone(prompt_id, 600_000)   // 10 min — workflows 3D pueden tardar
    const storagePath = `admin/workflow-tests/${req.params.id}/${Date.now()}.png`
    const result = await downloadOutput(prompt_id, storagePath)
    res.json({ success: true, image_url: result.url, glb_urls: result.glb_urls ?? [], job_id: prompt_id, prepared_workflow: workflow })
  } catch (err) {
    console.error(`[ComfyUI test] error:`, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// DELETE /api/admin/comfyui-workflows/:id
router.delete('/comfyui-workflows/:id', async (req, res, next) => {
  try {
    // Check if any step_config references this workflow
    const { data: inUse } = await db()
      .from('step_configs')
      .select('step_key')
      .eq('comfyui_workflow_id', req.params.id)

    if (inUse?.length) {
      return res.status(409).json({
        success: false,
        error: `Workflow in use by: ${inUse.map(s => s.step_key).join(', ')}`,
      })
    }

    const { error } = await db()
      .from('comfyui_workflows')
      .delete()
      .eq('id', req.params.id)

    if (error) return res.status(500).json({ success: false, error: error.message })

    invalidateWorkflows()
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
