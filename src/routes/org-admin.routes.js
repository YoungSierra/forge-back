// ─── Consola org-admin (self-service) · Frente 5 (Multi-Org) ─────────────────────────────────
// Endpoints para que el ADMIN DE UNA ORG gestione LO SUYO: sus usuarios, sus blueprints propios,
// y ver su consumo/crédito. Todo scopeado a req.auth.activeOrgId. Montado con requireAuth +
// requireOrgAdmin. El ledger/credit NO exponen el costo real ni el margen (solo lo cobrado).
// ─────────────────────────────────────────────────────────────────────────────────────────────
const express = require('express')
const router = express.Router()
const { db, getClient } = require('../services/supabase.service')
const { getStatus } = require('../services/credits.service')
const { createCheckout } = require('../services/payments.service')

// ── Miembros de MI org (5.4) ──
router.get('/members', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { data: oms } = await db().from('org_members')
      .select('id, org_role, joined_at, member_id, credit_cap_usd, credit_cap_period, members(id, display_name, auth_user_id)')
      .eq('org_id', orgId)
    const { data: authData } = await getClient().auth.admin.listUsers({ perPage: 1000 })
    const emailById = Object.fromEntries((authData?.users || []).map(u => [u.id, u.email]))
    // Gasto por miembro en su propio período (para mostrar consumo vs tope)
    const members = await Promise.all((oms || []).map(async o => {
      const period = o.credit_cap_period || 'monthly'
      const { data: spend } = await db().rpc('member_spend', { p_org: orgId, p_member: o.member_id, p_period: period })
      return {
        org_member_id: o.id, member_id: o.member_id, org_role: o.org_role, joined_at: o.joined_at,
        display_name: o.members?.display_name, email: emailById[o.members?.auth_user_id] || null,
        credit_cap_usd: o.credit_cap_usd, credit_cap_period: period, spent: Number(spend || 0),
      }
    }))
    res.json({ success: true, members })
  } catch (err) { next(err) }
})

// crear usuario en MI org
router.post('/members', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { email, password, display_name, org_role = 'member' } = req.body
    if (!email || !password || !display_name) return res.status(400).json({ success: false, error: 'email, password and display_name are required' })
    if (!['admin', 'member', 'viewer'].includes(org_role)) return res.status(400).json({ success: false, error: 'invalid org_role' })

    const { data: authData, error: authError } = await getClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name } })
    if (authError) return res.status(400).json({ success: false, error: authError.message })
    const authUserId = authData.user.id
    await db().from('members').update({ display_name }).eq('auth_user_id', authUserId)
    const { data: member } = await db().from('members').select('id').eq('auth_user_id', authUserId).single()
    const { error: omErr } = await db().from('org_members').insert({ org_id: orgId, member_id: member.id, org_role })
    if (omErr) return res.status(400).json({ success: false, error: omErr.message })
    res.json({ success: true, member: { member_id: member.id, email, org_role } })
  } catch (err) { next(err) }
})

// invitar usuario a MI org por correo (mismo flujo /auth/accept que el super-admin)
router.post('/members/invite', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { email, org_role = 'member' } = req.body
    if (!email) return res.status(400).json({ success: false, error: 'email is required' })
    if (!['admin', 'member', 'viewer'].includes(org_role)) return res.status(400).json({ success: false, error: 'invalid org_role' })

    const client = getClient()
    const redirectTo = `${process.env.FRONTEND_URL}/auth/accept`
    const { data: authData, error: authError } = await client.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { pending_org_role: org_role, pending_org_id: orgId },
    })
    if (authError) return res.status(400).json({ success: false, error: authError.message })

    // El trigger crea la fila en members; la buscamos para linkearla a la org.
    const authUserId = authData.user.id
    const { data: member } = await db().from('members').select('id').eq('auth_user_id', authUserId).maybeSingle()
    if (!member) return res.status(500).json({ success: false, error: 'member row not created yet, retry' })

    const { error: omErr } = await db().from('org_members').insert({ org_id: orgId, member_id: member.id, org_role })
    if (omErr) return res.status(400).json({ success: false, error: omErr.message })
    res.json({ success: true, invited: true, member: { member_id: member.id, email, org_role } })
  } catch (err) { next(err) }
})

