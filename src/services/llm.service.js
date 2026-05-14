const { callGemini }    = require('./providers/gemini.provider')
const { callGroq }      = require('./providers/groq.provider')
const { callTogether }  = require('./providers/together.provider')
const { callOpenRouter } = require('./providers/openrouter.provider')
const { callOpenAI }    = require('./providers/openai.provider')
const { callMinimax }   = require('./providers/minimax.provider')
const { resolveStepModel, parseModelString } = require('./config.service')

async function callLLM(systemPrompt, userMessage, options = {}) {
  const step = options.step || null

  const { provider, model } = step
    ? await resolveStepModel(step)
    : parseModelString(options.model || process.env.DEFAULT_MODEL)

  const callOptions = {
    ...options,
    model,
    maxOutputTokens: options.maxOutputTokens || 8192,
    temperature: options.temperature !== undefined ? options.temperature : 0.8,
  }

  console.log(`[LLM] Step: ${step || 'default'} | Provider: ${provider} | Model: ${model}`)

  switch (provider) {
    case 'groq':       return callGroq(systemPrompt, userMessage, callOptions)
    case 'together':   return callTogether(systemPrompt, userMessage, callOptions)
    case 'openrouter': return callOpenRouter(systemPrompt, userMessage, callOptions)
    case 'openai':     return callOpenAI(systemPrompt, userMessage, callOptions)
    case 'minimax':    return callMinimax(systemPrompt, userMessage, callOptions)
    case 'gemini':
    default:           return callGemini(systemPrompt, userMessage, callOptions)
  }
}

module.exports = { callLLM, parseModelString }
