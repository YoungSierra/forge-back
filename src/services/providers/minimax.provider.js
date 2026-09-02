const OpenAI = require('openai')
const { jsonrepair } = require('jsonrepair')

// El endpoint cambió con la cuenta nueva: `api.minimaxi.chat` → `api.minimax.io`. Va por entorno
// y no fijo en el código, que es lo que obligaba a un despliegue para cambiar de cuenta; el valor
// por defecto es el nuevo, así que sin tocar nada el back apunta bien.
const MINIMAX_BASE = () => process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1'

let _client = null
let _base   = null
function getClient() {
  // El cliente se cachea, así que un cambio de base con el proceso vivo se quedaba con el viejo.
  if (!_client || _base !== MINIMAX_BASE()) {
    _base = MINIMAX_BASE()
    _client = new OpenAI({ apiKey: process.env.MINIMAX_API_KEY, baseURL: _base })
    console.log(`[MiniMax] endpoint: ${_base}`)
  }
  return _client
}

// M2.7 es modelo de razonamiento — no soporta response_format ni temperature
const REASONING_MODELS = /^MiniMax-M/i

// Escapa caracteres de control literales dentro de strings JSON.
// Los modelos de razonamiento a veces ponen newlines/tabs reales en valores multi-línea,
// lo que produce JSON sintácticamente inválido aunque se vea "bien".
function repairControlChars(text) {
  let inString = false
  let escaped  = false
  let result   = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escaped)    { result += ch; escaped = false; continue }
    if (ch === '\\') { escaped = true; result += ch; continue }
    if (ch === '"')  { inString = !inString; result += ch; continue }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue }
      if (ch === '\r') { result += '\\r'; continue }
      if (ch === '\t') { result += '\\t'; continue }
      const code = ch.charCodeAt(0)
      if (code < 32)  { result += `\\u${code.toString(16).padStart(4, '0')}`; continue }
    }
    result += ch
  }
  return result
}

// jsonrepair maneja errores estructurales que repairControlChars no puede:
// comas faltantes, comillas sin escapar, claves sin comillas, trailing commas, etc.
function tryJsonRepair(s) {
  try { return JSON.parse(jsonrepair(s)) } catch { return null }
}

function stripAndParse(candidate) {
  // Quitar fences de markdown
  let s = candidate
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  // Intento 1: parse directo
  try { return JSON.parse(s) } catch {}

  // Intento 2: reparar caracteres de control sin escapar en strings
  try { return JSON.parse(repairControlChars(s)) } catch {}

  // Intento 3: jsonrepair (comas faltantes, comillas sin escapar, etc.)
  const r3 = tryJsonRepair(s)
  if (r3) return r3

  // Intento 4: extraer bloque JSON con regex greedy y luego jsonrepair
  const m = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (m) {
    try { return JSON.parse(m[1]) } catch {}
    try { return JSON.parse(repairControlChars(m[1])) } catch {}
    const r4 = tryJsonRepair(m[1])
    if (r4) return r4
  }

  return null
}

function extractJson(text) {
  // Estrategia 1: tomar todo lo que viene DESPUÉS del último </think>
  // (cubre modelos que emiten varios bloques de razonamiento)
  const closeTag = '</think>'
  const closeIdx = text.lastIndexOf(closeTag)
  if (closeIdx !== -1) {
    const afterThink = text.slice(closeIdx + closeTag.length).trim()
    const parsed = stripAndParse(afterThink)
    if (parsed) return parsed
    // Si hay contenido pero no parseó, loguearlo para diagnóstico
    if (afterThink.length > 0) {
      let parseErr = '?'
      try { JSON.parse(afterThink) } catch (e) { parseErr = e.message }
      console.warn(`[MiniMax] </think> encontrado pero parse falló: ${parseErr}`)
      console.warn('[MiniMax] after </think> (primeros 300 chars):\n', afterThink.slice(0, 300))
    }
  }

  // Estrategia 2: quitar TODOS los bloques <think>...</think> con regex
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (stripped.length > 0) {
    const parsed = stripAndParse(stripped)
    if (parsed) return parsed
  }

  // Estrategia 3: si el bloque <think> nunca se cerró, descartar desde <think> en adelante
  const openIdx = text.indexOf('<think>')
  if (openIdx !== -1) {
    const beforeThink = text.slice(0, openIdx).trim()
    if (beforeThink.length > 0) {
      const parsed = stripAndParse(beforeThink)
      if (parsed) return parsed
    }
  }

  // Estrategia 4 (último recurso): jsonrepair sobre el texto completo sin think
  const fallback = stripped.length > 0 ? stripped : text
  const r = tryJsonRepair(fallback)
  if (r) return r

  return null
}