// cambiar rol y/o sub-tope de crédito de un miembro de MI org
router.patch('/members/:memberId', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { memberId } = req.params
    const { org_role, credit_cap_usd, credit_cap_period } = req.body
    const updates = {}
    if (org_role !== undefined) {
      if (!['owner', 'admin', 'member', 'viewer'].includes(org_role)) return res.status(400).json({ success: false, error: 'invalid org_role' })
      updates.org_role = org_role
    }
    if (credit_cap_usd !== undefined) {  // '' o null -> quitar el tope
      updates.credit_cap_usd = (credit_cap_usd === '' || credit_cap_usd === null) ? null : Number(credit_cap_usd)
      if (updates.credit_cap_usd != null && !(updates.credit_cap_usd >= 0)) return res.status(400).json({ success: false, error: 'credit_cap_usd must be >= 0' })
    }
    if (credit_cap_period !== undefined) {
      if (!['monthly', 'total'].includes(credit_cap_period)) return res.status(400).json({ success: false, error: 'invalid credit_cap_period' })
      updates.credit_cap_period = credit_cap_period
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, error: 'nothing to update' })
    const { data, error } = await db().from('org_members').update(updates).eq('org_id', orgId).eq('member_id', memberId).select('id, org_role, credit_cap_usd, credit_cap_period').single()
    if (error) return res.status(400).json({ success: false, error: error.message })
    res.json({ success: true, org_member: data })
  } catch (err) { next(err) }
})

// ── Proyectos de MI org + sub-topes de crédito (con búsqueda por nombre + paginación) ──
// El gasto por proyecto se calcula SOLO para la página visible (evita N llamadas en orgs grandes).
router.get('/projects', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const search = String(req.query.search || '').trim()
    const page = Math.max(0, parseInt(req.query.page, 10) || 0)
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 10))
    let q = db().from('projects')
      .select('id, name, credit_cap_usd, credit_cap_period, created_at', { count: 'exact' })
      .eq('org_id', orgId)
    if (search) q = q.ilike('name', `%${search}%`)
    const { data, count, error } = await q
      .order('created_at', { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1)
    if (error) return res.status(500).json({ success: false, error: error.message })
    const projects = await Promise.all((data || []).map(async p => {
      const period = p.credit_cap_period || 'monthly'
      const { data: spend } = await db().rpc('project_spend', { p_project: p.id, p_period: period })
      return { ...p, credit_cap_period: period, spent: Number(spend || 0) }
    }))
    res.json({ success: true, projects, total: count ?? 0, page, pageSize })
  } catch (err) { next(err) }
})

router.patch('/projects/:id', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { data: proj } = await db().from('projects').select('org_id').eq('id', req.params.id).maybeSingle()
    if (!proj) return res.status(404).json({ success: false, error: 'Project not found' })
    if (proj.org_id !== orgId) return res.status(403).json({ success: false, error: 'Not your organization project' })
    const { credit_cap_usd, credit_cap_period } = req.body
    const updates = {}
    if (credit_cap_usd !== undefined) {
      updates.credit_cap_usd = (credit_cap_usd === '' || credit_cap_usd === null) ? null : Number(credit_cap_usd)
      if (updates.credit_cap_usd != null && !(updates.credit_cap_usd >= 0)) return res.status(400).json({ success: false, error: 'credit_cap_usd must be >= 0' })
    }
    if (credit_cap_period !== undefined) {
      if (!['monthly', 'total'].includes(credit_cap_period)) return res.status(400).json({ success: false, error: 'invalid credit_cap_period' })
      updates.credit_cap_period = credit_cap_period
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, error: 'nothing to update' })
    const { data, error } = await db().from('projects').update(updates).eq('id', req.params.id).select('id, credit_cap_usd, credit_cap_period').single()
    if (error) return res.status(400).json({ success: false, error: error.message })
    res.json({ success: true, project: data })
  } catch (err) { next(err) }
})

// quitar un miembro de MI org (no borra la cuenta, solo la membresía)
router.delete('/members/:memberId', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { memberId } = req.params
    if (memberId === req.auth.memberId) return res.status(400).json({ success: false, error: "You can't remove yourself" })
    const { error } = await db().from('org_members').delete().eq('org_id', orgId).eq('member_id', memberId)
    if (error) return res.status(400).json({ success: false, error: error.message })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// ── Crédito / consumo de MI org (5.6) — OCULTA costo real y margen ──
router.get('/credit', async (req, res, next) => {
  try {
    const status = await getStatus(req.auth.activeOrgId)
    res.json({ success: true, ...status })
  } catch (err) { next(err) }
})

router.get('/ledger', async (req, res, next) => {
  try {
    // Solo campos de cara a la org: NO raw_cost_usd, NO margin_multiplier
    const { data, error } = await db().from('credit_transactions')
      .select('id, type, amount_usd, balance_after, created_at')
      .eq('org_id', req.auth.activeOrgId).order('created_at', { ascending: false }).limit(200)
    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, transactions: data || [] })
  } catch (err) { next(err) }
})

