const { callGemini }     = require('./providers/gemini.provider')
const { callGroq }       = require('./providers/groq.provider')
const { callTogether }   = require('./providers/together.provider')
const { callOpenRouter } = require('./providers/openrouter.provider')
const { callOpenAI }     = require('./providers/openai.provider')
const { callMinimax }    = require('./providers/minimax.provider')
const { callMimo }       = require('./providers/mimo.provider')
const { callAnthropic }  = require('./providers/anthropic.provider')
const { resolveStepModel, parseModelString } = require('./config.service')

// Limpia bloques <think>...</think> que algunos modelos con razonamiento extendido incluyen
// (Gemini 2.5 Flash thinking, DeepSeek R1, Qwen, etc.) — aplica independiente del provider
function stripThinkBlocks(text) {
  return typeof text === 'string' ? text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : text
}

async function callLLM(systemPrompt, userMessage, options = {}) {
  const step = options.step || null

  const { provider, model } = step
    ? await resolveStepModel(step)
    : parseModelString(options.model || process.env.DEFAULT_MODEL)

  const callOptions = {
    ...options,
    model,
    maxOutputTokens: options.maxOutputTokens || 8192,
    temperature: options.temperature !== undefined ? options.temperature : 0.8,
  }

  // Cada proveedor con visión tiene su propio formato — ver vision.format. Los que no la
  // soportan (minimax, mimo) reciben solo texto: mandarles bloques los rompería. El modelo de un
  // nodo se cambia desde el admin, así que este caso puede aparecer sin tocar código.
  const { soportaVision } = require('./vision.format')
  if (callOptions.images?.length && !soportaVision(provider)) {
    console.warn(`[LLM] ${callOptions.images.length} imagen(es) descartadas: "${provider}" no acepta visión`)
    delete callOptions.images
  }

  console.log(
    `[LLM] Step: ${step || 'default'} | Provider: ${provider} | Model: ${model}` +
    (callOptions.images?.length ? ` | ${callOptions.images.length} imagen(es)` : ''),
  )

  let result
  try {
    result = await despachar(provider, systemPrompt, userMessage, callOptions)
  } catch (err) {
    throw clasificar(err, provider, model)
  }

  if (result?.data) result.data = stripThinkBlocks(result.data)
  return result
}

/**
 * De un error del proveedor a uno que se puede enseñar.
 *
 * El manejador de errores deja pasar el mensaje tal cual cuando el error viene marcado
 * `publico`; sin esa marca, todo se convierte en «Internal server error». Eso es lo que vio
 * Migue el 16-09: el proveedor rechazó la llamada por saldo y la pantalla dijo que había
 * fallado el servidor, que manda a buscar el problema donde no está.
 *
 * Se clasifica acá y no en cada proveedor porque el agujero es de todos: hoy MiniMax, mañana
 * el que toque. Lo que no se reconoce se deja opaco a propósito — un stack inesperado no es un
 * mensaje para nadie.
 */
function clasificar(err, provider, model) {
  if (err?.code === 'ABORTED') return err

  const status = err.status || err.statusCode
  const texto = `${err.message || ''} ${JSON.stringify(err.error || err.body || '')}`.toLowerCase()

  // MiniMax manda «insufficient balance» con el código 1008 dentro del cuerpo, no como estado.
  const sinSaldo = status === 402
    || /insufficient (balance|credit|funds|quota)/.test(texto)
    || /\b1008\b/.test(texto)
    || /arrears|out of credit|billing/.test(texto)

  if (sinSaldo) {
    return Object.assign(new Error(
      `${provider} rejected the call for lack of balance. Nothing was generated and nothing was charged — top up that provider account and run it again.`),
      { publico: true, status: 402, code: 'SIN_SALDO_PROVEEDOR', provider })
  }
  if (status === 429 || err.code === 'RATE_LIMIT') {
    return Object.assign(new Error(`${provider} is rate limiting: too many calls in a row. Wait a moment and run it again.`),
      { publico: true, status: 429, code: 'RATE_LIMIT', provider, retry_after_ms: err.retry_after_ms })
  }
  if (status === 401 || err.code === 'INVALID_KEY') {
    return Object.assign(new Error(`The ${provider} key is not valid on this server. That is configuration, not your run.`),
      { publico: true, status: 401, code: 'CLAVE_INVALIDA', provider })
  }
  if (status === 503 || err.code === 'MODEL_UNAVAILABLE') {
    return Object.assign(new Error(`${provider} has "${model}" unavailable right now. Nothing was charged.`),
      { publico: true, status: 503, code: 'MODELO_NO_DISPONIBLE', provider })
  }
  return err
}

async function despachar(provider, systemPrompt, userMessage, callOptions) {
  let result
  switch (provider) {
    case 'groq':       result = await callGroq(systemPrompt, userMessage, callOptions); break
    case 'together':   result = await callTogether(systemPrompt, userMessage, callOptions); break
    case 'openrouter': result = await callOpenRouter(systemPrompt, userMessage, callOptions); break
    case 'openai':     result = await callOpenAI(systemPrompt, userMessage, callOptions); break
    case 'minimax':    result = await callMinimax(systemPrompt, userMessage, callOptions); break
    case 'mimo':       result = await callMimo(systemPrompt, userMessage, callOptions); break
    case 'anthropic':  result = await callAnthropic(systemPrompt, userMessage, callOptions); break
    case 'gemini':
    default:           result = await callGemini(systemPrompt, userMessage, callOptions); break
  }

  return result
}

module.exports = { callLLM, parseModelString, clasificar }
