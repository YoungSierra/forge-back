const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')

// ─── GET /api/admin/forge/blueprints ─────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { phase } = req.query
    let query = db().from('forge_blueprints').select('*').order('phase').order('name')
    if (phase) query = query.eq('phase', phase)

    const { data, error } = await query
    if (error) throw error
    res.json({ success: true, blueprints: data })
  } catch (err) { next(err) }
})

// ─── GET /api/admin/forge/blueprints/:id ─────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('forge_blueprints')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Blueprint not found' })
    res.json({ success: true, blueprint: data })
  } catch (err) { next(err) }
})

// ─── POST /api/admin/forge/blueprints ────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      blueprint_key, name, phase, description,
      node_sequence, edges, gate, is_default,
    } = req.body

    if (!blueprint_key || !name || !phase) {
      return res.status(400).json({ success: false, error: 'blueprint_key, name y phase son requeridos' })
    }

    // Si is_default=true, quitar default de otros blueprints de la misma fase
    if (is_default) {
      await db()
        .from('forge_blueprints')
        .update({ is_default: false })
        .eq('phase', phase)
        .eq('is_default', true)
    }

    const { data, error } = await db()
      .from('forge_blueprints')
      .insert({
        blueprint_key,
        name,
        phase,
        description: description || null,
        node_sequence: node_sequence || [],
        edges:         edges         || [],
        gate:          gate          || { name: '', mode: 'conversational', suggested_rubrics: [], outcomes: ['accept', 'refine', 'kill'] },
        is_default:    is_default    || false,
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json({ success: true, blueprint: data })
  } catch (err) { next(err) }
})

// ─── PATCH /api/admin/forge/blueprints/:id ───────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const {
      blueprint_key, name, phase, description,
      node_sequence, edges, gate, is_default,
    } = req.body

    const updates = {}
    if (blueprint_key !== undefined) updates.blueprint_key = blueprint_key
    if (name          !== undefined) updates.name          = name
    if (phase         !== undefined) updates.phase         = phase
    if (description   !== undefined) updates.description   = description
    if (node_sequence !== undefined) updates.node_sequence = node_sequence
    if (edges         !== undefined) updates.edges         = edges
    if (gate          !== undefined) updates.gate          = gate
    if (is_default    !== undefined) updates.is_default    = is_default
    updates.updated_at = new Date().toISOString()

    // Si se marca como default, quitar default de otros de la misma fase
    if (is_default) {
      const { data: current } = await db()
        .from('forge_blueprints')
        .select('phase')
        .eq('id', req.params.id)
        .single()

      if (current) {
        await db()
          .from('forge_blueprints')
          .update({ is_default: false })
          .eq('phase', current.phase)
          .eq('is_default', true)
          .neq('id', req.params.id)
      }
    }

    const { data, error } = await db()
      .from('forge_blueprints')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, error: 'Blueprint not found' })
    res.json({ success: true, blueprint: data })
  } catch (err) { next(err) }
})

module.exports = router