// Comprar créditos vía pasarela (Stripe). Crea la sesión y devuelve la URL para redirigir.
// Los créditos se acreditan cuando llega el webhook confirmado (no acá) -> nunca se regalan.
router.post('/credits/checkout', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { amount_usd } = req.body
    if (!amount_usd || Number(amount_usd) <= 0) return res.status(400).json({ success: false, error: 'amount_usd must be > 0' })
    const { data: org } = await db().from('organizations').select('name, billing_email').eq('id', orgId).maybeSingle()
    const front = process.env.FRONTEND_URL || 'http://localhost:3000'
    const r = await createCheckout({
      orgId, orgName: org?.name || 'Organization', amountUsd: Number(amount_usd),
      customerEmail: org?.billing_email || undefined,
      successUrl: `${front}/org?paid=1`, cancelUrl: `${front}/org?canceled=1`,
    })
    res.json({ success: true, url: r.url })
  } catch (err) { next(err) }
})

// ── Catálogo de nodos ESTÁNDAR (activos) para componer blueprints propios ──
router.get('/nodes', async (req, res, next) => {
  try {
    const { data, error } = await db().from('forge_nodes')
      .select('id, node_key, title, phase, executor')
      .eq('status', 'active')
      .order('node_key')
    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, nodes: data || [] })
  } catch (err) { next(err) }
})

// ── Blueprints: estándar (solo lectura) + propios de MI org (5.5) ──
router.get('/blueprints', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { data, error } = await db().from('forge_blueprints')
      .select('id, blueprint_key, name, phase, description, is_default, node_sequence, edges, gate, org_id, updated_at')
      .or(`org_id.is.null,org_id.eq.${orgId}`)
      .order('phase')
    if (error) return res.status(500).json({ success: false, error: error.message })
    const blueprints = (data || []).map(b => ({ ...b, standard: b.org_id === null, editable: b.org_id === orgId }))
    res.json({ success: true, blueprints })
  } catch (err) { next(err) }
})

router.post('/blueprints', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { blueprint_key, name, phase, description, node_sequence = [], edges = [], gate = {} } = req.body
    if (!blueprint_key || !name || !phase) return res.status(400).json({ success: false, error: 'blueprint_key, name and phase are required' })
    const { data, error } = await db().from('forge_blueprints')
      .insert({ blueprint_key, name, phase, description, node_sequence, edges, gate, org_id: orgId, created_by: req.auth.memberId })
      .select('*').single()
    if (error) return res.status(400).json({ success: false, error: error.message + ' (blueprint keys must be unique for now)' })
    res.json({ success: true, blueprint: data })
  } catch (err) { next(err) }
})

// editar/borrar: solo los SUYOS (no estándar ni de otra org)
async function ownBlueprintGuard(req, res) {
  const { data: bp } = await db().from('forge_blueprints').select('org_id').eq('id', req.params.id).maybeSingle()
  if (!bp) { res.status(404).json({ success: false, error: 'Blueprint not found' }); return null }
  if (bp.org_id !== req.auth.activeOrgId) { res.status(403).json({ success: false, error: "Can't modify a standard blueprint or one from another org", code: 'READONLY' }); return null }
  return bp
}

router.patch('/blueprints/:id', async (req, res, next) => {
  try {
    if (!(await ownBlueprintGuard(req, res))) return
    const allowed = ['name', 'phase', 'description', 'node_sequence', 'edges', 'gate']
    const updates = {}; for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k]
    updates.updated_at = new Date().toISOString()
    const { data, error } = await db().from('forge_blueprints').update(updates).eq('id', req.params.id).select('*').single()
    if (error) return res.status(400).json({ success: false, error: error.message })
    res.json({ success: true, blueprint: data })
  } catch (err) { next(err) }
})

router.delete('/blueprints/:id', async (req, res, next) => {
  try {
    if (!(await ownBlueprintGuard(req, res))) return
    await db().from('forge_blueprints').delete().eq('id', req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
