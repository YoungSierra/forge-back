const express = require('express')
const router = express.Router()
const { db } = require('../services/supabase.service')

// GET /api/assets?project_id=&step_key=
router.get('/', async (req, res, next) => {
  try {
    const { project_id, step_key } = req.query

    const includeRefs = !step_key || step_key === 'image_reference'
    const includeRegular = !step_key || step_key !== 'image_reference'

    // Regular assets
    let assets = []
    if (includeRegular) {
      let query = db()
        .from('assets')
        .select('*, asset_versions!asset_versions_asset_id_fkey(*), projects!assets_project_id_fkey(id, name)')
        .order('created_at', { ascending: false })
        .limit(300)

      if (project_id) query = query.eq('project_id', project_id)
      if (step_key)   query = query.eq('step_key', step_key)

      const { data, error } = await query
      if (error) return res.status(500).json({ success: false, error: 'Failed to fetch assets', code: 'SUPABASE_ERROR' })
      assets = data || []
    }

    // Image reference assets (selected character refs)
    let refAssets = []
    if (includeRefs) {
      let refQuery = db()
        .from('character_image_refs')
        .select('*')
        .eq('selected', true)
        .order('created_at', { ascending: false })
        .limit(200)

      if (project_id) refQuery = refQuery.eq('project_id', project_id)

      const { data: refs } = await refQuery
      refAssets = (refs || []).map(r => ({
        id:             `ref_${r.id}`,
        project_id:     r.project_id,
        step_key:       'image_reference',
        name:           r.character_key.replace(/_/g, ' '),
        type:           'image',
        discipline:     'reference',
        review_status:  'approved',
        created_at:     r.created_at,
        job_id:         null,
        projects:       null,
        asset_versions: [{
          id:             `ref_v_${r.id}`,
          asset_id:       `ref_${r.id}`,
          version_number: 1,
          source:         'image_reference',
          storage_url:    r.image_url,
          is_current:     true,
          created_at:     r.created_at,
          metadata:       { character_key: r.character_key, round: r.round },
        }],
      }))
    }

    res.json({ success: true, assets: [...assets, ...refAssets] })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/assets/:id/review
router.patch('/:id/review', async (req, res, next) => {
  try {
    const { id } = req.params
    const { action, notes, member_id } = req.body

    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action must be approve or reject', code: 'VALIDATION_ERROR' })
    }
    if (action === 'reject' && !notes) {
      return res.status(400).json({ success: false, error: 'notes is required when rejecting', code: 'VALIDATION_ERROR' })
    }

    const { data: existing, error: fErr } = await db().from('assets').select('id').eq('id', id).single()
    if (fErr || !existing) {
      return res.status(404).json({ success: false, error: 'Asset not found', code: 'NOT_FOUND' })
    }

    const update = {
      review_status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: member_id || null,
      reviewed_at: new Date().toISOString()
    }
    if (notes) update.review_notes = notes

    const { data: asset, error: uErr } = await db()
      .from('assets')
      .update(update)
      .eq('id', id)
      .select()
      .single()

    if (uErr) {
      return res.status(500).json({ success: false, error: 'Failed to update asset', code: 'SUPABASE_ERROR' })
    }

    res.json({ success: true, asset })
  } catch (err) {
    next(err)
  }
})

module.exports = router
