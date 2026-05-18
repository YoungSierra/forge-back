const OpenAI = require('openai')

let _client = null
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _client
}

const REASONING_MODELS = /^(o\d|gpt-5)/  // o1, o3, o4, gpt-5* — no temperature
const NEW_TOKEN_PARAM   = /^(o\d|gpt-5)/  // use max_completion_tokens

async function callOpenAI(systemPrompt, userMessage, options = {}) {
  const model = options.model || 'gpt-4o-mini'
  const startTime = Date.now()

  const isReasoning = REASONING_MODELS.test(model)
  const useNewParam  = NEW_TOKEN_PARAM.test(model)
  const tokenKey     = useNewParam ? 'max_completion_tokens' : 'max_tokens'

  const params = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage },
    ],
    ...(options.rawText ? {} : { response_format: { type: 'json_object' } }),
    [tokenKey]: options.maxOutputTokens || 8192,
  }

  if (!isReasoning) {
    params.temperature = options.temperature !== undefined ? options.temperature : 0.8
  }

  const completion = await getClient().chat.completions.create(params)

  const raw = completion.choices[0]?.message?.content || ''
  const finishReason = completion.choices[0]?.finish_reason

  if (finishReason === 'length') {
    const err = new Error(`Response truncated: max_tokens too low (model: ${model})`)
    err.code = 'MAX_TOKENS'
    throw err
  }

  if (options.rawText) {
    const usage = completion.usage || {}
    return {
      data: raw.trim(),
      meta: { provider: 'openai', model, tokens_used: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, cached: usage.prompt_tokens_details?.cached_tokens || 0 }, duration_ms: Date.now() - startTime }
    }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const err = new Error(`Failed to parse OpenAI JSON response (model: ${model})`)
    err.code = 'INVALID_JSON'
    err.raw = raw.slice(0, 500)
    throw err
  }

  const usage = completion.usage || {}
  return {
    data: parsed,
    meta: {
      provider: 'openai',
      model,
      tokens_used: {
        input:  usage.prompt_tokens     || 0,
        output: usage.completion_tokens || 0,
        cached: usage.prompt_tokens_details?.cached_tokens || 0,
      },
      duration_ms: Date.now() - startTime,
    },
  }
}

module.exports = { callOpenAI }
