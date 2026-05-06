const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')
const {
  invalidateStepConfigs,
  invalidateWorkflows,
} = require('../services/config.service')

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
      .select('id, name, description, inject_config, is_active, created_at, updated_at')
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
    const { name, description, workflow_json, inject_config } = req.body

    if (!name)          return res.status(400).json({ success: false, error: 'name is required' })
    if (!workflow_json) return res.status(400).json({ success: false, error: 'workflow_json is required' })
    if (!inject_config) return res.status(400).json({ success: false, error: 'inject_config is required' })

    // Basic inject_config validation
    const required = ['prompt', 'width', 'height', 'seed']
    const missing  = required.filter(k => !inject_config[k]?.node || !inject_config[k]?.field)
    if (missing.length) {
      return res.status(400).json({ success: false, error: `inject_config missing fields: ${missing.join(', ')}` })
    }

    const { data, error } = await db()
      .from('comfyui_workflows')
      .insert({ name, description, workflow_json, inject_config, created_by: req.adminMemberId, updated_by: req.adminMemberId })
      .select('id, name, description, inject_config, is_active, created_at, updated_at')
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
    const { name, description, workflow_json, inject_config, is_active } = req.body

    const updates = { updated_by: req.adminMemberId, updated_at: new Date().toISOString() }
    if (name          !== undefined) updates.name          = name
    if (description   !== undefined) updates.description   = description
    if (workflow_json !== undefined) updates.workflow_json = workflow_json
    if (is_active     !== undefined) updates.is_active     = is_active

    if (inject_config !== undefined) {
      const required = ['prompt', 'width', 'height', 'seed']
      const missing  = required.filter(k => !inject_config[k]?.node || !inject_config[k]?.field)
      if (missing.length) {
        return res.status(400).json({ success: false, error: `inject_config missing fields: ${missing.join(', ')}` })
      }
      updates.inject_config = inject_config
    }

    const { data, error } = await db()
      .from('comfyui_workflows')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, description, inject_config, is_active, updated_at')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    if (!data) return res.status(404).json({ success: false, error: 'Workflow not found' })

    invalidateWorkflows()
    res.json({ success: true, workflow: data })
  } catch (err) { next(err) }
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
