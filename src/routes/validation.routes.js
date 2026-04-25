const express = require('express')
const router = express.Router()
const { callLLM } = require('../services/llm.service')
const { VALIDATION_SYSTEM_PROMPT } = require('../prompts/validation.prompt')

// gemini-2.5-flash pricing: $0.30/1M input, $2.50/1M output
const INPUT_COST_PER_TOKEN = 0.30 / 1_000_000
const OUTPUT_COST_PER_TOKEN = 2.50 / 1_000_000

// POST /api/validate/idea
router.post('/idea', async (req, res, next) => {
  try {
    const { prompt } = req.body

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ success: false, error: 'prompt is required', code: 'VALIDATION_ERROR' })
    }
    if (prompt.length < 10) {
      return res.status(400).json({ success: false, error: 'prompt must be at least 10 characters', code: 'VALIDATION_ERROR' })
    }
    if (prompt.length > 2000) {
      return res.status(400).json({ success: false, error: 'prompt must be 2000 characters or fewer', code: 'VALIDATION_ERROR' })
    }

    let result
    try {
      result = await callLLM(VALIDATION_SYSTEM_PROMPT, prompt, {
        step: 'validation',
        maxOutputTokens: 1024,
        temperature: 0.1
      })
    } catch (err) {
      const code = err.code || 'LLM_ERROR'
      const isRateLimit = err.status === 429 || code === 'RATE_LIMIT'
      return res.status(502).json({
        success: false,
        error: isRateLimit ? 'Rate limit reached. Try again later or switch models.' : 'LLM API call failed',
        code: isRateLimit ? 'RATE_LIMIT' : (err.code || 'LLM_ERROR'),
        retry_after_ms: err.retry_after_ms || null,
        ...(process.env.NODE_ENV === 'development' && { details: { message: err.message } })
      })
    }

    const { input, output } = result.meta.tokens_used
    const cost_usd = input * INPUT_COST_PER_TOKEN + output * OUTPUT_COST_PER_TOKEN

    res.status(200).json({
      success: true,
      validation: result.data,
      meta: {
        ...result.meta,
        cost_usd: parseFloat(cost_usd.toFixed(8))
      }
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
