const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function callGroq(systemPrompt, userMessage, options = {}) {
  const model = options.model || 'llama-3.3-70b-versatile'
  const startTime = Date.now()

  let response
  try {
    response = await groq.chat.completions.create({
      model,
      temperature: options.temperature !== undefined ? options.temperature : 0.8,
      max_tokens: options.maxOutputTokens || 8192,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  } catch (err) {
    const status = err.status || err.statusCode
    if (status === 429) {
      const retryAfter = err.headers?.['retry-after']
      const e = new Error('Groq rate limit reached')
      e.code = 'RATE_LIMIT'
      e.status = 429
      e.retry_after_ms = retryAfter ? parseInt(retryAfter) * 1000 : 60000
      throw e
    }
    if (status === 401) {
      const e = new Error('Groq API key invalid')
      e.code = 'INVALID_KEY'
      e.status = 401
      throw e
    }
    if (status === 503) {
      const e = new Error('Groq model unavailable')
      e.code = 'MODEL_UNAVAILABLE'
      e.status = 503
      throw e
    }
    throw err
  }

  const text = response.choices[0].message.content
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const e = new Error('Groq returned unparseable JSON')
    e.code = 'PARSE_ERROR'
    throw e
  }

  return {
    data: parsed,
    meta: {
      provider: 'groq',
      model,
      tokens_used: {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
        cached: 0
      },
      duration_ms: Date.now() - startTime
    }
  }
}

module.exports = { callGroq }
