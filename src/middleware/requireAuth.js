// ─── requireAuth · Frente 2 (Multi-Org) ──────────────────────────────────────────────────────
// Valida el JWT de Supabase (header Authorization: Bearer <token>), resuelve el member de
// plataforma y sus organizaciones, y fija la organización activa (header X-Org-Id). Deja todo
// en req.auth. Reemplaza la identidad spoofeable actual (auth_user_id en la URL / x-member-id).
//
// NO cambia nada hasta que se MONTE en los routers (Frente 2.4) y el front mande el token
// (Frente 2.9). Se entrega como archivo para revisión.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const { getClient, db } = require('../services/supabase.service')

// Cache token -> identidad resuelta (member + orgs), TTL corto. Evita golpear Supabase Auth y la BD
// en cada request (el canvas hace muchas). Se invalida solo por TTL; los cambios de rol/org tardan
// hasta CACHE_TTL_MS en reflejarse, lo cual es aceptable.
const _cache = new Map() // token -> { exp, identity }
const CACHE_TTL_MS = 30_000

async function resolveIdentity(token) {
  const hit = _cache.get(token)
  if (hit && hit.exp > Date.now()) return hit.identity

  const { data: { user } = {}, error: authErr } = await getClient().auth.getUser(token)
  if (authErr || !user) return null

  const { data: member } = await db()
    .from('members').select('id, role, display_name').eq('auth_user_id', user.id).maybeSingle()
  if (!member) return { noMember: true }

  const { data: orgRows } = await db().from('org_members').select('org_id, org_role').eq('member_id', member.id)
  const identity = {
    authUserId: user.id,
    memberId: member.id,
    displayName: member.display_name,
    platformRole: member.role,
    isPlatformAdmin: member.role === 'super_admin' || member.role === 'admin', // 'admin' tolerado en transición
    orgs: orgRows || [],
  }
  _cache.set(token, { exp: Date.now() + CACHE_TTL_MS, identity })
  return identity
}

async function requireAuth(req, res, next) {
  try {
    const authz = req.headers['authorization'] || ''
    const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : null
    if (!token) return res.status(401).json({ success: false, error: 'Not authenticated', code: 'NO_TOKEN' })

    const identity = await resolveIdentity(token)
    if (!identity) return res.status(401).json({ success: false, error: 'Invalid token', code: 'BAD_TOKEN' })
    if (identity.noMember) return res.status(401).json({ success: false, error: 'Member not found', code: 'NO_MEMBER' })

    const { isPlatformAdmin, orgs } = identity

    // Organización activa: header X-Org-Id. Debe pertenecer al member (el super-admin puede operar
    // sobre cualquier org). Si el member tiene una sola org y no mandan header, se usa esa.
    const requested = req.headers['x-org-id'] || null
    let activeOrgId = null, activeOrgRole = null
    if (requested) {
      const m = orgs.find(o => o.org_id === requested)
      if (m) { activeOrgId = m.org_id; activeOrgRole = m.org_role }
      else if (isPlatformAdmin) { activeOrgId = requested; activeOrgRole = 'platform' }
      else return res.status(403).json({ success: false, error: 'Not a member of that organization', code: 'ORG_FORBIDDEN' })
    } else if (orgs.length === 1) {
      activeOrgId = orgs[0].org_id; activeOrgRole = orgs[0].org_role
    }

    req.auth = {
      authUserId:    identity.authUserId,
      memberId:      identity.memberId,
      displayName:   identity.displayName,
      platformRole:  identity.platformRole,
      isPlatformAdmin,
      orgs,
      activeOrgId,
      activeOrgRole,
      token, // JWT crudo — para dbAsUser (lecturas con RLS, Frente 3 etapa 2)
    }
    next()
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Auth error', code: 'AUTH_ERROR' })
  }
}

module.exports = { requireAuth }
