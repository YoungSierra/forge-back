const { callGemini }    = require('./providers/gemini.provider')
const { callGroq }      = require('./providers/groq.provider')
const { callTogether }  = require('./providers/together.provider')
const { callOpenRouter } = require('./providers/openrouter.provider')
const { callOpenAI }    = require('./providers/openai.provider')
const { callMinimax }   = require('./providers/minimax.provider')
const { callMimo }      = require('./providers/mimo.provider')
const { resolveStepModel, parseModelString } = require('./config.service')

// Limpia bloques <think>...</think> que algunos modelos con razonamiento extendido incluyen
// (Gemini 2.5 Flash thinking, DeepSeek R1, Qwen, etc.) — aplica independiente del provider
function stripThinkBlocks(text) {
  return typeof text === 'string' ? text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : text
}

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

  let result
  switch (provider) {
    case 'groq':       result = await callGroq(systemPrompt, userMessage, callOptions); break
    case 'together':   result = await callTogether(systemPrompt, userMessage, callOptions); break
    case 'openrouter': result = await callOpenRouter(systemPrompt, userMessage, callOptions); break
    case 'openai':     result = await callOpenAI(systemPrompt, userMessage, callOptions); break
    case 'minimax':    result = await callMinimax(systemPrompt, userMessage, callOptions); break
    case 'mimo':       result = await callMimo(systemPrompt, userMessage, callOptions); break
    case 'gemini':
    default:           result = await callGemini(systemPrompt, userMessage, callOptions); break
  }

  if (result?.data) result.data = stripThinkBlocks(result.data)
  return result
}

module.exports = { callLLM, parseModelString }
