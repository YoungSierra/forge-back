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

// GET /api/projects/:id/modeling-characters/status
router.get('/:id/modeling-characters/status', async (req, res, next) => {
  try {
    const { data: project, error } = await db()
      .from('projects').select('id, concept').eq('id', req.params.id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const characters = gddOf(project).characters || []

    // 2D renders (charaters step)
    const { data: renders2d } = await db()
      .from('assets')
      .select('name, asset_versions!asset_versions_asset_id_fkey(*)')
      .eq('project_id', req.params.id)
      .eq('step_key', 'charaters')

    // 3D models (modeling_characters step)
    const { data: models3d } = await db()
      .from('assets')
      .select('id, name, review_status, asset_versions!asset_versions_asset_id_fkey(*)')
      .eq('project_id', req.params.id)
      .eq('step_key', 'modeling_characters')

    const render2dByKey = Object.fromEntries((renders2d || []).map(a => [a.name, a]))
    const model3dByKey  = Object.fromEntries((models3d  || []).map(a => [a.name, a]))

    const status = characters.map((c, i) => {
      const key     = charKey(c)
      const r2d     = render2dByKey[key]
      const m3d     = model3dByKey[key]
      const cur2d   = r2d?.asset_versions?.find(v => v.is_current) ?? null
      const cur3d   = m3d?.asset_versions?.find(v => v.is_current) ?? null
      const vers3d  = m3d?.asset_versions?.length ?? 0

      return {
        character_key:      key,
        character_name:     c.name,
        character_index:    i,
        render_2d_url:      cur2d?.storage_url ?? null,
        status_3d:          !m3d ? 'empty' : m3d.review_status === 'approved' ? 'approved' : 'generated',
        review_status_3d:   m3d?.review_status ?? null,
        asset_id_3d:        m3d?.id ?? null,
        current_version_3d: cur3d,
        total_versions_3d:  vers3d,
      }
    })

    res.json({ success: true, characters: status })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/modeling-characters/:char_key/generate
router.post('/:id/modeling-characters/:char_key/generate', async (req, res, next) => {
  try {
    const { id: project_id, char_key } = req.params

    const { data: project, error } = await db()
      .from('projects').select('id, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const characters = gddOf(project).characters || []
    const charIndex  = characters.findIndex(c => charKey(c) === char_key)
    if (charIndex === -1) return res.status(404).json({ success: false, error: `Character "${char_key}" not found in GDD` })

    // Obtener URL del render 2D desde el step charaters
    const { data: asset2d } = await db()
      .from('assets')
      .select('id, asset_versions!asset_versions_asset_id_fkey(*)')
      .eq('project_id', project_id)
      .eq('step_key', 'charaters')
      .eq('name', char_key)
      .single()

    const cur2d = asset2d?.asset_versions?.find(v => v.is_current) ?? null
    if (!cur2d?.storage_url) {
      return res.status(422).json({ success: false, error: `No 2D render found for character "${char_key}". Generate the character render first.` })
    }

    const config = await getStepConfig('modeling_characters')
    if (!config?.image_enabled || config.image_integration_type !== 'comfyui' || !config.image_workflow_id) {
      return res.status(422).json({ success: false, error: 'modeling_characters step config must have ComfyUI image integration enabled' })
    }

    const workflow = await getWorkflowById(config.image_workflow_id)
    if (!workflow) return res.status(404).json({ success: false, error: 'ComfyUI workflow not found' })

    // Detectar dinámicamente el campo tipo 'image' en inject_config (igual que RefinementModal)
    const imageExtra = Object.entries(workflow.inject_config?.extra ?? {})
      .find(([, point]) => point.type === 'image')

    if (!imageExtra) {
      return res.status(422).json({ success: false, error: 'No image input (type: "image") configured in workflow inject_config' })
    }
    const [imageKey] = imageExtra

    // Subir render 2D a ComfyUI y usar la clave detectada
    const comfyFilename = await uploadImageToComfyUI(cur2d.storage_url)
    console.log(`[modeling-characters] Uploaded 2D render → ComfyUI filename: ${comfyFilename} (key: "${imageKey}")`)

    const storagePath = `projects/${project_id}/modeling_characters/${char_key}_${Date.now()}.png`
    const result = await generateImageComfyUI(workflow.name, '', 1024, 1024, storagePath, {
      [imageKey]: comfyFilename,
    }, 600_000) // 10 minutos — generación 3D tarda mucho más que 2D

    // Upsert asset row
    let assetId
    const { data: existing } = await db()
      .from('assets')
      .select('id')
      .eq('project_id', project_id)
      .eq('step_key', 'modeling_characters')
      .eq('name', char_key)
      .single()

    if (existing) {
      assetId = existing.id
    } else {
      const { data: newAsset, error: insertErr } = await db().from('assets')
        .insert({ project_id, step_key: 'modeling_characters', name: char_key, type: 'model', discipline: 'art', review_status: 'pending' })
        .select('id').single()
      if (insertErr || !newAsset) {
        console.error('[modeling-characters] asset insert error:', insertErr)
        return res.status(500).json({ success: false, error: `Failed to create asset: ${insertErr?.message}` })
      }
      assetId = newAsset.id
    }

    // Marcar versiones anteriores como no-current
    await db().from('asset_versions').update({ is_current: false }).eq('asset_id', assetId)

    // Siguiente número de versión
    const { count } = await db()
      .from('asset_versions').select('*', { count: 'exact', head: true }).eq('asset_id', assetId)

    const glbUrl     = result.glb_urls?.[0] ?? null
    const storageUrl = glbUrl ?? result.url

    const { data: version, error: versionErr } = await db().from('asset_versions')
      .insert({
        asset_id:       assetId,
        version_number: (count || 0) + 1,
        source:         'ai_generated',
        storage_url:    storageUrl,
        storage_bucket: 'r2',
        model_used:     workflow.name,
        is_current:     true,
        metadata:       { character_key: char_key, workflow: workflow.name, glb_url: glbUrl, texture_url: result.url },
      })
      .select().single()

    if (versionErr) console.error('[modeling-characters] asset_versions insert error:', versionErr)

    console.log(`[modeling-characters] Generated 3D for "${char_key}" → ${storageUrl}`)
    res.json({ success: true, asset_id: assetId, version, glb_url: glbUrl, texture_url: result.url, glb_urls: result.glb_urls ?? [] })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/modeling-characters/:char_key/approve
router.post('/:id/modeling-characters/:char_key/approve', async (req, res, next) => {
  try {
    const { data: asset } = await db()
      .from('assets')
      .select('id')
      .eq('project_id', req.params.id)
      .eq('step_key', 'modeling_characters')
      .eq('name', req.params.char_key)
      .single()

    if (!asset) return res.status(404).json({ success: false, error: 'No 3D model found for this character' })

    await db().from('assets').update({ review_status: 'approved' }).eq('id', asset.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/modeling-characters/approve-node
router.post('/:id/modeling-characters/approve-node', async (req, res, next) => {
  try {
    const { data: project } = await db()
      .from('projects').select('id, concept').eq('id', req.params.id).single()
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' })

    const characters = gddOf(project).characters || []

    const { data: assets } = await db()
      .from('assets')
      .select('name, review_status')
      .eq('project_id', req.params.id)
      .eq('step_key', 'modeling_characters')

    const approvedKeys = new Set((assets || []).filter(a => a.review_status === 'approved').map(a => a.name))
    const allApproved  = characters.every(c => approvedKeys.has(charKey(c)))

    if (!allApproved) {
      return res.status(422).json({ success: false, error: 'All character 3D models must be approved before approving the node' })
    }

    const pipeline = project.concept?.pipeline || {}
    const updated  = {
      ...project.concept,
      pipeline: {
        ...pipeline,
        modeling_characters: {
          ...(pipeline.modeling_characters || {}),
          approved:    true,
          approved_at: new Date().toISOString(),
        },
      },
    }

    await db().from('projects').update({ concept: updated }).eq('id', req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
