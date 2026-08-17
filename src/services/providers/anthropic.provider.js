const Anthropic = require('@anthropic-ai/sdk')

let _client = null
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// Reintenta la llamada streaming ante overloaded (529/503) — incluido el caso en que Anthropic
// corta el stream A MITAD de una generación larga (el SDK no reintenta eso solo). Sin este retry,
// un blip transitorio mata un TDD de varios minutos y quema el crédito de input ya consumido.
async function streamFinalWithRetry(params, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getClient().messages.stream(params).finalMessage()
    } catch (err) {
      const status = err.status || err.statusCode
      const msg    = err?.error?.message || err?.message || ''
      const overloaded = status === 529 || status === 503 || /overloaded/i.test(msg)
      if (!overloaded || attempt >= retries) throw err
      const waitMs = Math.min(30000, 2000 * 2 ** attempt) // 2s, 4s, 8s, 16s
      console.warn(`[anthropic] overloaded — reintento ${attempt + 1}/${retries} en ${waitMs}ms`)
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
}

async function callAnthropic(systemPrompt, userMessage, options = {}) {
  const model     = options.model || 'claude-sonnet-4-6'
  const startTime = Date.now()

  // claude-opus-4-x no acepta temperature (usa extended thinking internamente)
  const supportsTemperature = !model.startsWith('claude-opus-4')
  const temperature = options.temperature !== undefined ? options.temperature : 0.8
  const maxTokens   = options.maxOutputTokens || 8192
  // Junta todos los bloques de texto del mensaje (robusto a múltiples content blocks).
  const extractText = r => (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('')

  // Las referencias visuales viajan como bloques de imagen, ANTES del texto: el modelo lee
  // mejor cuando ve primero el material y después la consigna. Sin `options.images` el mensaje
  // sigue siendo el string de siempre — este camino no cambia para nadie más.
  const content = options.images?.length
    ? require('../vision.format').contenidoAnthropic(options.images, userMessage)
    : userMessage

  let response
  try {
    const createParams = {
      model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content }],
    }
    if (supportsTemperature) createParams.temperature = temperature
    // Streaming: en generaciones largas el request NO-stream golpea el timeout del cliente HTTP
    // del SDK ("Request timed out"). stream()+finalMessage() espera el fin y ensambla el mensaje.
    response = await streamFinalWithRetry(createParams)
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

  // Texto + tokens, con AUTO-CONTINUACIÓN: si el modelo cortó por límite de tokens
  // (stop_reason === 'max_tokens'), se continúa automáticamente vía assistant-prefill hasta
  // completar. El usuario final NUNCA ve un output truncado ni tiene que pedir "continuá",
  // y el output llega entero en una sola pieza (clave para "Accept as output").
  let fullText     = extractText(response)
  let stopReason   = response.stop_reason
  let inTokens     = response.usage?.input_tokens  ?? 0
  let outTokens    = response.usage?.output_tokens ?? 0
  let cachedTokens = response.usage?.cache_read_input_tokens ?? 0

  const MAX_CONTINUATIONS = 6
  for (let cont = 0; stopReason === 'max_tokens' && cont < MAX_CONTINUATIONS; cont++) {
    console.log(`[anthropic] max_tokens alcanzado — auto-continuando (${cont + 1}/${MAX_CONTINUATIONS})`)
    // El prefill del assistant no puede terminar en whitespace (regla de la API).
    const prefill = fullText.replace(/\s+$/, '')
    try {
      const contParams = {
        model,
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages:   [
          // El MISMO contenido que la primera vuelta, imágenes incluidas. Si acá se mandara solo
          // el texto, la continuación seguiría escribiendo sin ver las referencias y se
          // contradiría con lo que ya llevaba escrito. Cuesta reenviarlas; salir mal cuesta más.
          { role: 'user',      content },
          { role: 'assistant', content: prefill },
        ],
      }
      if (supportsTemperature) contParams.temperature = temperature
      const contResp = await streamFinalWithRetry(contParams)
      fullText     = prefill + extractText(contResp)
      stopReason   = contResp.stop_reason
      inTokens    += contResp.usage?.input_tokens  ?? 0
      outTokens   += contResp.usage?.output_tokens ?? 0
      cachedTokens += contResp.usage?.cache_read_input_tokens ?? 0
    } catch (err) {
      console.warn(`[anthropic] auto-continuación falló: ${err.message} — devuelvo lo acumulado`)
      break
    }
  }

  const text = fullText

  const meta = {
    provider: 'anthropic',
    model,
    tokens_used: { input: inTokens, output: outTokens, cached: cachedTokens },
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
