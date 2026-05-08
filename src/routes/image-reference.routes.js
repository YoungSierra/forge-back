const express = require('express')
const router  = express.Router()
const { db, TEST_MEMBER_ID } = require('../services/supabase.service')
const {
  generateRound, getPool, approveSelection, getGlobalStatus, DEFAULT_COUNT, buildGlobalPrompt,
} = require('../services/image-reference.service')

function gddOf(project) {
  return project?.concept?.pipeline?.gdd || {}
}

// GET /api/projects/:id/image-reference — global status
router.get('/:id/image-reference', async (req, res, next) => {
  try {
    const { data: project, error } = await db().from('projects').select('id, concept').eq('id', req.params.id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const status     = await getGlobalStatus(req.params.id)
    const promptUsed = buildGlobalPrompt(gddOf(project))

    res.json({ success: true, status, prompt_used: promptUsed, max_pool: require('../services/image-reference.service').MAX_POOL })
  } catch (err) { next(err) }
})

// GET /api/projects/:id/image-reference/pool — global image pool
router.get('/:id/image-reference/pool', async (req, res, next) => {
  try {
    const images = await getPool(req.params.id)
    res.json({ success: true, images })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/image-reference/start — pipeline executor entry point
router.post('/:id/image-reference/start', async (req, res, next) => {
  try {
    const { data: project, error } = await db().from('projects').select('id, concept').eq('id', req.params.id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const status = await getGlobalStatus(req.params.id)
    if (status.total_images > 0) {
      return res.json({ success: true, skipped: true, reason: 'Pool already has images' })
    }

    const gdd    = gddOf(project)
    const images = await generateRound(req.params.id, gdd, DEFAULT_COUNT)

    const now     = new Date().toISOString()
    const actorId = req.body.member_id || TEST_MEMBER_ID

    const { data: existing } = await db()
      .from('generation_jobs')
      .select('id, status')
      .eq('project_id', req.params.id)
      .eq('current_step', 'image_reference')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (existing) {
      if (existing.status !== 'approved') {
        await db().from('generation_jobs').update({ status: 'review', review_status: 'pending', updated_at: now }).eq('id', existing.id)
      }
    } else {
      await db().from('generation_jobs').insert({
        project_id:    req.params.id,
        triggered_by:  actorId,
        status:        'review',
        review_status: 'pending',
        current_step:  'image_reference',
        input_prompt:  'Image reference generation started',
        started_at:    now,
        progress:      100,
      })
    }

    res.json({ success: true, generated: images.length })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/image-reference/generate — generate more images
router.post('/:id/image-reference/generate', async (req, res, next) => {
  try {
    const count = Math.min(Number(req.body.count ?? DEFAULT_COUNT), 10)

    const { data: project, error } = await db().from('projects').select('id, concept').eq('id', req.params.id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const images = await generateRound(req.params.id, gddOf(project), count)
    res.json({ success: true, images })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/image-reference/approve — approve exactly 2 images globally
router.post('/:id/image-reference/approve', async (req, res, next) => {
  try {
    const { selected_ids } = req.body
    if (!Array.isArray(selected_ids) || selected_ids.length !== 2) {
      return res.status(400).json({ success: false, error: 'Exactly 2 images must be selected' })
    }

    const selected = await approveSelection(req.params.id, selected_ids)
    res.json({ success: true, selected })
  } catch (err) { next(err) }
})

module.exports = router
