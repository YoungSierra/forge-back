const express = require('express')
const router = express.Router()
const { db } = require('../services/supabase.service')
const { GoogleGenerativeAI } = require('@google/generative-ai')

// POST /api/feedback
router.post('/', async (req, res, next) => {
  try {
    const { member_id, project_id, category, severity, description, url_context, screenshot_url } = req.body

    if (!category || !severity || !description) {
      return res.status(400).json({ success: false, error: 'category, severity and description are required' })
    }

    const { data, error } = await db()
      .from('feedback')
      .insert({ member_id, project_id, category, severity, description, url_context, screenshot_url })
      .select('id, category, severity, status, created_at')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, feedback: data })
  } catch (err) { next(err) }
})

// GET /api/feedback
router.get('/', async (req, res, next) => {
  try {
    const { status, category, severity } = req.query

    let query = db()
      .from('feedback')
      .select('*, members!feedback_member_id_fkey(id, display_name, avatar_url), resolver:members!feedback_resolved_by_fkey(id, display_name), projects(id, name)')
      .order('created_at', { ascending: false })

    if (status)   query = query.eq('status', status)
    if (category) query = query.eq('category', category)
    if (severity) query = query.eq('severity', severity)

    const { data, error } = await query
    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, feedback: data || [] })
  } catch (err) { next(err) }
})

// POST /api/feedback/summary — AI executive summary of open/reviewed feedback
router.post('/summary', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('feedback')
      .select('category, severity, description, status, url_context, created_at')
      .in('status', ['open', 'reviewed'])
      .order('created_at', { ascending: true })

    if (error) return res.status(500).json({ success: false, error: error.message })
    if (!data || data.length === 0) return res.json({ success: true, summary: 'No open or reviewed feedback to summarize.' })

    const lines = data.map((f, i) =>
      `${i + 1}. [${f.category}/${f.severity}/${f.status}] ${f.description}${f.url_context ? ` (${f.url_context})` : ''}`
    ).join('\n')

    const prompt = `You are analyzing user feedback for FORGE, an AI-powered game prototyping platform. Below are ${data.length} open or pending feedback items.\n\nFeedback:\n${lines}\n\nProvide a concise executive summary (3-5 sentences or a short bullet list) covering: most frequent problem areas, critical issues that need immediate attention, and a suggested priority order. Be direct and actionable.`

    const apiKey = process.env.FEEDBACK_SUMMARY_API_KEY
    const model  = process.env.FEEDBACK_SUMMARY_MODEL || 'gemini-2.0-flash'

    if (!apiKey) return res.status(503).json({ success: false, error: 'AI summary not configured (missing FEEDBACK_SUMMARY_API_KEY)' })

    const genAI      = new GoogleGenerativeAI(apiKey)
    const gemini     = genAI.getGenerativeModel({ model, generationConfig: { temperature: 0.4, maxOutputTokens: 1024 } })
    const result     = await gemini.generateContent(prompt)
    const summary    = result.response.text().trim()

    res.json({ success: true, summary, count: data.length })
  } catch (err) { next(err) }
})

// PATCH /api/feedback/:id — update status and resolution note
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const { status, resolution_note, resolved_by } = req.body

    const updates = { status }
    if (resolution_note !== undefined) updates.resolution_note = resolution_note
    if (status === 'resolved') {
      updates.resolved_by = resolved_by || null
      updates.resolved_at = new Date().toISOString()
    }

    const { data, error } = await db()
      .from('feedback')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, feedback: data })
  } catch (err) { next(err) }
})

module.exports = router
