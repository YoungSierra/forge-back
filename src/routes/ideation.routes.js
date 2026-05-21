const express = require('express')
const router  = express.Router()
const { getPrompt }            = require('../services/prompt.service')
const { callLLM }              = require('../services/llm.service')
const { generateImageForNode } = require('../services/image.service')

// POST /api/ideation/generate-variations — paso 1.1.1
// Genera N one-liners de conceptos de juego desde un brief creativo
router.post('/generate-variations', async (req, res, next) => {
  try {
    const { brief = '', genres = [], count = 20, step_key } = req.body

    if (!brief.trim()) {
      return res.status(400).json({ success: false, error: 'brief is required' })
    }

    const safeCount = Math.min(Math.max(Number(count) || 20, 10), 50)
    const systemPrompt = await getPrompt('idtn_generate_concepts')

    const userMessage = `Generate exactly ${safeCount} unique game concept one-liners.

Creative brief: ${brief.trim()}
${genres.length ? `Genre preferences: ${genres.join(', ')}` : ''}

Each concept must be a single punchy sentence (max 25 words). IDs must go from "1" to "${safeCount}".

Return ONLY valid JSON:
{
  "variations": [
    { "id": "1", "concept": "..." },
    ...
  ]
}`

    const { data, meta } = await callLLM(systemPrompt, userMessage, {
      step:            step_key || 'idtn_generate_concepts',
      maxOutputTokens: 8000,
      temperature:     0.95,
    })

    const variations = Array.isArray(data?.variations) ? data.variations : []
    if (!variations.length) {
      return res.status(500).json({ success: false, error: 'No variations returned by model' })
    }

    console.log(`[ideation generate] ${variations.length} concepts ← brief:"${brief.slice(0, 60)}"`)
    res.json({ success: true, variations, meta: { ...meta, count: variations.length } })
  } catch (err) {
    next(err)
  }
})

// POST /api/ideation/score-rank — paso 1.1.2
// Evalúa y ordena los conceptos por originality, market_fit, team_alignment, feasibility
router.post('/score-rank', async (req, res, next) => {
  try {
    const { variations = [], brief = '', genres = [], step_key } = req.body

    if (!Array.isArray(variations) || !variations.length) {
      return res.status(400).json({ success: false, error: 'variations array is required' })
    }

    const systemPrompt = await getPrompt('idtn_score_rank')

    const conceptList = variations.map(v => `${v.id}. ${v.concept}`).join('\n')
    const userMessage = `Score and rank these ${variations.length} game concepts.

Creative brief context: ${brief.trim() || 'Not specified'}
${genres.length ? `Genre preferences: ${genres.join(', ')}` : ''}

Concepts to evaluate:
${conceptList}

Return ONLY valid JSON with all ${variations.length} concepts scored and sorted by total descending.`

    const { data, meta } = await callLLM(systemPrompt, userMessage, {
      step:            step_key || 'idtn_score_rank',
      maxOutputTokens: 12000,
      temperature:     0.3,
    })

    const scored = Array.isArray(data?.scored) ? data.scored : []
    if (!scored.length) {
      return res.status(500).json({ success: false, error: 'No scored results returned by model' })
    }

    console.log(`[ideation score] ${scored.length} concepts ranked, top score: ${scored[0]?.total}`)
    res.json({ success: true, scored, meta: { ...meta, count: scored.length } })
  } catch (err) {
    next(err)
  }
})

// POST /api/ideation/surface-candidates — paso 1.1.3
// Genera rationale, hook y target_audience para los top N conceptos
router.post('/surface-candidates', async (req, res, next) => {
  try {
    const { scored = [], count_top = 8, step_key } = req.body

    if (!Array.isArray(scored) || !scored.length) {
      return res.status(400).json({ success: false, error: 'scored array is required' })
    }

    const safeTop  = Math.min(Math.max(Number(count_top) || 8, 3), 15)
    const top      = scored.slice(0, safeTop)
    const systemPrompt = await getPrompt('idtn_surface_candidates')

    const conceptList = top.map(v => `ID: ${v.id} | Score: ${v.total} | Concept: ${v.concept}`).join('\n')
    const userMessage = `Surface and package these top ${top.length} game concepts as a creative shortlist.

Concepts (sorted by score, highest first):
${conceptList}

For each concept write rationale, hook, and target_audience.
Return ONLY valid JSON with exactly ${top.length} candidates.`

    const { data, meta } = await callLLM(systemPrompt, userMessage, {
      step:            step_key || 'idtn_surface_candidates',
      maxOutputTokens: 8000,
      temperature:     0.5,
    })

    const candidates = Array.isArray(data?.candidates) ? data.candidates : []
    if (!candidates.length) {
      return res.status(500).json({ success: false, error: 'No candidates returned by model' })
    }

    console.log(`[ideation surface] ${candidates.length} candidates surfaced`)
    res.json({ success: true, candidates, meta: { ...meta, count: candidates.length } })
  } catch (err) {
    next(err)
  }
})

// POST /api/ideation/generate-candidate-images
// Genera una imagen de referencia por candidato usando el workflow configurado en idtn_surface_candidates
router.post('/generate-candidate-images', async (req, res, next) => {
  try {
    const { candidates = [], project_id, step_key } = req.body

    if (!Array.isArray(candidates) || !candidates.length) {
      return res.status(400).json({ success: false, error: 'candidates array is required' })
    }
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required' })
    }

    const nodeKey = step_key || 'idtn_surface_candidates'

    const images = await Promise.all(
      candidates.map(async c => {
        const prompt      = `${c.concept}${c.hook ? '. ' + c.hook : ''}`.trim()
        const storagePath = `projects/${project_id}/pipeline/idtn_surface_candidates/${c.id}.png`
        try {
          const r = await generateImageForNode(nodeKey, prompt, 512, 512, storagePath)
          return { id: c.id, image_url: r?.url ?? null }
        } catch (err) {
          console.warn(`[ideation images] failed for candidate ${c.id}: ${err.message}`)
          return { id: c.id, image_url: null }
        }
      })
    )

    const generated = images.filter(i => i.image_url).length
    console.log(`[ideation images] ${generated}/${images.length} generated for project ${project_id}`)
    res.json({ success: true, images })
  } catch (err) {
    next(err)
  }
})

module.exports = router
