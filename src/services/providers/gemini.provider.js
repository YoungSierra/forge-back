const { GoogleGenerativeAI } = require('@google/generative-ai')

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

async function callGemini(systemPrompt, userMessage, options = {}) {
  const model = options.model || 'gemini-2.5-flash'
  const startTime = Date.now()

  const geminiModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: options.rawText ? 'text/plain' : 'application/json',
      temperature: options.temperature !== undefined ? options.temperature : 0.8,
      maxOutputTokens: options.maxOutputTokens || 8192
    }
  })

  let result
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await geminiModel.generateContent(userMessage)
      break
    } catch (apiErr) {
      const status = apiErr.status ?? apiErr.httpStatus
      console.error(`[Gemini] API error | attempt: ${attempt}/2 | model: ${model} | status: ${status} | message: ${apiErr.message}`)
      if (status === 503 && attempt < 2) {
        await new Promise(r => setTimeout(r, 3000))
        continue
      }
      if (status === 429) { const e = new Error('Rate limit'); e.code = 'RATE_LIMIT'; e.status = 429; throw e }
      if (status === 503) { const e = new Error('Model overloaded'); e.code = 'RATE_LIMIT'; e.status = 503; throw e }
      throw apiErr
    }
  }
  const response = result.response

  const finishReason = response.candidates?.[0]?.finishReason
  if (finishReason === 'MAX_TOKENS') {
    const err = new Error(`Response truncated: maxOutputTokens too low for this request (model: ${model})`)
    err.code = 'MAX_TOKENS'
    throw err
  }

  const text = response.text()
  const usage = response.usageMetadata || {}

  if (options.rawText) {
    return {
      data: text.trim(),
      meta: { provider: 'gemini', model, tokens_used: { input: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0, cached: usage.cachedContentTokenCount || 0 }, duration_ms: Date.now() - startTime }
    }
  }

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    const err = new Error(`Failed to parse LLM JSON response (model: ${model})`)
    err.code = 'INVALID_JSON'
    err.raw = text.slice(0, 500)
    throw err
  }

  return {
    data: parsed,
    meta: {
      provider: 'gemini',
      model,
      tokens_used: {
        input: usage.promptTokenCount || 0,
        output: usage.candidatesTokenCount || 0,
        cached: usage.cachedContentTokenCount || 0
      },
      duration_ms: Date.now() - startTime
    }
  }
}

module.exports = { callGemini }
