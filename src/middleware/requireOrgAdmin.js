// ─── requireOrgAdmin · Frente 5 (Multi-Org) ──────────────────────────────────────────────────
// Exige que el usuario sea ADMIN (u owner) de su organización ACTIVA. Se usa DESPUÉS de requireAuth
// (que deja req.auth con activeOrgRole). El super-admin de plataforma también pasa.
// ─────────────────────────────────────────────────────────────────────────────────────────────
function requireOrgAdmin(req, res, next) {
  const a = req.auth
  if (!a) return res.status(401).json({ success: false, error: 'Not authenticated', code: 'NO_AUTH' })
  if (a.isPlatformAdmin) return next()
  if (!a.activeOrgId) return res.status(400).json({ success: false, error: 'No active organization', code: 'NO_ORG' })
  if (a.activeOrgRole === 'admin' || a.activeOrgRole === 'owner') return next()
  return res.status(403).json({ success: false, error: 'Organization admin required', code: 'ORG_ADMIN_REQUIRED' })
}

module.exports = { requireOrgAdmin }
