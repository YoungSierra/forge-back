const express = require('express')
const router  = express.Router()
const { getPrompt }  = require('../services/prompt.service')
const { callLLM }    = require('../services/llm.service')

// POST /api/chat/node — conversación multi-turno sobre el output de un nodo
router.post('/node', async (req, res, next) => {
  try {
    const { step_key, messages = [], user_message, current_output, apply_mode } = req.body

    if (!step_key || !user_message?.trim()) {
      return res.status(400).json({ success: false, error: 'step_key and user_message are required' })
    }

    const basePrompt = await getPrompt(step_key)

    // apply_mode: el LLM debe devolver solo JSON puro con la lista actualizada
    const systemPrompt = apply_mode
      ? [
          basePrompt,
          '',
          'Return ONLY the updated array as raw JSON. No markdown fences, no explanations, no other text.',
          'The output must be a valid JSON array parseable with JSON.parse().',
          'Preserve the same object structure as the current step output.',
        ].filter(s => s !== undefined).join('\n')
      : [
          basePrompt,
          '',
          'You are also acting as a conversational assistant called Forge Assistant.',
          'The user is reviewing the output of this step and wants to discuss or refine it.',
          'Be concise, direct, and focused on game development context.',
          'When the user asks for changes, explain clearly what you would adjust and why.',
          'Do NOT return JSON unless explicitly asked — respond in plain, conversational text.',
        ].filter(s => s !== undefined).join('\n')

    // Construir contexto: output actual + historial + nuevo mensaje
    const outputSummary = JSON.stringify(current_output, null, 2).slice(0, 3000)

    const historyLines = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')

    const userMsg = [
      `Current step output:\n${outputSummary}`,
      historyLines ? `\nPrevious conversation:\n${historyLines}` : '',
      `\nUser: ${user_message.trim()}`,
    ].filter(Boolean).join('\n')

    const { data, meta } = await callLLM(systemPrompt, userMsg, {
      step:            step_key,
      rawText:         true,
      temperature:     apply_mode ? 0.2 : 0.7,
      maxOutputTokens: apply_mode ? 4096 : 2048,
    })

    const reply = typeof data === 'string' ? data : JSON.stringify(data)
    console.log(`[chat/node] step="${step_key}" reply: ${reply.slice(0, 80)}…`)
    res.json({ success: true, reply, meta })
  } catch (err) {
    next(err)
  }
})

module.exports = router
