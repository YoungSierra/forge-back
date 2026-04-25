const { callGemini } = require('./providers/gemini.provider')
const { callGroq } = require('./providers/groq.provider')
const { callTogether } = require('./providers/together.provider')
const { callOpenRouter } = require('./providers/openrouter.provider')

function parseModelString(modelString) {
  if (!modelString) return { provider: 'gemini', model: 'gemini-2.5-flash' }
  const [provider, ...modelParts] = modelString.split(':')
  return { provider, model: modelParts.join(':') }
}

function getStepModel(step) {
  const envMap = {
    // Wizard steps
    'step_1_gdd':              process.env.STEP_1_GDD_MODEL,
    'step_2_sprites':          process.env.STEP_2_SPRITES_MODEL,
    'step_3_levels':           process.env.STEP_3_LEVELS_MODEL,
    'step_4_code':             process.env.STEP_4_CODE_MODEL,
    'step_5_audio':            process.env.STEP_5_AUDIO_MODEL,
    'validation':              process.env.VALIDATION_MODEL,
    // Pipeline nodes (2D)
    'pipeline_visual_guide':   process.env.PIPELINE_VISUAL_GUIDE_MODEL,
    'pipeline_concept_art':    process.env.PIPELINE_CONCEPT_ART_MODEL,
    'pipeline_backgrounds':    process.env.PIPELINE_BACKGROUNDS_MODEL,
    'pipeline_sfx':            process.env.PIPELINE_SFX_MODEL,
    'pipeline_uiux':           process.env.PIPELINE_UIUX_MODEL,
    'pipeline_icons':          process.env.PIPELINE_ICONS_MODEL,
    'pipeline_hud':            process.env.PIPELINE_HUD_MODEL,
    // Pipeline nodes (3D)
    'pipeline_3d':             process.env.PIPELINE_3D_MODEL,
  }
  return parseModelString(envMap[step] || process.env.DEFAULT_MODEL)
}

async function callLLM(systemPrompt, userMessage, options = {}) {
  const step = options.step || null
  const { provider, model } = step
    ? getStepModel(step)
    : parseModelString(options.model || process.env.DEFAULT_MODEL)

  const callOptions = {
    ...options,
    model,
    maxOutputTokens: options.maxOutputTokens || 8192,
    temperature: options.temperature !== undefined ? options.temperature : 0.8
  }

  console.log(`[LLM] Step: ${step || 'default'} | Provider: ${provider} | Model: ${model}`)

  switch (provider) {
    case 'groq':       return callGroq(systemPrompt, userMessage, callOptions)
    case 'together':   return callTogether(systemPrompt, userMessage, callOptions)
    case 'openrouter': return callOpenRouter(systemPrompt, userMessage, callOptions)
    case 'gemini':
    default:           return callGemini(systemPrompt, userMessage, callOptions)
  }
}

module.exports = { callLLM, getStepModel, parseModelString }
