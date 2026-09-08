const Anthropic = require('@anthropic-ai/sdk')

let _client = null
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// Reintenta la llamada streaming ante overloaded (529/503) — incluido el caso en que Anthropic
// corta el stream A MITAD de una generación larga (el SDK no reintenta eso solo). Sin este retry,
// un blip transitorio mata un TDD de varios minutos y quema el crédito de input ya consumido.
async function streamFinalWithRetry(params, { retries = 4, signal = null } = {}) {
  for (let attempt = 0; ; attempt++) {
    // Cancelar de verdad: sin propagar la señal, apretar Stop soltaba al cliente pero el
    // proveedor seguía generando y el crédito se gastaba igual.
    if (signal?.aborted) { const e = new Error('cancelado por el usuario'); e.code = 'ABORTED'; throw e }
    try {
      return await getClient().messages.stream(params, signal ? { signal } : undefined).finalMessage()
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

// El tope de la Messages API son 32 MB por petición, medidos sobre el cuerpo que sale al cable.
// Se corta en 30 para dejar aire a la estructura JSON y a las cabeceras.
const TOPE_PETICION = 30 * 1024 * 1024

/**
 * Última guarda antes de mandar: si el mensaje armado se pasa del tope, se sueltan imágenes desde
 * el final hasta que entre.
 *
 * Va acá y no en `vision.service` porque este es el único punto donde el system prompt, el texto y
 * las imágenes existen a la vez — allá se puede acotar el peso de las imágenes, pero no saber con
 * cuánto texto van a compartir la petición. Cortar allá con un número fijo obligaba a elegir entre
 * descartar referencias que sí entraban o arriesgar el 413; acá el número es exacto.
 *
 * Se sueltan las ÚLTIMAS: las referencias llegan en el orden en que el nodo las declara, así que
 * las primeras son las que el autor puso primero.
 */
function recortarImagenes(images, systemPrompt, userMessage) {
  if (!images?.length) return images
  const mb = n => (n / 1048576).toFixed(1)
  const fijo = (systemPrompt?.length || 0) + (typeof userMessage === 'string' ? userMessage.length : 0)

  const quedan = [...images]
  let total = fijo + quedan.reduce((t, im) => t + im.base64.length, 0)
  if (total <= TOPE_PETICION) return images

  const antes = quedan.length
  while (quedan.length && total > TOPE_PETICION) {
    total -= quedan.pop().base64.length
  }
  console.warn(`[anthropic] petición de ${mb(fijo + images.reduce((t, im) => t + im.base64.length, 0))} MB ` +
    `sobre el tope de ${mb(TOPE_PETICION)} MB — van ${quedan.length} de ${antes} imagen(es), ` +
    `quedó en ${mb(total)} MB (texto ${mb(fijo)} MB)`)
  return quedan
}

// El system prompt viaja CACHEADO.
//
// El del 3.8 son 189.430 caracteres —unos 47.000 tokens— y se reenviaba entero en cada llamada.
// Una corrida de ese nodo hace ocho o diez peticiones: la principal, un re-pedido por cada sección
// que no salió, y las continuaciones. Todas cargan el mismo prompt, y sin caché todas lo pagan
// completo, en dinero y en espera.
//
// El caching es por PREFIJO: basta con marcar el bloque del sistema para que las llamadas
// siguientes de la misma corrida lo lean de la caché a una décima parte. Es GA, sin cabecera beta.
// El contador ya existía —`cache_read_input_tokens` se lee desde siempre en el meta— pero nunca se
// mandaba `cache_control`, así que medía un ahorro que no ocurría.
//
// Se pasa de string a bloque solo cuando hay prompt: los proveedores aceptan las dos formas, y un
// prompt vacío marcado como cacheable es un bloque de texto vacío, que la API rechaza.
const sistemaCacheable = prompt =>
  prompt && String(prompt).trim()
    ? [{ type: 'text', text: String(prompt), cache_control: { type: 'ephemeral' } }]
    : prompt

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
  const imagenes = recortarImagenes(options.images, systemPrompt, userMessage)
  const content = imagenes?.length
    ? require('../vision.format').contenidoAnthropic(imagenes, userMessage)
    : userMessage

  let response
  try {
    const createParams = {
      model,
      max_tokens: maxTokens,
      system:     sistemaCacheable(systemPrompt),
      messages:   [{ role: 'user', content }],
    }
    if (supportsTemperature) createParams.temperature = temperature
    // Streaming: en generaciones largas el request NO-stream golpea el timeout del cliente HTTP
    // del SDK ("Request timed out"). stream()+finalMessage() espera el fin y ensambla el mensaje.
    response = await streamFinalWithRetry(createParams, { signal: options.signal })
  } catch (err) {
    const status = err.status || err.statusCode
    // `publico` marca los errores que el usuario PUEDE leer y accionar. El handler global manda
    // «Internal server error» para todo lo demás, y eso es correcto para un stack inesperado —
    // pero convertía diagnósticos exactos del proveedor en un mensaje que no dice nada. El 413
    // del 08-09 traía escrito «Request exceeds the maximum size» y esa frase nunca salió del log.
    if (status === 429) {
      const e = new Error('Anthropic rate limit reached')
      e.code    = 'RATE_LIMIT'
      e.status  = 429
      e.publico = true
      throw e
    }
    if (status === 401) {
      const e = new Error('Anthropic API key invalid')
      e.code    = 'INVALID_KEY'
      e.status  = 401
      e.publico = true
      throw e
    }
    if (status === 503 || status === 529) {
      const e = new Error('Anthropic model overloaded')
      e.code    = 'MODEL_UNAVAILABLE'
      e.status  = 503
      e.publico = true
      throw e
    }
    // 413: la petición pasó de 32 MB. Con el presupuesto de `vision.service` no debería volver a
    // ocurrir por imágenes, así que si aparece es que el peso vino del TEXTO —un nodo con muchos
    // inputs resueltos— y el mensaje tiene que decir de qué tamaño estamos hablando para que se
    // pueda mirar el lado correcto.
    if (status === 413) {
      const mb = n => (n / 1048576).toFixed(1)
      const pesoImgs = (imagenes || []).reduce((t, im) => t + im.base64.length, 0)
      const detalle  = imagenes?.length
        ? `${imagenes.length} imagen(es) pesan ${mb(pesoImgs)} MB en base64`
        : 'la petición no lleva imágenes: el peso viene del texto'
      const e = new Error(`La petición supera el tope de 32 MB de Anthropic — ${detalle}`)
      e.code    = 'REQUEST_TOO_LARGE'
      e.status  = 413
      e.publico = true
      console.error(`[anthropic] 413 · system ${mb(systemPrompt?.length || 0)} MB · ` +
        `texto ${mb(typeof userMessage === 'string' ? userMessage.length : 0)} MB · ${detalle}`)
      throw e
    }
    throw err
  }

  // Texto + tokens, con AUTO-CONTINUACIÓN: si el modelo cortó por límite de tokens
  // (stop_reason === 'max_tokens'), se continúa automáticamente hasta completar. El usuario final
  // NUNCA ve un output truncado ni tiene que pedir «continuá», y el output llega entero en una
  // sola pieza (clave para «Accept as output»).
  //
  // Se continuaba con un PREFILL del assistant —dejar el turno del modelo abierto para que siguiera
  // escribiendo—. Anthropic retiró el prefill de toda la familia 4.6 en adelante y desde entonces
  // devuelve 400: «This model does not support assistant message prefill. The conversation must end
  // with a user message.» O sea que llevaba rota desde que los nodos pasaron a Sonnet 4.6, y cada
  // intento reenviaba el mensaje completo —system, texto e imágenes— para cobrar un error. Medido
  // el 08-09 en el 3.8: dos peticiones tiradas en una sola corrida.
  //
  // Ahora el turno parcial se deja como está y se pide la continuación con un mensaje de USUARIO,
  // que es la forma que la API sí acepta. El texto se une igual, así que «Accept as output» sigue
  // recibiendo una pieza sola.
  let fullText     = extractText(response)
  let stopReason   = response.stop_reason
  let inTokens     = response.usage?.input_tokens  ?? 0
  let outTokens    = response.usage?.output_tokens ?? 0
  let cachedTokens = response.usage?.cache_read_input_tokens ?? 0
  // Escribir la caché cuesta 1,25× y leerla 0,1×. Sin este contador el gasto se subestima en
  // la primera llamada de cada corrida, que es justo la que paga el prompt entero.
  let cacheWrite   = response.usage?.cache_creation_input_tokens ?? 0

  const MAX_CONTINUATIONS = 6
  for (let cont = 0; stopReason === 'max_tokens' && cont < MAX_CONTINUATIONS; cont++) {
    console.log(`[anthropic] max_tokens alcanzado — auto-continuando (${cont + 1}/${MAX_CONTINUATIONS})`)
    const escrito = fullText.replace(/\s+$/, '')
    try {
      const contParams = {
        model,
        max_tokens: maxTokens,
        system:     sistemaCacheable(systemPrompt),
        messages:   [
          // El MISMO contenido que la primera vuelta, imágenes incluidas. Si acá se mandara solo
          // el texto, la continuación seguiría escribiendo sin ver las referencias y se
          // contradiría con lo que ya llevaba escrito. Cuesta reenviarlas; salir mal cuesta más.
          { role: 'user',      content },
          { role: 'assistant', content: escrito },
          // La conversación tiene que TERMINAR en usuario. Y hay que decirle dónde retomar: sin
          // esto el modelo saluda, resume lo que ya escribió, o vuelve a empezar el documento — y
          // cualquiera de las tres cosas se pega al texto acumulado y lo arruina.
          { role: 'user', content:
            'Continue the response from exactly where it stopped. Do not repeat anything already ' +
            'written, do not restart, and do not add any preamble, apology or summary — your reply ' +
            'is concatenated verbatim to what you already produced, so it must read as the seamless ' +
            'continuation of that last character.' },
        ],
      }
      if (supportsTemperature) contParams.temperature = temperature
      const contResp = await streamFinalWithRetry(contParams, { signal: options.signal })
      fullText     = escrito + extractText(contResp)
      stopReason   = contResp.stop_reason
      inTokens    += contResp.usage?.input_tokens  ?? 0
      outTokens   += contResp.usage?.output_tokens ?? 0
      cachedTokens += contResp.usage?.cache_read_input_tokens ?? 0
      cacheWrite   += contResp.usage?.cache_creation_input_tokens ?? 0
    } catch (err) {
      console.warn(`[anthropic] auto-continuación falló: ${err.message} — devuelvo lo acumulado`)
      break
    }
  }

  const text = fullText

  const meta = {
    provider: 'anthropic',
    model,
    tokens_used: { input: inTokens, output: outTokens, cached: cachedTokens, cache_write: cacheWrite },
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

module.exports = { callAnthropic, recortarImagenes, TOPE_PETICION }
