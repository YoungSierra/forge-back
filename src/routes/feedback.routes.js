const express = require('express')
const router = express.Router()
const { db } = require('../services/supabase.service')

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
