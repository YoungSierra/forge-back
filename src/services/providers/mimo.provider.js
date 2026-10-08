const https = require('https')

const MIMO_BASE_URL = 'https://token-plan-sgp.xiaomimimo.com/v1'
// Inactividad máxima del socket (sin bytes del servidor). MiMo no hace streaming aquí, así que en una
// generación larga solo llegan bytes si el gateway los gotea; 60 s era el valor de siempre y se deja
// como defecto. Configurable por entorno sin tocar código.
const MIMO_IDLE_TIMEOUT_MS = Number(process.env.MIMO_IDLE_TIMEOUT_MS) || 60000

// Solicitud HTTPS sin usar el OpenAI SDK — más control sobre errores de red.
//
// La promesa SIEMPRE termina: antes solo se escuchaban `data`/`end` de la respuesta y `error`/`timeout`
// de la petición. Si el servidor cortaba la conexión a mitad del cuerpo, Node emitía `aborted`,
// `error` (ECONNRESET) y `close` en la RESPUESTA, nadie los escuchaba y el `await` quedaba colgado
// para siempre: la sesión seguía `active`, el usuario veía «la conexión se cayó» a los 11 minutos y
// relanzaba. Medido el 07-10 en Professor_Wort_&_Sprat_world (huecos de 12,7 y 9,5 min sin rastro).
// `signal` llega desde el botón Stop: destruir la petición es lo que deja de pagar la generación.
function httpsPost(url, headers, body, { signal = null, timeoutMs = MIMO_IDLE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url)
    const options = {
      hostname:           parsed.hostname,
      port:               parsed.port || 443,
      path:               parsed.pathname + parsed.search,
      method:             'POST',
      headers,
      timeout:            timeoutMs,
      rejectUnauthorized: false, // diagnóstico — permite ver el error real
    }

    let terminado = false
    const terminar = (fn, valor) => {
      if (terminado) return
      terminado = true
      if (signal) signal.removeEventListener('abort', onAbort)
      fn(valor)
    }
    const fallar = (code, mensaje, publico = true) => {
      const e = new Error(mensaje)
      e.code = code
      if (publico) e.publico = true
      terminar(reject, e)
    }
    let req = null
    const onAbort = () => {
      if (req) req.destroy()
      fallar('ABORTED', 'cancelado por el usuario', false)
    }

    req = https.request(options, res => {
      let raw = ''
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => { if (res.complete) terminar(resolve, { status: res.statusCode, headers: res.headers, body: raw }) })
      res.on('aborted', () => fallar('CONNECTION_CUT', `MiMo cut the connection before finishing the response (${raw.length} bytes received). Nothing was saved — run it again.`))
      res.on('error', err => fallar(err.code || 'CONNECTION_CUT', `MiMo connection error while receiving the response (${err.code || err.message}). Nothing was saved — run it again.`))
      res.on('close', () => { if (!res.complete) fallar('CONNECTION_CUT', `MiMo closed the connection before the response completed (${raw.length} bytes received). Nothing was saved — run it again.`) })
    })

    req.on('timeout', () => {
      req.destroy()
      fallar('TIMEOUT', `MiMo sent no data for ${Math.round(timeoutMs / 1000)} s and the request was dropped. Nothing was saved — run it again.`)
    })

    req.on('error', err => {
      if (terminado) return
      console.error('[mimo] network error:', err.code, err.message)
      terminar(reject, err)
    })

    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    req.write(body)
    req.end()
  })
}

async function callMimo(systemPrompt, userMessage, options = {}) {
  const apiKey = process.env.MIMO_API_KEY
  if (!apiKey) throw new Error('MIMO_API_KEY no está configurada')

  // El respaldo, para cuando nadie elige modelo. Se deja en 2.5-pro a propósito aunque ya exista
  // el 2.6: ningún nodo declara mimo todavía, así que esta línea nunca ha corrido y cambiarla
  // sería estrenar un modelo nuevo por la puerta de atrás. El 2.6 se elige en el admin.
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
    }, bodyStr, { signal: options.signal || null })
  } catch (fetchErr) {
    // Los errores con causa conocida (ABORTED, TIMEOUT, CONNECTION_CUT) ya vienen formados y
    // marcados `publico`: se dejan pasar tal cual para que el usuario lea la causa y no «Internal
    // server error». El resto sigue siendo un error de red genérico.
    if (fetchErr?.code === 'ABORTED' || fetchErr?.publico) throw fetchErr
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
    e.publico = true   // la causa (p. ej. 400 context length exceeded) le sirve al usuario; «Internal server error» no
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
  // `length` = el modelo chocó con max_tokens y el texto está cortado. Viaja en la meta para que quien
  // guarda no lo apruebe como un éxito más (OpenAI y Gemini lanzan MAX_TOKENS en este caso; aquí el
  // texto se conserva y se marca, que es lo que pide el flujo de chat).
  const finishReason = data.choices?.[0]?.finish_reason ?? null
  if (finishReason === 'length') console.warn(`[mimo] finish_reason=length: respuesta truncada en ${data.usage?.completion_tokens ?? '?'} tokens de salida`)

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
        finish_reason: finishReason,
        truncated: finishReason === 'length',
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
      finish_reason: finishReason,
      truncated: finishReason === 'length',
    },
  }
}

module.exports = { callMimo }
