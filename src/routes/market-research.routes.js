const express = require('express')
const router  = express.Router()
const { getPrompt } = require('../services/prompt.service')
const { callLLM }   = require('../services/llm.service')

// POST /api/market-research/comparable-games — paso 1.2.1
// Identifica 5-10 juegos comparables por cada candidate idea (batch)
router.post('/comparable-games', async (req, res, next) => {
  try {
    const { candidates = [], step_key } = req.body

    if (!Array.isArray(candidates) || !candidates.length) {
      return res.status(400).json({ success: false, error: 'candidates array is required' })
    }

    const systemPrompt = await getPrompt('idtn_research_comparable')

    const candidateList = candidates.map(c =>
      `ID: ${c.id} | Concept: ${c.concept}${c.hook ? ' — ' + c.hook : ''}${c.target_audience ? ' | Audience: ' + c.target_audience : ''}`
    ).join('\n')

    const userMessage = `Research comparable published games for each of these ${candidates.length} game concepts.

Candidates:
${candidateList}

Return ONLY valid JSON with a "results" array containing one entry per candidate_id.`

    const { data, meta } = await callLLM(systemPrompt, userMessage, {
      step:            step_key || 'idtn_research_comparable',
      maxOutputTokens: 16000,
      temperature:     0.2,
    })

    const results = Array.isArray(data?.results) ? data.results : []
    if (!results.length) {
      return res.status(500).json({ success: false, error: 'No comparable games results returned by model' })
    }

    const totalComps = results.reduce((n, r) => n + (r.comparables?.length ?? 0), 0)
    console.log(`[market-research comparable] ${results.length} candidates, ${totalComps} total comparables`)
    res.json({ success: true, results, meta: { ...meta, candidates: results.length, comparables: totalComps } })
  } catch (err) {
    next(err)
  }
})

// POST /api/market-research/analyze-gaps — paso 1.2.2
// Analiza gaps y posicionamiento por candidate usando los comparables del paso anterior
router.post('/analyze-gaps', async (req, res, next) => {
  try {
    const { candidates = [], comparables_results = [], step_key } = req.body

    if (!Array.isArray(candidates) || !candidates.length) {
      return res.status(400).json({ success: false, error: 'candidates array is required' })
    }
    if (!Array.isArray(comparables_results) || !comparables_results.length) {
      return res.status(400).json({ success: false, error: 'comparables_results from step 1.2.1 is required' })
    }

    const systemPrompt = await getPrompt('idtn_analyze_gaps')

    const candidateList = candidates.map(c => {
      const comps = comparables_results.find(r => r.candidate_id === c.id)
      const compList = comps?.comparables?.map(g =>
        `  - ${g.title} (${g.developer}, ${g.release_year}) — ${g.genre}, Metacritic: ${g.metacritic_score ?? 'N/A'}, Sentiment: ${g.player_sentiment}`
      ).join('\n') ?? '  (no comparables found)'
      return `Candidate ID: ${c.id}\nConcept: ${c.concept}${c.hook ? '\nHook: ' + c.hook : ''}\nComparables:\n${compList}`
    }).join('\n\n---\n\n')

    const userMessage = `Analyze market gaps and positioning for each of these ${candidates.length} game concepts based on their comparable games.

${candidateList}

Return ONLY valid JSON with a "results" array containing one entry per candidate_id.`

    const { data, meta } = await callLLM(systemPrompt, userMessage, {
      step:            step_key || 'idtn_analyze_gaps',
      maxOutputTokens: 12000,
      temperature:     0.3,
    })

    const results = Array.isArray(data?.results) ? data.results : []
    if (!results.length) {
      return res.status(500).json({ success: false, error: 'No gap analysis results returned by model' })
    }

    console.log(`[market-research gaps] ${results.length} candidates analyzed`)
    res.json({ success: true, results, meta: { ...meta, candidates: results.length } })
  } catch (err) {
    next(err)
  }
})

// POST /api/market-research/size-audience — paso 1.2.3
// Estima el tamaño de audiencia por candidate usando el gap analysis del paso anterior
router.post('/size-audience', async (req, res, next) => {
  try {
    const { candidates = [], gap_results = [], step_key } = req.body

    if (!Array.isArray(candidates) || !candidates.length) {
      return res.status(400).json({ success: false, error: 'candidates array is required' })
    }
    if (!Array.isArray(gap_results) || !gap_results.length) {
      return res.status(400).json({ success: false, error: 'gap_results from step 1.2.2 is required' })
    }

    const systemPrompt = await getPrompt('idtn_size_audience')

    const candidateList = candidates.map(c => {
      const gaps = gap_results.find(r => r.candidate_id === c.id)
      return [
        `Candidate ID: ${c.id}`,
        `Concept: ${c.concept}`,
        c.hook ? `Hook: ${c.hook}` : '',
        c.target_audience ? `Target audience: ${c.target_audience}` : '',
        gaps?.market_gaps?.length ? `Market gaps: ${gaps.market_gaps.join(' | ')}` : '',
        gaps?.underserved_audiences?.length ? `Underserved: ${gaps.underserved_audiences.join(' | ')}` : '',
        gaps?.positioning_statement ? `Positioning: ${gaps.positioning_statement}` : '',
      ].filter(Boolean).join('\n')
    }).join('\n\n---\n\n')

    const userMessage = `Estimate audience size and market opportunity for each of these ${candidates.length} game concepts.

${candidateList}

Return ONLY valid JSON with a "results" array containing one entry per candidate_id.`

    const { data, meta } = await callLLM(systemPrompt, userMessage, {
      step:            step_key || 'idtn_size_audience',
      maxOutputTokens: 10000,
      temperature:     0.2,
    })

    const results = Array.isArray(data?.results) ? data.results : []
    if (!results.length) {
      return res.status(500).json({ success: false, error: 'No audience sizing results returned by model' })
    }

    console.log(`[market-research audience] ${results.length} candidates sized`)
    res.json({ success: true, results, meta: { ...meta, candidates: results.length } })
  } catch (err) {
    next(err)
  }
})

module.exports = router