// El razonamiento del modelo NO es la respuesta. En modo JSON ya se descartaba —`extractJson` se
// queda con lo que hay después del `</think>`— pero en modo TEXTO se devolvía el crudo, así que el
// bloque entero viajaba al documento. Medido el 31-08: cero salidas vivas lo tienen, porque
// todavía ningún nodo corre con MiniMax; el día que uno lo haga, el `<think>` se imprime.
function sinRazonamiento (texto) {
  const t = String(texto || '')
  const cierra = t.lastIndexOf('</think>')
  // Lo que viene DESPUÉS del último cierre. Cubre a los modelos que emiten varios bloques.
  if (cierra !== -1) {
    const despues = t.slice(cierra + '</think>'.length).trim()
    // Un `</think>` sin nada detrás significa que el modelo se quedó pensando y no respondió.
    // Devolver el bloque sería peor que devolver vacío: parecería una respuesta.
    if (despues) return despues
  }
  // Bloques cerrados en medio del texto. Solo vale si QUITÓ algo: si no hay pares, `replace`
  // devuelve el mismo texto y devolverlo aquí se saltaba el caso de abajo — que es justo el que
  // este limpiador existe para cubrir. Se ve con `max_tokens` corto: el modelo se queda pensando,
  // el bloque nunca cierra y el razonamiento entero salía como si fuera la respuesta.
  const limpio = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (limpio && limpio !== t.trim()) return limpio
  // Un `<think>` que nunca cerró: se descarta desde ahí. Lo que quede antes puede ser vacío, y
  // vacío es la respuesta correcta — el modelo no llegó a contestar.
  const abre = t.indexOf('<think>')
  if (abre !== -1) return t.slice(0, abre).trim()
  return t.trim()
}

