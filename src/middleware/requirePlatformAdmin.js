// ─── requirePlatformAdmin · Frente 2 (Multi-Org) ─────────────────────────────────────────────
// Reemplazo de requireAdmin bajo el modelo de 2 ejes: exige ROL DE PLATAFORMA super_admin
// (los dueños de Forge / V57). Distinto del org-admin, que se chequea contra org_members.org_role.
//
// Prefiere req.auth (si ya corrió requireAuth). Fallback temporal al header x-member-id para no
// romper el panel admin durante la transición, y tolera el valor 'admin' viejo además de
// 'super_admin'. Cuando el front mande token y se corra el rename de roles, se quita el fallback.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const { db } = require('../services/supabase.service')

const PLATFORM_ROLES = ['super_admin', 'admin'] // 'admin' tolerado durante la transición

async function requirePlatformAdmin(req, res, next) {
  // Camino nuevo: requireAuth ya resolvió la identidad
  if (req.auth) {
    if (req.auth.isPlatformAdmin) { req.adminMemberId = req.auth.memberId; return next() }
    return res.status(403).json({ success: false, error: 'Forbidden', code: 'FORBIDDEN' })
  }

  // Transición: identidad por header (como el requireAdmin viejo)
  const memberId = req.headers['x-member-id']
  if (!memberId) return res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })

  const { data: member } = await db().from('members').select('id, role').eq('id', memberId).maybeSingle()
  if (!member) return res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
  if (!PLATFORM_ROLES.includes(member.role)) return res.status(403).json({ success: false, error: 'Forbidden', code: 'FORBIDDEN' })

  req.adminMemberId = memberId
  next()
}

module.exports = { requirePlatformAdmin }
