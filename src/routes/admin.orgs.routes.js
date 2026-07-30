// ─── Consola super-admin · Frente 5 (Multi-Org) ──────────────────────────────────────────────
// Endpoints para que el SUPER-ADMIN (V57) gestione organizaciones: crear org + su primer org-admin,
// cargar/vender créditos, editar (margen/estado/billing) y ver el libro mayor con detalle completo.
// Montado bajo /api/admin con requirePlatformAdmin (solo plataforma V57).
//
// OJO roles: el org-admin se crea con members.role = 'member' (NO platform-admin); su poder de
// org viene de org_members.org_role = 'admin'. Así no hereda poder de plataforma.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const express = require('express')
const router = express.Router()
const { db, getClient } = require('../services/supabase.service')
const { addCredits } = require('../services/credits.service')

const slugify = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

// GET /api/admin/orgs — lista con saldo, margen, estado y # de miembros
router.get('/orgs', async (req, res, next) => {
  try {
    const { data: orgs, error } = await db().from('organizations')
      .select('id, name, slug, status, credit_balance, margin_multiplier, last_topup_usd, payment_provider, billing_email, created_at')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ success: false, error: error.message })

    const { data: oms } = await db().from('org_members').select('org_id')
    const counts = {}
    for (const r of (oms || [])) counts[r.org_id] = (counts[r.org_id] || 0) + 1

    res.json({ success: true, orgs: (orgs || []).map(o => ({ ...o, member_count: counts[o.id] || 0 })) })
  } catch (err) { next(err) }
})

// POST /api/admin/orgs — crear organización
router.post('/orgs', async (req, res, next) => {
  try {
    const { name, slug, margin_multiplier } = req.body
    if (!name) return res.status(400).json({ success: false, error: 'name is required' })
    const row = { name, slug: slugify(slug || name), created_by: req.adminMemberId || null }
    if (margin_multiplier != null) row.margin_multiplier = margin_multiplier
    const { data, error } = await db().from('organizations').insert(row).select('*').single()
    if (error) return res.status(400).json({ success: false, error: error.message })
    res.json({ success: true, org: data })
  } catch (err) { next(err) }
})

// PATCH /api/admin/orgs/:orgId — editar (margen/estado/billing)
router.patch('/orgs/:orgId', async (req, res, next) => {
  try {
    const { orgId } = req.params
    const allowed = ['name', 'status', 'margin_multiplier', 'billing_customer_id', 'payment_provider', 'billing_email']
    const updates = {}
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k]
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'Nothing to update' })
    updates.updated_at = new Date().toISOString()
    const { data, error } = await db().from('organizations').update(updates).eq('id', orgId).select('*').single()
    if (error) return res.status(400).json({ success: false, error: error.message })
    res.json({ success: true, org: data })
  } catch (err) { next(err) }
})

// POST /api/admin/orgs/:orgId/admins — crear el org-admin de la organización
router.post('/orgs/:orgId/admins', async (req, res, next) => {
  try {
    const { orgId } = req.params
    const { email, password, display_name } = req.body
    if (!email || !password || !display_name) {
      return res.status(400).json({ success: false, error: 'email, password and display_name are required' })
    }

    // 1) usuario de auth (el trigger crea el member con role='member')
    const { data: authData, error: authError } = await getClient().auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { display_name },
    })
    if (authError) return res.status(400).json({ success: false, error: authError.message })
    const authUserId = authData.user.id

    // 2) display_name en el member (rol de PLATAFORMA queda 'member' -> NO super-admin)
    await db().from('members').update({ display_name }).eq('auth_user_id', authUserId)
    const { data: member } = await db().from('members').select('id').eq('auth_user_id', authUserId).single()

    // 3) org_members con rol de ORG 'admin'
    const { error: omErr } = await db().from('org_members').insert({ org_id: orgId, member_id: member.id, org_role: 'admin' })
    if (omErr) return res.status(400).json({ success: false, error: omErr.message })

    res.json({ success: true, org_admin: { auth_id: authUserId, email, member_id: member.id, org_id: orgId } })
  } catch (err) { next(err) }
})

// POST /api/admin/orgs/:orgId/credits — cargar/vender créditos (agnóstico de pasarela)
router.post('/orgs/:orgId/credits', async (req, res, next) => {
  try {
    const { orgId } = req.params
    const { amount_usd, payment_provider = null, external_ref = null } = req.body
    if (!amount_usd || Number(amount_usd) <= 0) return res.status(400).json({ success: false, error: 'amount_usd must be > 0' })
    const r = await addCredits({ orgId, amountUsd: Number(amount_usd), paymentProvider: payment_provider, externalRef: external_ref, createdBy: req.adminMemberId || null })
    if (!r) return res.status(404).json({ success: false, error: 'Org not found' })
    res.json({ success: true, new_balance: r.newBalance })
  } catch (err) { next(err) }
})

// GET /api/admin/orgs/:orgId/ledger — libro mayor con detalle COMPLETO (raw_cost + margen, solo V57)
router.get('/orgs/:orgId/ledger', async (req, res, next) => {
  try {
    const { orgId } = req.params
    const { data, error } = await db().from('credit_transactions')
      .select('id, type, amount_usd, balance_after, raw_cost_usd, margin_multiplier, payment_provider, external_ref, created_at')
      .eq('org_id', orgId).order('created_at', { ascending: false }).limit(200)
    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, transactions: data || [] })
  } catch (err) { next(err) }
})

// GET /api/admin/orgs/:orgId/blueprints — blueprints PROPIOS de la org (oversight read-only del super-admin)
router.get('/orgs/:orgId/blueprints', async (req, res, next) => {
  try {
    const { orgId } = req.params
    const { data, error } = await db().from('forge_blueprints')
      .select('id, blueprint_key, name, phase, description, is_default, node_sequence, edges, gate, created_by, created_at, updated_at')
      .eq('org_id', orgId)
      .order('phase')
    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, blueprints: data || [] })
  } catch (err) { next(err) }
})

module.exports = router
