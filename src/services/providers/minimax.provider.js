const OpenAI = require('openai')
const { jsonrepair } = require('jsonrepair')

let _client = null
function getClient() {
  if (!_client) _client = new OpenAI({
    apiKey: process.env.MINIMAX_API_KEY,
    baseURL: 'https://api.minimaxi.chat/v1',
  })
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
      { role: 'user',   content: effectiveUser },
    ],
  }

  if (!isReasoning && !options.rawText) {
    params.temperature      = options.temperature !== undefined ? options.temperature : 0.8
    params.response_format  = { type: 'json_object' }
  } else if (!isReasoning && options.rawText) {
    params.temperature = options.temperature !== undefined ? options.temperature : 0.8
  }

  let response
  try {
    response = await getClient().chat.completions.create(params)
  } catch (err) {
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
      data: raw.trim(),
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
