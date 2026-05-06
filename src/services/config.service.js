const { db } = require('./supabase.service')

const CACHE_TTL_MS = 60_000

let _stepConfigsCache = null
let _stepConfigsAt    = 0
let _workflowsCache   = null
let _workflowsAt      = 0

// ─── Step configs ─────────────────────────────────────────────────────────────

async function loadStepConfigs() {
  const { data, error } = await db()
    .from('step_configs')
    .select('step_key, integration_type, model_name, comfyui_workflow_id, webhook_url, extra_params, is_active, image_enabled, image_integration_type, image_model, image_workflow_id, image_webhook_url')

  if (error) throw new Error(`[configService] Failed to load step_configs: ${error.message}`)

  _stepConfigsCache = Object.fromEntries((data || []).map(r => [r.step_key, r]))
  _stepConfigsAt    = Date.now()
  return _stepConfigsCache
}

async function getStepConfigs() {
  if (_stepConfigsCache && Date.now() - _stepConfigsAt < CACHE_TTL_MS) return _stepConfigsCache
  return loadStepConfigs()
}

async function getStepConfig(stepKey) {
  const configs = await getStepConfigs()
  return configs[stepKey] || null
}

// ─── ComfyUI workflows ────────────────────────────────────────────────────────

async function loadWorkflows() {
  const { data, error } = await db()
    .from('comfyui_workflows')
    .select('id, name, description, workflow_json, inject_config, is_active')
    .eq('is_active', true)

  if (error) throw new Error(`[configService] Failed to load comfyui_workflows: ${error.message}`)

  _workflowsCache = Object.fromEntries((data || []).map(r => [r.name, r]))
  _workflowsAt    = Date.now()
  return _workflowsCache
}

async function getWorkflows() {
  if (_workflowsCache && Date.now() - _workflowsAt < CACHE_TTL_MS) return _workflowsCache
  return loadWorkflows()
}

async function getWorkflowByName(name) {
  const workflows = await getWorkflows()
  return workflows[name] || null
}

async function getWorkflowById(id) {
  const workflows = await getWorkflows()
  return Object.values(workflows).find(w => w.id === id) || null
}

// ─── Cache invalidation ───────────────────────────────────────────────────────

function invalidateStepConfigs() {
  _stepConfigsCache = null
  _stepConfigsAt    = 0
}

function invalidateWorkflows() {
  _workflowsCache = null
  _workflowsAt    = 0
}

// ─── Model resolution ─────────────────────────────────────────────────────────
// Returns { provider, model } for a given step key.
// Priority: step_configs.model_name → DEFAULT_MODEL env var → gemini fallback

function parseModelString(modelString) {
  if (!modelString) return { provider: 'gemini', model: 'gemini-2.5-flash' }
  const [provider, ...rest] = modelString.split(':')
  return { provider, model: rest.join(':') }
}

async function resolveStepModel(stepKey) {
  const config = await getStepConfig(stepKey)
  const modelString = config?.model_name || process.env.DEFAULT_MODEL
  return parseModelString(modelString)
}

async function validateStepConfig(stepKey) {
  const config = await getStepConfig(stepKey)

  if (!config) return {
    valid: false, code: 'STEP_NOT_CONFIGURED',
    error: `Step "${stepKey}" has no configuration. Go to Admin → Integrations → Step Configs.`,
  }
  if (!config.is_active) return {
    valid: false, code: 'STEP_DISABLED',
    error: `Step "${stepKey}" is disabled. Enable it in Admin → Integrations → Step Configs.`,
  }

  if (config.integration_type === 'comfyui' && !config.comfyui_workflow_id) return {
    valid: false, code: 'STEP_NOT_CONFIGURED',
    error: `Step "${stepKey}" uses ComfyUI but no workflow is assigned. Go to Admin → Integrations → Step Configs.`,
  }
  if (config.integration_type === 'n8n' && !config.webhook_url) return {
    valid: false, code: 'STEP_NOT_CONFIGURED',
    error: `Step "${stepKey}" uses n8n but no webhook URL is configured. Go to Admin → Integrations → Step Configs.`,
  }

  if (config.image_enabled) {
    if (!config.image_integration_type) return {
      valid: false, code: 'STEP_NOT_CONFIGURED',
      error: `Step "${stepKey}" has image generation enabled but no integration type set.`,
    }
    if (config.image_integration_type === 'comfyui' && !config.image_workflow_id) return {
      valid: false, code: 'STEP_NOT_CONFIGURED',
      error: `Step "${stepKey}" image generation uses ComfyUI but no workflow is assigned.`,
    }
    if (config.image_integration_type === 'n8n' && !config.image_webhook_url) return {
      valid: false, code: 'STEP_NOT_CONFIGURED',
      error: `Step "${stepKey}" image generation uses n8n but no webhook URL is configured.`,
    }
  }

  return { valid: true, config }
}

module.exports = {
  getStepConfig,
  getStepConfigs,
  getWorkflowByName,
  getWorkflowById,
  getWorkflows,
  invalidateStepConfigs,
  invalidateWorkflows,
  resolveStepModel,
  parseModelString,
  validateStepConfig,
}
