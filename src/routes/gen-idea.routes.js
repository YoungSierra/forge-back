const express  = require('express')
const router   = express.Router()
const { getPrompt }            = require('../services/prompt.service')
const { callLLM }              = require('../services/llm.service')
const { generateImageForNode } = require('../services/image.service')

async function generateIdeaImage(prompt, index) {
  const storagePath = `gen-ideas/${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}.png`
  const result = await generateImageForNode('gen_idea', prompt, 1024, 576, storagePath)
  return result.skipped ? null : (result.url ?? null)
}

// POST /api/gen-idea
router.post('/', async (req, res, next) => {
  try {
    const { prompt = '', genre = '', tone = '', scope = '', engine = '', count = 7, exclude = [] } = req.body

    if (!prompt.trim()) {
      return res.status(400).json({ success: false, error: 'prompt is required' })
    }

    const systemPrompt = await getPrompt('gen_idea')

    const contextLines = [
      `Concept: ${prompt.trim()}`,
      genre  && `Genre preferences: ${genre}`,
      tone   && `Tone preferences: ${tone}`,
      scope  && `Scope: ${scope}`,
      engine && `Target engine: ${engine}`,
      exclude.length && `Already generated — do NOT repeat these titles: ${exclude.join(', ')}`,
    ].filter(Boolean).join('\n')

    const userMessage = `Generate ${count} unique and diverse game ideas based on the following input.

${contextLines}

Return ONLY valid JSON — no markdown fences, no extra text — with this exact structure:
{
  "ideas": [
    {
      "title": "catchy game title",
      "elevator_pitch": "1-2 powerful sentences that sell the game",
      "genre": "primary genre",
      "tone": "emotional tone",
      "core_mechanic": "central gameplay mechanic in 1 sentence",
      "unique_hook": "what makes it stand out from any competitor",
      "visual_style": "art direction in 1-2 sentences",
      "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
      "image_prompt": "Ultra detailed AAA gameplay screenshot — follow the VISUAL PREVIEW PROMPT rules from your system instructions exactly. Written in English, optimized for image generation, depicts real gameplay in action."
    }
  ]
}

Critical rules:
- Each idea must differ completely in genre, setting, mechanics, and visual style
- No generic ideas — every concept must feel marketable and memorable
- The image_prompt must vividly reflect each idea's unique gameplay and visual world`

    const startTime = Date.now()

    const { data, meta } = await callLLM(systemPrompt, userMessage, {
      step:            'gen_idea',
      maxOutputTokens: 16000,
      temperature:     0.9,
    })

    let ideas = []
    try {
      ideas = Array.isArray(data?.ideas) ? data.ideas : []
    } catch {
      return res.status(500).json({ success: false, error: 'Failed to parse LLM response' })
    }

    if (!ideas.length) {
      return res.status(500).json({ success: false, error: 'No ideas returned by model' })
    }

    // Generar imágenes en paralelo con fal.ai flux/schnell (sin filtros de contenido)
    const ideasWithImages = await Promise.all(
      ideas.map(async (idea, index) => {
        try {
          const image_url = await generateIdeaImage(idea.image_prompt, index)
          return { ...idea, image_url }
        } catch (e) {
          console.warn(`[gen-idea] Image generation failed for "${idea.title}": ${e.message}`)
          return { ...idea, image_url: null }
        }
      })
    )

    res.json({
      success: true,
      ideas:   ideasWithImages,
      meta: {
        ...meta,
        duration_ms: Date.now() - startTime,
        count:       ideasWithImages.length,
      },
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
