const express = require('express')
const router = express.Router()
const { db } = require('../services/supabase.service')

// GET /api/members/search?q=query
router.get('/search', async (req, res, next) => {
  try {
    const { q = '' } = req.query
    const { data, error } = await db()
      .from('members')
      .select('id, display_name, avatar_url, role')
      .ilike('display_name', `%${q}%`)
      .limit(20)

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, members: data || [] })
  } catch (err) {
    next(err)
  }
})

// GET /api/members/by-auth/:auth_user_id — resolve member_id from auth user
router.get('/by-auth/:auth_user_id', async (req, res, next) => {
  try {
    const { auth_user_id } = req.params
    const { data, error } = await db()
      .from('members')
      .select('id, display_name, avatar_url, role')
      .eq('auth_user_id', auth_user_id)
      .single()

    if (error || !data) return res.status(404).json({ success: false, error: 'Member not found' })
    res.json({ success: true, member: data })
  } catch (err) {
    next(err)
  }
})

module.exports = router
