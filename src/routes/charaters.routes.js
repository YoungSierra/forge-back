const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')
const { getStepConfig, getWorkflowById } = require('../services/config.service')
const { generateImageComfyUI, uploadImageToComfyUI } = require('../services/providers/comfyui.provider')

function charKey(char) {
  return (char.name || 'character').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function gddOf(project) {
  return project?.concept?.pipeline?.gdd || {}
}

// GET /api/projects/:id/charaters/status
router.get('/:id/charaters/status', async (req, res, next) => {
  try {
    const { data: project, error } = await db()
      .from('projects').select('id, concept').eq('id', req.params.id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const characters = gddOf(project).characters || []

    const { data: assets } = await db()
      .from('assets')
      .select('*, asset_versions!asset_versions_asset_id_fkey(*)')
      .eq('project_id', req.params.id)
      .eq('step_key', 'charaters')

    const assetByKey = Object.fromEntries((assets || []).map(a => [a.name, a]))

    const status = characters.map((c, i) => {
      const key   = charKey(c)
      const asset = assetByKey[key]
      const currentVersion = asset?.asset_versions?.find(v => v.is_current) ?? null
      const allVersions    = asset?.asset_versions?.length ?? 0
      return {
        character_key:   key,
        character_name:  c.name,
        character_index: i,
        sprite_prompt:   c.sprite_prompt || '',
        status:          !asset ? 'empty' : asset.review_status === 'approved' ? 'approved' : 'generated',
        asset_id:        asset?.id ?? null,
        review_status:   asset?.review_status ?? null,
        current_version: currentVersion,
        total_versions:  allVersions,
      }
    })

    res.json({ success: true, characters: status })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/charaters/:char_key/generate
router.post('/:id/charaters/:char_key/generate', async (req, res, next) => {
  try {
    const { id: project_id, char_key } = req.params

    const { data: project, error } = await db()
      .from('projects').select('id, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const gdd        = gddOf(project)
    const characters = gdd.characters || []
    const charIndex  = characters.findIndex(c => charKey(c) === char_key)
    if (charIndex === -1) return res.status(404).json({ success: false, error: `Character "${char_key}" not found in GDD` })

    const config = await getStepConfig('charaters')
    if (!config?.image_enabled || config.image_integration_type !== 'comfyui' || !config.image_workflow_id) {
      return res.status(422).json({ success: false, error: 'charaters step config must have ComfyUI image integration enabled' })
    }

    const workflow = await getWorkflowById(config.image_workflow_id)
    if (!workflow) return res.status(404).json({ success: false, error: 'ComfyUI workflow not found' })

    // Global reference images (shared across all characters)
    const { data: refs } = await db()
      .from('character_image_refs')
      .select('image_url')
      .eq('project_id', project_id)
      .eq('character_key', 'global')
      .eq('selected', true)
      .order('created_at', { ascending: true })
      .limit(2)

    const urlA = refs?.[0]?.image_url
    const urlB = refs?.[1]?.image_url || urlA
    if (!urlA) return res.status(422).json({ success: false, error: 'No approved reference images found for this character' })

    // Upload reference images to ComfyUI Cloud so it can access them by filename
    const [refA, refB] = await Promise.all([
      uploadImageToComfyUI(urlA),
      uploadImageToComfyUI(urlB),
    ])

    const target = characters[charIndex]
    const namesStr   = target.name
    const promptsStr = target.sprite_prompt || target.name

    const storagePath = `projects/${project_id}/charaters/${char_key}_${Date.now()}.png`
    const result = await generateImageComfyUI(workflow.name, '', 1024, 1024, storagePath, {
      char_index:   0,
      names_list:   namesStr,
      prompts_list: promptsStr,
      ref_image_a:  refA,
      ref_image_b:  refB,
    })

    // Upsert asset row
    let assetId
    const { data: existing } = await db()
      .from('assets')
      .select('id')
      .eq('project_id', project_id)
      .eq('step_key', 'charaters')
      .eq('name', char_key)
      .single()

    if (existing) {
      assetId = existing.id
      await db().from('assets')
        .update({ review_status: 'pending' })
        .eq('id', assetId)
    } else {
      const { data: newAsset, error: insertErr } = await db().from('assets')
        .insert({ project_id, step_key: 'charaters', name: char_key, type: 'image', discipline: 'art', review_status: 'pending' })
        .select('id').single()
      if (insertErr || !newAsset) {
        console.error('[charaters] asset insert error:', insertErr)
        return res.status(500).json({ success: false, error: `Failed to create asset: ${insertErr?.message}` })
      }
      assetId = newAsset.id
    }

    // Mark all previous versions as not current
    await db().from('asset_versions').update({ is_current: false }).eq('asset_id', assetId)

    // Get next version number
    const { count } = await db()
      .from('asset_versions').select('*', { count: 'exact', head: true }).eq('asset_id', assetId)

    // Insert new version
    const { data: version, error: versionErr } = await db().from('asset_versions')
      .insert({
        asset_id:       assetId,
        version_number: (count || 0) + 1,
        source:         'ai_generated',
        storage_url:    result.url,
        storage_bucket: 'r2',
        model_used:     workflow.name,
        is_current:     true,
        metadata:       { character_key: char_key, workflow: workflow.name, storage_path: storagePath },
      })
      .select().single()

    if (versionErr) console.error('[charaters] asset_versions insert error:', versionErr)

    console.log(`[charaters] Generated render for "${char_key}" → ${result.url}`)
    // Always return image_url directly so the frontend can render regardless of DB insert result
    res.json({ success: true, asset_id: assetId, version, image_url: result.url })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/charaters/:char_key/approve
router.post('/:id/charaters/:char_key/approve', async (req, res, next) => {
  try {
    const { data: asset } = await db()
      .from('assets')
      .select('id')
      .eq('project_id', req.params.id)
      .eq('step_key', 'charaters')
      .eq('name', req.params.char_key)
      .single()

    if (!asset) return res.status(404).json({ success: false, error: 'No render found for this character' })

    await db().from('assets')
      .update({ review_status: 'approved' })
      .eq('id', asset.id)

    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/charaters/approve-node
router.post('/:id/charaters/approve-node', async (req, res, next) => {
  try {
    const { data: project } = await db()
      .from('projects').select('id, concept').eq('id', req.params.id).single()
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' })

    const characters = gddOf(project).characters || []

    const { data: assets } = await db()
      .from('assets')
      .select('name, review_status')
      .eq('project_id', req.params.id)
      .eq('step_key', 'charaters')

    const approvedKeys = new Set((assets || []).filter(a => a.review_status === 'approved').map(a => a.name))
    const allApproved  = characters.every(c => approvedKeys.has(charKey(c)))

    if (!allApproved) {
      return res.status(422).json({ success: false, error: 'All characters must be approved before approving the node' })
    }

    const pipeline = project.concept?.pipeline || {}
    const updated  = { ...project.concept, pipeline: { ...pipeline, charaters: { ...(pipeline.charaters || {}), approved: true, approved_at: new Date().toISOString() } } }

    await db().from('projects').update({ concept: updated }).eq('id', req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
