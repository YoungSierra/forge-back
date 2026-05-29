const Anthropic = require('@anthropic-ai/sdk')

let _client = null
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

async function callAnthropic(systemPrompt, userMessage, options = {}) {
  const model     = options.model || 'claude-sonnet-4-6'
  const startTime = Date.now()

  let response
  try {
    // claude-opus-4-x no acepta temperature (usa extended thinking internamente)
    const supportsTemperature = !model.startsWith('claude-opus-4')
    const createParams = {
      model,
      max_tokens: options.maxOutputTokens || 8192,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }
    if (supportsTemperature) {
      createParams.temperature = options.temperature !== undefined ? options.temperature : 0.8
    }
    response = await getClient().messages.create(createParams)
  } catch (err) {
    const status = err.status || err.statusCode
    if (status === 429) {
      const e = new Error('Anthropic rate limit reached')
      e.code   = 'RATE_LIMIT'
      e.status = 429
      throw e
    }
    if (status === 401) {
      const e = new Error('Anthropic API key invalid')
      e.code   = 'INVALID_KEY'
      e.status = 401
      throw e
    }
    if (status === 503 || status === 529) {
      const e = new Error('Anthropic model overloaded')
      e.code   = 'MODEL_UNAVAILABLE'
      e.status = 503
      throw e
    }
    throw err
  }

  const text = response.content?.[0]?.text ?? ''

  const meta = {
    provider: 'anthropic',
    model,
    tokens_used: {
      input:  response.usage?.input_tokens  ?? 0,
      output: response.usage?.output_tokens ?? 0,
      cached: response.usage?.cache_read_input_tokens ?? 0,
    },
    duration_ms: Date.now() - startTime,
  }

  if (options.rawText) return { data: text.trim(), meta }

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const e = new Error('Anthropic returned unparseable JSON')
    e.code = 'PARSE_ERROR'
    throw e
  }

  return { data: parsed, meta }
}

module.exports = { callAnthropic }
