const express = require('express')
const { db } = require('../services/supabase.service')

// Dos routers: uno público (solo publicadas) y uno admin (CRUD completo).
// Espejo del patrón de action-nodes.routes.js (export de múltiples routers).
const publicRouter = express.Router()
const adminRouter  = express.Router()

const VALID_TYPES = ['bug_fix', 'new_feature', 'improvement']

// ─── PÚBLICO ───────────────────────────────────────────────────────────────────
// GET /api/changelog?limit=25&offset=0 — publicadas, paginadas (más recientes primero)
publicRouter.get('/', async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)

    // Se pide limit+1 (range inclusivo) para saber si hay más sin un count extra
    const { data, error } = await db()
      .from('forge_changelog')
      .select('id, version, type, title, items, released_at')
      .eq('published', true)
      .order('released_at', { ascending: false })
      .range(offset, offset + limit)

    if (error) return res.status(500).json({ success: false, error: error.message })

    const rows    = data || []
    const hasMore = rows.length > limit
    res.json({ success: true, entries: hasMore ? rows.slice(0, limit) : rows, has_more: hasMore })
  } catch (err) { next(err) }
})

// ─── ADMIN ──────────────────────────────────────────────────────────────────────
// GET /api/admin/changelog — todas las entradas (borradores + publicadas)
adminRouter.get('/changelog', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('forge_changelog')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, entries: data || [] })
  } catch (err) { next(err) }
})

// POST /api/admin/changelog — crear entrada
adminRouter.post('/changelog', async (req, res, next) => {
  try {
    const { version, type, title, items, source, published } = req.body
    const memberId = req.headers['x-member-id'] || null

    if (!version?.trim() || !title?.trim() || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, error: 'version, title y un type válido son requeridos' })
    }

    const isPublished = published === true
    const { data, error } = await db()
      .from('forge_changelog')
      .insert({
        version:     version.trim(),
        type,
        title:       title.trim(),
        items:       Array.isArray(items) ? items : [],
        source:      source === 'seed' ? 'seed' : 'manual',
        published:   isPublished,
        released_at: isPublished ? new Date().toISOString() : null,
        created_by:  memberId,
      })
      .select('*')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, entry: data })
  } catch (err) { next(err) }
})

// PATCH /api/admin/changelog/:id — actualizar / publicar / despublicar
adminRouter.patch('/changelog/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const { version, type, title, items, published } = req.body

    if (type !== undefined && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, error: 'type inválido' })
    }

    const patch = {}
    if (version !== undefined) patch.version = String(version).trim()
    if (type    !== undefined) patch.type   = type
    if (title   !== undefined) patch.title  = String(title).trim()
    if (items   !== undefined) patch.items  = Array.isArray(items) ? items : []

    // Al publicar por primera vez se sella released_at; al despublicar se limpia
    if (published !== undefined) {
      patch.published = published === true
      if (published === true) {
        const { data: current } = await db()
          .from('forge_changelog')
          .select('released_at')
          .eq('id', id)
          .single()
        patch.released_at = current?.released_at || new Date().toISOString()
      } else {
        patch.released_at = null
      }
    }

    const { data, error } = await db()
      .from('forge_changelog')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, entry: data })
  } catch (err) { next(err) }
})

// DELETE /api/admin/changelog/:id
adminRouter.delete('/changelog/:id', async (req, res, next) => {
  try {
    const { error } = await db()
      .from('forge_changelog')
      .delete()
      .eq('id', req.params.id)

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = { publicRouter, adminRouter }