async function callMinimax(systemPrompt, userMessage, options = {}) {
  const model     = options.model || 'MiniMax-M2.7'
  const startTime = Date.now()
  const isReasoning = REASONING_MODELS.test(model)

  // Para modelos de razonamiento: inyectar instrucción JSON al INICIO y al FINAL del system prompt.
  // El template de R2 puede terminar con instrucciones de formato markdown (e.g. "Begin with the title line").
  // El override al final es necesario para que la instrucción JSON sea la última que ve el modelo.
  const JSON_OVERRIDE_PREFIX = 'CRITICAL OVERRIDE: Your ENTIRE response must be a single valid JSON object. Do NOT write markdown, headers, bullet points, tables, or any text outside the JSON. Start immediately with { and end with }. No code fences. No explanation.\n\n'
  const JSON_OVERRIDE_SUFFIX = '\n\n---\nFINAL REMINDER — THIS OVERRIDES ALL PREVIOUS FORMAT INSTRUCTIONS: Output ONLY a valid JSON object. Start with { and end with }. No markdown. No headers. No title line. No document structure. Pure JSON only.'

  const effectiveSystem = (!options.rawText && isReasoning)
    ? `${JSON_OVERRIDE_PREFIX}${systemPrompt}${JSON_OVERRIDE_SUFFIX}`
    : systemPrompt

  const effectiveUser = (!options.rawText && isReasoning)
    ? `${userMessage}\n\n---\nOUTPUT REQUIREMENT: Respond with ONLY a valid JSON object. Start with { and end with }. No markdown. No headers. No text before or after the JSON.`
    : userMessage

  const params = {
    model,
    max_tokens: options.maxOutputTokens || 8192,
    messages: [
      { role: 'system', content: effectiveSystem },
      // Bloques de vision cuando hay imagenes; el string de siempre cuando no. MiniMax habla el
      // mismo esquema que OpenAI, comprobado el 02-09 contra su API: se le mando una imagen del
      // proyecto y describio sus paneles uno por uno. Hasta hoy no estaba en la lista de
      // proveedores con vision, asi que cada imagen se descartaba y al modelo le llegaba solo la
      // URL como texto — once referencias tiradas en una sola corrida del 2.5.
      { role: 'user',   content: options.images?.length
        ? require('../vision.format').contenidoOpenAI(options.images, effectiveUser)
        : effectiveUser },
    ],
  }

  if (!isReasoning && !options.rawText) {
    params.temperature      = options.temperature !== undefined ? options.temperature : 0.8
    params.response_format  = { type: 'json_object' }
  } else if (!isReasoning && options.rawText) {
    params.temperature = options.temperature !== undefined ? options.temperature : 0.8
  }

  // SIEMPRE en streaming. Sin él, una entrada grande deja la conexión muda hasta el final y
  // MiniMax no vuelve nunca: medido el 31-08 con el 3.12 —123k tokens de entrada— la llamada
  // estuvo **32 minutos colgada con 2,4 s de CPU**, esperando red. La misma entrada en streaming
  // devolvió el primer token a los 3,5 s y terminó en 49 s.
  //
  // Es además lo que ya hace el provider de Anthropic, y por eso el 3.12 sí corría con Sonnet.
  //
  // `signal` viaja: sin él el Stop soltaba al cliente y MiniMax seguía generando y facturando.
  params.stream = true
  params.stream_options = { include_usage: true }

  let response
  try {
    const flujo = await getClient().chat.completions.create(
      params,
      options.signal ? { signal: options.signal } : undefined,
    )
    let texto = ''
    let uso = null
    let ultimoTrozo = Date.now()
    for await (const parte of flujo) {
      texto += parte.choices?.[0]?.delta?.content || ''
      if (parte.usage) uso = parte.usage
      ultimoTrozo = Date.now()
    }
    // El SDK ya normaliza la forma; se arma la respuesta que espera el resto de esta función para
    // no tocar el parseo, que es dónde viven las cuatro estrategias de extracción de JSON.
    void ultimoTrozo
    response = { choices: [{ message: { content: texto } }], usage: uso || {} }
  } catch (err) {
    // Abortar es del usuario, no una falla del proveedor: se propaga tal cual para que arriba se
    // distinga de un error real y no se registre como fallo ni se reintente.
    if (err?.name === 'AbortError' || options.signal?.aborted) {
      const e = new Error('cancelado por el usuario')
      e.code = 'ABORTED'
      throw e
    }
    const status = err.status || err.statusCode
    if (status === 429) {
      const retryAfter = err.headers?.['retry-after']
      const e = new Error('MiniMax rate limit reached')
      e.code  = 'RATE_LIMIT'
      e.status = 429
      e.retry_after_ms = retryAfter ? parseInt(retryAfter) * 1000 : 60000
      throw e
    }
    if (status === 401) {
      const e = new Error('MiniMax API key invalid')
      e.code  = 'INVALID_KEY'
      e.status = 401
      throw e
    }
    if (status === 503) {
      const e = new Error('MiniMax model unavailable')
      e.code  = 'MODEL_UNAVAILABLE'
      e.status = 503
      throw e
    }
    throw err
  }

  const raw = response.choices[0]?.message?.content || ''

  if (options.rawText) {
    return {
      data: sinRazonamiento(raw),
      meta: { provider: 'minimax', model, tokens_used: { input: response.usage?.prompt_tokens || 0, output: response.usage?.completion_tokens || 0, cached: 0 }, duration_ms: Date.now() - startTime }
    }
  }

  const parsed = extractJson(raw)

  if (!parsed) {
    const closeIdx = raw.lastIndexOf('</think>')
    const afterThink = closeIdx !== -1 ? raw.slice(closeIdx + '</think>'.length).trim() : '(no </think> found)'
    console.error('[MiniMax] unparseable response')
    console.error('  raw length:', raw.length, '| has </think>:', closeIdx !== -1)
    console.error('  raw (primeros 400 chars):\n', raw.slice(0, 400))
    console.error('  after </think> (primeros 400 chars):\n', afterThink.slice(0, 400))
    const e = new Error('MiniMax returned unparseable JSON')
    e.code = 'PARSE_ERROR'
    e.raw  = raw.slice(0, 500)
    throw e
  }

  return {
    data: parsed,
    meta: {
      provider: 'minimax',
      model,
      tokens_used: {
        input:  response.usage?.prompt_tokens     || 0,
        output: response.usage?.completion_tokens || 0,
        cached: 0,
      },
      duration_ms: Date.now() - startTime,
    },
  }
}

module.exports = { callMinimax }
