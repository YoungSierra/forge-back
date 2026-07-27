// ─── Consola org-admin (self-service) · Frente 5 (Multi-Org) ─────────────────────────────────
// Endpoints para que el ADMIN DE UNA ORG gestione LO SUYO: sus usuarios, sus blueprints propios,
// y ver su consumo/crédito. Todo scopeado a req.auth.activeOrgId. Montado con requireAuth +
// requireOrgAdmin. El ledger/credit NO exponen el costo real ni el margen (solo lo cobrado).
// ─────────────────────────────────────────────────────────────────────────────────────────────
const express = require('express')
const router = express.Router()
const { db, getClient } = require('../services/supabase.service')
const { getStatus } = require('../services/credits.service')

// ── Miembros de MI org (5.4) ──
router.get('/members', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { data: oms } = await db().from('org_members')
      .select('id, org_role, joined_at, member_id, members(id, display_name, auth_user_id)')
      .eq('org_id', orgId)
    const { data: authData } = await getClient().auth.admin.listUsers({ perPage: 1000 })
    const emailById = Object.fromEntries((authData?.users || []).map(u => [u.id, u.email]))
    const members = (oms || []).map(o => ({
      org_member_id: o.id, member_id: o.member_id, org_role: o.org_role, joined_at: o.joined_at,
      display_name: o.members?.display_name, email: emailById[o.members?.auth_user_id] || null,
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

// cambiar rol de un miembro de MI org
router.patch('/members/:memberId', async (req, res, next) => {
  try {
    const orgId = req.auth.activeOrgId
    const { memberId } = req.params
    const { org_role } = req.body
    if (!['owner', 'admin', 'member', 'viewer'].includes(org_role)) return res.status(400).json({ success: false, error: 'invalid org_role' })
    const { data, error } = await db().from('org_members').update({ org_role }).eq('org_id', orgId).eq('member_id', memberId).select('id, org_role').single()
    if (error) return res.status(400).json({ success: false, error: error.message })
    res.json({ success: true, org_member: data })
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
