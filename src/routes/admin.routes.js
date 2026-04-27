const express = require('express')
const router = express.Router()
const { db, getClient } = require('../services/supabase.service')

// GET /api/admin/users
router.get('/users', async (req, res, next) => {
  try {
    const client = getClient()
    const [{ data: authData, error: authError }, { data: members, error: membersError }] = await Promise.all([
      client.auth.admin.listUsers({ perPage: 1000 }),
      db().from('members').select('id, auth_user_id, display_name, role, created_at'),
    ])

    if (authError)    return res.status(500).json({ success: false, error: authError.message })
    if (membersError) return res.status(500).json({ success: false, error: membersError.message })

    const membersByAuthId = Object.fromEntries((members || []).map(m => [m.auth_user_id, m]))

    const users = (authData?.users || []).map(u => ({
      auth_id:      u.id,
      email:        u.email,
      created_at:   u.created_at,
      last_sign_in: u.last_sign_in_at,
      ...membersByAuthId[u.id],
    }))

    res.json({ success: true, users })
  } catch (err) { next(err) }
})

// POST /api/admin/users
router.post('/users', async (req, res, next) => {
  try {
    const { email, password, display_name, role = 'member' } = req.body

    if (!email || !password || !display_name) {
      return res.status(400).json({ success: false, error: 'email, password and display_name are required' })
    }

    const client = getClient()

    const { data: authData, error: authError } = await client.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name },
    })

    if (authError) return res.status(400).json({ success: false, error: authError.message })

    const authUserId = authData.user.id

    const updates = { display_name }
    if (role === 'admin') updates.role = 'admin'

    const { error: updateError } = await db()
      .from('members')
      .update(updates)
      .eq('auth_user_id', authUserId)

    if (updateError) return res.status(500).json({ success: false, error: updateError.message })

    const { data: member } = await db()
      .from('members')
      .select('*')
      .eq('auth_user_id', authUserId)
      .single()

    res.json({ success: true, user: { auth_id: authUserId, email, ...member } })
  } catch (err) { next(err) }
})

// POST /api/admin/users/invite — send invite email
router.post('/users/invite', async (req, res, next) => {
  try {
    const { email, role = 'member' } = req.body
    if (!email) return res.status(400).json({ success: false, error: 'email is required' })

    const client = getClient()
    const redirectTo = `${process.env.FRONTEND_URL}/auth/accept`

    const { data: authData, error: authError } = await client.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { pending_role: role },
    })

    if (authError) return res.status(400).json({ success: false, error: authError.message })

    const authUserId = authData.user.id

    // Set role if admin — trigger may have already created the member row
    if (role === 'admin') {
      await db().from('members').update({ role: 'admin' }).eq('auth_user_id', authUserId)
    }

    res.json({ success: true, user: { auth_id: authUserId, email, role } })
  } catch (err) { next(err) }
})

// PATCH /api/admin/users/:auth_id — update display_name and/or role
router.patch('/users/:auth_id', async (req, res, next) => {
  try {
    const { auth_id } = req.params
    const { display_name, role } = req.body

    const updates = {}
    if (display_name !== undefined) updates.display_name = display_name
    if (role !== undefined) updates.role = role

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'Nothing to update' })
    }

    const { data, error } = await db()
      .from('members')
      .update(updates)
      .eq('auth_user_id', auth_id)
      .select('id, auth_user_id, display_name, role, created_at')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, member: data })
  } catch (err) { next(err) }
})

module.exports = router
