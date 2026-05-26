const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')

// ─── GET /api/admin/forge/nodes ───────────────────────────────
// Lista todos los nodos. Filtros opcionales: phase, status
router.get('/', async (req, res, next) => {
  try {
    const { phase, status } = req.query
    let query = db().from('forge_nodes').select('*').order('phase').order('node_key')
    if (phase)  query = query.eq('phase', phase)
    if (status) query = query.eq('status', status)
    else        query = query.neq('status', 'archived')

    const { data, error } = await query
    if (error) throw error
    res.json({ success: true, nodes: data })
  } catch (err) { next(err) }
})

// ─── GET /api/admin/forge/nodes/:id ──────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('forge_nodes')
      .select('*')
      .eq('id', req.params.id)
      .single()
    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Node not found' })
    res.json({ success: true, node: data })
  } catch (err) { next(err) }
})

// ─── POST /api/admin/forge/nodes ─────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      node_key, title, phase,
      purpose, inputs, outputs, constraints, tools, skills, default_prompt,
    } = req.body

    if (!node_key || !title || !phase) {
      return res.status(400).json({ success: false, error: 'node_key, title y phase son requeridos' })
    }

    const { data, error } = await db()
      .from('forge_nodes')
      .insert({
        node_key, title, phase,
        purpose:        purpose        || '',
        inputs:         inputs         || { required: [], optional: [], description: '' },
        outputs:        outputs        || [],
        constraints:    constraints    || '',
        tools:          tools          || [],
        skills:         skills         || [],
        default_prompt: default_prompt || '',
        status: 'active',
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json({ success: true, node: data })
  } catch (err) { next(err) }
})

// ─── PATCH /api/admin/forge/nodes/:id ────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = [
      'node_key', 'title', 'phase', 'status',
      'purpose', 'inputs', 'outputs', 'constraints',
      'tools', 'skills', 'default_prompt', 'executor',
    ]
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    updates.updated_at = new Date().toISOString()

    const { data, error } = await db()
      .from('forge_nodes')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Node not found' })
    res.json({ success: true, node: data })
  } catch (err) { next(err) }
})

// ─── POST /api/admin/forge/nodes/:id/clone ───────────────────
router.post('/:id/clone', async (req, res, next) => {
  try {
    const { data: source, error: fetchErr } = await db()
      .from('forge_nodes')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (fetchErr) throw fetchErr
    if (!source)  return res.status(404).json({ success: false, error: 'Node not found' })

    const { data, error } = await db()
      .from('forge_nodes')
      .insert({
        node_key:       `${source.node_key}_variant_${Date.now()}`,
        title:          `${source.title} — variant`,
        phase:          source.phase,
        status:         'active',
        parent_id:      source.id,
        purpose:        source.purpose,
        inputs:         source.inputs,
        outputs:        source.outputs,
        constraints:    source.constraints,
        tools:          source.tools,
        skills:         source.skills,
        default_prompt: source.default_prompt,
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json({ success: true, node: data })
  } catch (err) { next(err) }
})

// ─── PATCH /api/admin/forge/nodes/:id/restore ────────────────
router.patch('/:id/restore', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('forge_nodes')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Node not found' })
    res.json({ success: true, node: data })
  } catch (err) { next(err) }
})

// ─── PATCH /api/admin/forge/nodes/:id/archive ────────────────
router.patch('/:id/archive', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('forge_nodes')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Node not found' })
    res.json({ success: true, node: data })
  } catch (err) { next(err) }
})

module.exports = router
