const https = require('https')

const MIMO_BASE_URL = 'https://token-plan-sgp.xiaomimimo.com/v1'

// Solicitud HTTPS sin usar el OpenAI SDK — más control sobre errores de red
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url)
    const options = {
      hostname:           parsed.hostname,
      port:               parsed.port || 443,
      path:               parsed.pathname + parsed.search,
      method:             'POST',
      headers,
      timeout:            60000,
      rejectUnauthorized: false, // diagnóstico — permite ver el error real
    }

    const req = https.request(options, res => {
      let raw = ''
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }))
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('MiMo request timed out after 60s'))
    })

    req.on('error', err => {
      console.error('[mimo] network error:', err.code, err.message)
      reject(err)
    })

    req.write(body)
    req.end()
  })
}

async function callMimo(systemPrompt, userMessage, options = {}) {
  const apiKey = process.env.MIMO_API_KEY
  if (!apiKey) throw new Error('MIMO_API_KEY no está configurada')

  const model     = options.model || 'xiaomi/mimo-v2.5-pro'
  const startTime = Date.now()

  const bodyObj = {
    model,
    temperature: options.temperature !== undefined ? options.temperature : 0.8,
    max_tokens:  options.maxOutputTokens || 8192,
    ...(options.rawText ? {} : { response_format: { type: 'json_object' } }),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage },
    ],
  }

  const bodyStr = JSON.stringify(bodyObj)

  let res
  try {
    res = await httpsPost(`${MIMO_BASE_URL}/chat/completions`, {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(bodyStr),
    }, bodyStr)
  } catch (fetchErr) {
    const e = new Error(`MiMo network error: ${fetchErr.message}`)
    e.code  = fetchErr.code || 'NETWORK_ERROR'
    throw e
  }

  const { status, body: rawBody } = res

  if (status !== 200) {
    console.error(`[mimo] HTTP ${status}:`, rawBody.slice(0, 300))

    if (status === 429) {
      const retryAfter = res.headers['retry-after']
      const e = new Error('MiMo rate limit reached')
      e.code = 'RATE_LIMIT'
      e.status = 429
      e.retry_after_ms = retryAfter ? parseInt(retryAfter) * 1000 : 60000
      throw e
    }
    if (status === 401) {
      const e = new Error('MiMo API key invalid')
      e.code = 'INVALID_KEY'
      e.status = 401
      throw e
    }
    if (status === 503) {
      const e = new Error('MiMo model unavailable')
      e.code = 'MODEL_UNAVAILABLE'
      e.status = 503
      throw e
    }
    const e = new Error(`MiMo HTTP ${status}: ${rawBody.slice(0, 200)}`)
    e.status = status
    throw e
  }

  let data
  try {
    data = JSON.parse(rawBody)
  } catch {
    const e = new Error('MiMo returned invalid JSON')
    e.code = 'PARSE_ERROR'
    throw e
  }

  const text = data.choices?.[0]?.message?.content ?? ''

  if (options.rawText) {
    return {
      data: text.trim(),
      meta: {
        provider: 'mimo',
        model,
        tokens_used: {
          input:  data.usage?.prompt_tokens     || 0,
          output: data.usage?.completion_tokens || 0,
          cached: 0,
        },
        duration_ms: Date.now() - startTime,
      },
    }
  }

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i,     '')
    .replace(/```\s*$/i,     '')
    .trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const e = new Error('MiMo returned unparseable JSON')
    e.code = 'PARSE_ERROR'
    throw e
  }

  return {
    data: parsed,
    meta: {
      provider: 'mimo',
      model,
      tokens_used: {
        input:  data.usage?.prompt_tokens     || 0,
        output: data.usage?.completion_tokens || 0,
        cached: 0,
      },
      duration_ms: Date.now() - startTime,
    },
  }
}

module.exports = { callMimo }
