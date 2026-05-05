const { db } = require('../services/supabase.service')

async function requireAdmin(req, res, next) {
  const memberId = req.headers['x-member-id']

  if (!memberId) {
    return res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
  }

  const { data: member, error } = await db()
    .from('members')
    .select('id, role')
    .eq('id', memberId)
    .single()

  if (error || !member) {
    return res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
  }

  if (member.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden', code: 'FORBIDDEN' })
  }

  req.adminMemberId = memberId
  next()
}

module.exports = { requireAdmin }
