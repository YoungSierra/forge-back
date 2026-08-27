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
// 30 s obligaba a revalidar contra Supabase Auth constantemente. En el plan FREE ese servidor
// tiene 10 conexiones y mata toda petición a los 10 s, así que cada revalidación competía por un
// recurso escaso — y cuando no contestaba, el back respondía «Invalid token» sobre un token
// perfectamente válido. El token de Supabase dura una hora; revalidar cada 5 minutos sigue
// acotando cuánto tarda en reflejarse un cambio de rol, con una fracción del tráfico.
const CACHE_TTL_MS = 5 * 60_000
// Medido el 27-08 contra el proyecto: Auth contesta, pero mal — 1 de 4 llamadas volvió en 2,8 s y
// 3 pasaron de 8 s. Con 4 s de presupuesto casi ninguna llegaba, y en un back recién reiniciado no
// hay identidad previa de la que echar mano, así que TODO se rechazaba. El propio servidor de Auth
// corta a los 10 s, así que esperar 9 no alarga nada: solo deja de tirar la respuesta que venía.
const AUTH_TIMEOUT_MS = 9_000
const REINTENTOS = 2

// Última identidad conocida por token, sin vencimiento. Es la red de seguridad para cuando Auth
// no contesta: se prefiere seguir sirviendo a quien YA se validó antes que negarle el paso por un
// problema de infraestructura. Acotado para no crecer sin límite.
const _ultima = new Map() // token -> identity
const MAX_ULTIMA = 500

// El vencimiento del propio JWT, leído sin red. Un token vencido se rechaza acá mismo y ni
// siquiera se le pregunta a Auth.
function vencido(token) {
  try {
    const p = token.split('.')[1]
    if (!p) return false
    const json = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return typeof json.exp === 'number' && json.exp * 1000 <= Date.now()
  } catch { return false }
}

async function resolveIdentity(token) {
  const hit = _cache.get(token)
  if (hit && hit.exp > Date.now()) return hit.identity
  if (vencido(token)) return null

  // Se reintenta porque el fallo es intermitente por saturación, no por el token: la misma
  // llamada que se pasa de tiempo vuelve bien al segundo intento.
  let user = null, authErr = null
  for (let intento = 1; intento <= REINTENTOS && !user; intento++) {
    try {
      const r = await Promise.race([
        getClient().auth.getUser(token),
        new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('auth-timeout')), AUTH_TIMEOUT_MS)),
      ])
      user = r?.data?.user ?? null
      authErr = r?.error ?? null
      // Un token que Auth rechaza de verdad no mejora reintentando.
      if (authErr) break
    } catch (e) {
      authErr = e
      if (intento < REINTENTOS) console.warn(`[requireAuth] Auth no respondió en ${AUTH_TIMEOUT_MS} ms, reintentando`)
    }
  }

  if (authErr || !user) {
    // Auth no pudo responder. Si a este token ya se lo validó antes, se sigue confiando en él: su
    // vencimiento se comprobó arriba sin red, y negarle el paso a alguien logueado porque el
    // servidor de auth está saturado es peor que servirle con la identidad que ya conocíamos.
    const previa = _ultima.get(token)
    if (previa) {
      console.warn('[requireAuth] Auth no respondió; se usa la identidad ya conocida de este token')
      _cache.set(token, { exp: Date.now() + CACHE_TTL_MS, identity: previa })
      return previa
    }
    return null
  }

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
  if (_ultima.size >= MAX_ULTIMA) _ultima.delete(_ultima.keys().next().value)
  _ultima.set(token, identity)
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
