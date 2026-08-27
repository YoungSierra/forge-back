// Bloques de visión cuando hay imágenes; el string de siempre cuando no. Ver vision.format.
const contenidoUsuario = (options, texto) =>
  options.images?.length
    ? require('../vision.format').contenidoOpenAI(options.images, texto)
    : texto

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
      { role: 'user',   content: contenidoUsuario(options, userMessage) },
    ],
    ...(options.rawText ? {} : { response_format: { type: 'json_object' } }),
    [tokenKey]: options.maxOutputTokens || 8192,
  }

  if (!isReasoning) {
    params.temperature = options.temperature !== undefined ? options.temperature : 0.8
  }

  // La señal viaja hasta acá para que Stop corte la generación de verdad y deje de gastar; sin
  // ella el cliente se soltaba pero el proveedor seguía facturando.
  if (options.signal?.aborted) { const e = new Error('cancelado por el usuario'); e.code = 'ABORTED'; throw e }
  const completion = await getClient().chat.completions.create(
    params,
    options.signal ? { signal: options.signal } : undefined,
  )

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
