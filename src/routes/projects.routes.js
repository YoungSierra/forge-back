const express = require('express')
const path = require('path')
const fs = require('fs')
const archiver = require('archiver')
const router = express.Router()
const { db, TEST_MEMBER_ID, calculateCost } = require('../services/supabase.service')
const { ensureProjectDir, getAssetUrl, slugify, STORAGE_BASE } = require('../services/storage.service')

// GET /api/projects?auth_user_id=xxx
router.get('/', async (req, res, next) => {
  try {
    const { auth_user_id } = req.query

    // Resolve member_id from auth_user_id, fallback to TEST_MEMBER_ID
    let memberId = TEST_MEMBER_ID
    if (auth_user_id) {
      const { data: member } = await db().from('members').select('id').eq('auth_user_id', auth_user_id).single()
      if (member) memberId = member.id
    }

    // Get project_ids where user is a project_member (not owner)
    const { data: memberRows } = await db()
      .from('project_members')
      .select('project_id')
      .eq('member_id', memberId)
    const memberProjectIds = (memberRows || []).map(r => r.project_id)

    let query = db()
      .from('projects')
      .select('*, assets(id, review_status), generation_jobs(id, current_step, status)')
      .order('created_at', { ascending: false })

    if (memberProjectIds.length > 0) {
      query = query.or(`owner_member_id.eq.${memberId},id.in.(${memberProjectIds.join(',')})`)
    } else {
      query = query.eq('owner_member_id', memberId)
    }

    const { data: projects, error } = await query

    if (error) {
      return res.status(500).json({ success: false, error: 'Database error', code: 'SUPABASE_ERROR', ...(process.env.NODE_ENV === 'development' && { details: error }) })
    }

    const result = (projects || []).map(p => {
      const assets = p.assets || []
      const jobs = p.generation_jobs || []

      // Calcular current_wizard_step igual que en GET /:id
      const stepOrder = ['step_1_concept', 'step_2_sprites', 'step_3_levels',
        'step_4_code', 'step_5_audio', 'step_6_export']
      let current_wizard_step = 1
      for (let i = stepOrder.length - 1; i >= 0; i--) {
        const job = jobs.find(j => j.current_step === stepOrder[i] && j.status === 'approved')
        if (job) {
          current_wizard_step = Math.min(i + 2, 6)
          break
        }
      }

      const approved_wizard_count = jobs.filter(j =>
        j.status === 'approved' && stepOrder.includes(j.current_step)
      ).length

      let node_approved_count = null
      let node_total_count = null
      const layout = p.canvas_layout
      if (layout?.nodes?.length) {
        const approvable = layout.nodes.filter(n => n.type !== 'forgeGroup' && !n.data?.comingSoon)
        node_total_count    = approvable.length
        node_approved_count = approvable.filter(n => n.data?.approved).length
      }

      return {
        ...p,
        canvas_layout: undefined,
        assets: undefined,
        generation_jobs: undefined,
        current_wizard_step,
        approved_wizard_count,
        node_approved_count,
        node_total_count,
        approved_asset_count: assets.filter(a => a.review_status === 'approved').length,
        total_asset_count: assets.length
      }
    })

    res.json({ success: true, projects: result })
  } catch (err) {
    next(err)
  }
})

// PUT /api/projects/:id/canvas — save canvas layout
router.put('/:id/canvas', async (req, res, next) => {
  try {
    const { id } = req.params
    const { canvas_layout } = req.body
    if (!canvas_layout) return res.status(400).json({ success: false, error: 'canvas_layout is required' })

    const { error } = await db().from('projects').update({ canvas_layout }).eq('id', id)
    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /api/projects/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params

    const { data: project, error: pErr } = await db()
      .from('projects')
      .select('*')
      .eq('id', id)
      .single()

    if (pErr || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const [jobsRes, assetsRes, exportsRes] = await Promise.all([
      db().from('generation_jobs').select('*').eq('project_id', id).order('created_at', { ascending: true }),
      db().from('assets').select('*, asset_versions!asset_versions_asset_id_fkey(*)').eq('project_id', id).order('created_at', { ascending: true }),
      db().from('export_packages').select('*').eq('project_id', id).order('created_at', { ascending: false })
    ])

    const jobs = jobsRes.data || []
    const stepOrder = ['step_1_concept', 'step_2_sprites', 'step_3_levels', 'step_4_code', 'step_5_audio', 'step_6_export']
    let current_step = 1
    for (let i = stepOrder.length - 1; i >= 0; i--) {
      const job = jobs.find(j => j.current_step === stepOrder[i] && j.status === 'approved')
      if (job) {
        current_step = i + 2
        break
      }
    }

    res.json({
      success: true,
      project: {
        ...project,
        current_wizard_step: Math.min(current_step, 6),
        generation_jobs: jobs,
        assets: assetsRes.data || [],
        export_packages: exportsRes.data || []
      }
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/projects/approve-step1
router.post('/approve-step1', async (req, res, next) => {
  try {
    const { gdd, prompt, meta } = req.body

    if (!gdd || !prompt) {
      return res.status(400).json({ success: false, error: 'gdd and prompt are required', code: 'VALIDATION_ERROR' })
    }

    const tokens_used = meta?.tokens_used || { input: 0, output: 0, cached: 0 }
    const duration_ms = meta?.duration_ms || 0
    const total_cost_usd = calculateCost(tokens_used)

    const { data: project, error: pErr } = await db()
      .from('projects')
      .insert({
        name: gdd.project?.name || 'Untitled Game',
        description: gdd.project?.description || '',
        genre: gdd.project?.genre || 'platformer',
        target_engine: (gdd.development?.suggested_engine || 'unity').toLowerCase(),
        status: 'active',
        owner_member_id: TEST_MEMBER_ID,
        concept: gdd
      })
      .select()
      .single()

    if (pErr) {
      return res.status(500).json({ success: false, error: 'Failed to create project', code: 'SUPABASE_ERROR', ...(process.env.NODE_ENV === 'development' && { details: pErr }) })
    }

    const startedAt = new Date(Date.now() - duration_ms).toISOString()

    const { data: job, error: jErr } = await db()
      .from('generation_jobs')
      .insert({
        project_id: project.id,
        triggered_by: TEST_MEMBER_ID,
        status: 'approved',
        progress: 100,
        current_step: 'step_1_concept',
        input_prompt: prompt,
        total_cost_usd,
        tokens_used,
        started_at: startedAt,
        completed_at: new Date().toISOString()
      })
      .select()
      .single()

    if (jErr) {
      return res.status(500).json({ success: false, error: 'Failed to create generation job', code: 'SUPABASE_ERROR', ...(process.env.NODE_ENV === 'development' && { details: jErr }) })
    }

    ensureProjectDir(project.id)

    res.status(201).json({ success: true, project_id: project.id, job_id: job.id, project })
  } catch (err) {
    next(err)
  }
})

// POST /api/projects/:project_id/approve-step2
router.post('/:project_id/approve-step2', async (req, res, next) => {
  try {
    const { project_id } = req.params
    const { approved_sprites } = req.body

    if (!approved_sprites || !Array.isArray(approved_sprites)) {
      return res.status(400).json({ success: false, error: 'approved_sprites array is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error: pErr } = await db().from('projects').select('id, concept').eq('id', project_id).single()
    if (pErr || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const { data: job, error: jErr } = await db()
      .from('generation_jobs')
      .insert({
        project_id,
        triggered_by: TEST_MEMBER_ID,
        status: 'approved',
        progress: 100,
        current_step: 'step_2_sprites',
        input_prompt: `Sprites for project ${project_id}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      })
      .select()
      .single()

    if (jErr) {
      return res.status(500).json({ success: false, error: 'Failed to create job', code: 'SUPABASE_ERROR' })
    }

    const createdAssets = []
    for (const sprite of approved_sprites) {
      const { data: asset, error: aErr } = await db()
        .from('assets')
        .insert({
          project_id,
          job_id: job.id,
          name: sprite.character_name,
          type: 'sprite',
          discipline: 'art',
          review_status: 'approved',
          reviewed_by: TEST_MEMBER_ID,
          reviewed_at: new Date().toISOString()
        })
        .select()
        .single()

      if (aErr) continue

      await db().from('asset_versions').insert({
        asset_id: asset.id,
        version_number: 1,
        source: 'ai_generated',
        storage_url: sprite.preview_url,
        storage_bucket: 'local',
        prompt_used: sprite.sprite_prompt,
        model_used: 'placeholder',
        uploaded_by: TEST_MEMBER_ID,
        is_current: true
      })

      createdAssets.push(asset)
    }

    // Persist preview_url back into concept.characters so the frontend can display them
    const enrichedChars = (project.concept?.characters || []).map(char => {
      const sprite = approved_sprites.find(s => s.character_name === char.name)
      if (!sprite || !sprite.preview_url) return char
      return { ...char, preview_url: sprite.preview_url, asset_type: 'sprite' }
    })
    await db().from('projects').update({
      concept: { ...project.concept, characters: enrichedChars },
      updated_at: new Date().toISOString()
    }).eq('id', project_id)

    res.status(201).json({ success: true, job_id: job.id, assets: createdAssets })
  } catch (err) {
    next(err)
  }
})

// POST /api/projects/:project_id/approve-step3
router.post('/:project_id/approve-step3', async (req, res, next) => {
  try {
    const { project_id } = req.params
    const { approved_levels } = req.body

    if (!approved_levels || !Array.isArray(approved_levels)) {
      return res.status(400).json({ success: false, error: 'approved_levels array is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error: pErr } = await db()
      .from('projects')
      .select('id, concept')
      .eq('id', project_id)
      .single()

    if (pErr || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const { data: job, error: jErr } = await db()
      .from('generation_jobs')
      .insert({
        project_id,
        triggered_by: TEST_MEMBER_ID,
        status: 'approved',
        progress: 100,
        current_step: 'step_3_levels',
        input_prompt: `Levels for project ${project_id}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      })
      .select()
      .single()

    if (jErr) {
      return res.status(500).json({ success: false, error: 'Failed to create job', code: 'SUPABASE_ERROR' })
    }

    const createdAssets = []
    for (const level of approved_levels) {
      const { data: asset, error: aErr } = await db()
        .from('assets')
        .insert({
          project_id,
          job_id: job.id,
          name: level.name,
          type: 'background',
          discipline: 'art',
          review_status: 'approved',
          reviewed_by: TEST_MEMBER_ID,
          reviewed_at: new Date().toISOString()
        })
        .select()
        .single()

      if (aErr) continue

      await db().from('asset_versions').insert({
        asset_id: asset.id,
        version_number: 1,
        source: 'ai_generated',
        storage_url: level.preview_url,
        storage_bucket: 'local',
        prompt_used: level.background_prompt,
        model_used: 'placeholder',
        uploaded_by: TEST_MEMBER_ID,
        is_current: true,
        metadata: {
          background_prompt: level.background_prompt,
          preview_url: level.preview_url
        }
      })

      createdAssets.push(asset)
    }

    // Update concept.levels with expanded data + preview_url
    const enrichedLevels = (project.concept?.levels || []).map(conceptLevel => {
      const approved = approved_levels.find(al => al.name === conceptLevel.name)
      if (!approved) return conceptLevel
      return {
        ...conceptLevel,
        preview_url: approved.preview_url || conceptLevel.preview_url,
        expanded_description: approved.expanded_description,
        enemy_placements: approved.enemy_placements,
        collectibles: approved.collectibles,
        hazards: approved.hazards,
        background_prompt: approved.background_prompt || conceptLevel.background_prompt,
        asset_type: 'background',
      }
    })

    await db().from('projects').update({
      concept: { ...project.concept, levels: enrichedLevels },
      updated_at: new Date().toISOString()
    }).eq('id', project_id)

    res.status(201).json({ success: true, job_id: job.id, assets: createdAssets })
  } catch (err) {
    next(err)
  }
})

// POST /api/projects/:project_id/approve-step4
router.post('/:project_id/approve-step4', async (req, res, next) => {
  try {
    const { project_id } = req.params
    const { files, architecture_md, engine } = req.body

    const isNewFormat = Array.isArray(files)
    const isOldFormat = req.body.code && req.body.code.game_js

    if (!isNewFormat && !isOldFormat) {
      return res.status(400).json({
        success: false,
        error: 'files array or code.game_js is required',
        code: 'VALIDATION_ERROR'
      })
    }

    const { data: project, error: pErr } = await db()
      .from('projects').select('id').eq('id', project_id).single()
    if (pErr || !project) {
      return res.status(404).json({
        success: false, error: 'Project not found', code: 'NOT_FOUND'
      })
    }

    const { data: job } = await db()
      .from('generation_jobs')
      .insert({
        project_id,
        triggered_by: TEST_MEMBER_ID,
        status: 'approved',
        progress: 100,
        current_step: 'step_4_code',
        input_prompt: `Code for project ${project_id}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      })
      .select().single()

    const createdAssets = []

    if (isNewFormat) {
      for (const file of files) {
        const { data: asset } = await db()
          .from('assets')
          .insert({
            project_id,
            job_id: job?.id,
            name: file.filename,
            type: 'code',
            discipline: 'code',
            review_status: 'approved',
            reviewed_by: TEST_MEMBER_ID,
            reviewed_at: new Date().toISOString()
          })
          .select().single()

        if (asset) {
          await db().from('asset_versions').insert({
            asset_id: asset.id,
            version_number: 1,
            source: 'ai_generated',
            storage_url: getAssetUrl(project_id, `code/${file.filename}`),
            storage_bucket: 'local',
            model_used: `${engine || 'unity'}-generated`,
            uploaded_by: TEST_MEMBER_ID,
            is_current: true,
            metadata: {
              engine: engine || 'unity',
              description: file.description,
              size_bytes: file.size_bytes
            }
          })
          createdAssets.push(asset)
        }
      }

      if (architecture_md) {
        const { data: archAsset } = await db()
          .from('assets')
          .insert({
            project_id,
            job_id: job?.id,
            name: 'architecture.md',
            type: 'code',
            discipline: 'code',
            review_status: 'approved',
            reviewed_by: TEST_MEMBER_ID,
            reviewed_at: new Date().toISOString()
          })
          .select().single()

        if (archAsset) {
          await db().from('asset_versions').insert({
            asset_id: archAsset.id,
            version_number: 1,
            source: 'ai_generated',
            storage_url: getAssetUrl(project_id, 'code/architecture.md'),
            storage_bucket: 'local',
            model_used: 'ai_generated',
            uploaded_by: TEST_MEMBER_ID,
            is_current: true
          })
          createdAssets.push(archAsset)
        }
      }
    } else {
      for (const [name, storageUrl] of [
        ['game.js', getAssetUrl(project_id, 'code/game.js')],
        ['architecture.md', getAssetUrl(project_id, 'code/architecture.md')]
      ]) {
        const { data: asset } = await db()
          .from('assets')
          .insert({
            project_id, job_id: job?.id, name,
            type: 'code', discipline: 'code',
            review_status: 'approved',
            reviewed_by: TEST_MEMBER_ID,
            reviewed_at: new Date().toISOString()
          })
          .select().single()

        if (asset) {
          await db().from('asset_versions').insert({
            asset_id: asset.id, version_number: 1,
            source: 'ai_generated', storage_url: storageUrl,
            storage_bucket: 'local', model_used: 'phaser-generated',
            uploaded_by: TEST_MEMBER_ID, is_current: true
          })
          createdAssets.push(asset)
        }
      }
    }

    res.status(201).json({
      success: true, job_id: job?.id, assets: createdAssets
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/projects/:id/play
router.get('/:id/play', async (req, res, next) => {
  try {
    const { id } = req.params
    const { data: project } = await db()
      .from('projects').select('target_engine, name').eq('id', id).single()

    const engine = project?.target_engine || 'unity'

    if (engine !== 'phaser') {
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Forge · ${project?.name || 'Game'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0f; display: flex; flex-direction: column;
           align-items: center; justify-content: center; min-height: 100vh;
           font-family: monospace; color: #e2e8f0; text-align: center; gap: 16px; }
    .engine { font-size: 48px; }
    h1 { font-size: 14px; color: #7c3aed; letter-spacing: 3px; }
    p { font-size: 13px; color: #64748b; max-width: 400px; line-height: 1.6; }
    code { background: #13151f; padding: 2px 8px; border-radius: 4px;
           color: #a78bfa; font-size: 12px; }
  </style>
</head>
<body>
  <div class="engine">${engine === 'unity' ? '🎮' : engine === 'unreal' ? '⚡' : '🤖'}</div>
  <h1>FORGE · GAME PREVIEW</h1>
  <p>This project targets <code>${engine}</code>.</p>
  <p>Open the project in ${engine === 'unity' ? 'Unity Editor' : engine === 'unreal' ? 'Unreal Engine' : 'Godot'}
     and import the scripts from the export package to run the game.</p>
  <p style="margin-top: 8px; color: #475569; font-size: 11px;">
    Scripts are available in the export package (Step 6)
  </p>
</body>
</html>`
      res.setHeader('Content-Type', 'text/html')
      return res.send(html)
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Forge · Game Preview</title>
  <style>
    * { margin: 0; padding: 0; }
    body { background: #0a0a0f; display: flex; flex-direction: column;
           align-items: center; justify-content: center; min-height: 100vh;
           font-family: monospace; color: #e2e8f0; }
    h1 { margin-bottom: 12px; font-size: 12px; color: #7c3aed; letter-spacing: 3px; }
    .controls { margin-top: 10px; font-size: 11px; color: #64748b; }
  </style>
</head>
<body>
  <h1>FORGE · GAME PREVIEW</h1>
  <div id="game-container"></div>
  <div class="controls">← → Move &nbsp;|&nbsp; ↑ Jump &nbsp;|&nbsp; SHIFT Dimensional Shift &nbsp;|&nbsp; Any key to restart</div>
  <script src="https://cdn.jsdelivr.net/npm/phaser@3.60.0/dist/phaser.min.js"></script>
  <script src="/assets/projects/${id}/code/game.js"></script>
</body>
</html>`
    res.setHeader('Content-Type', 'text/html')
    res.send(html)
  } catch (err) {
    next(err)
  }
})

// POST /api/projects/:project_id/approve-step5
router.post('/:project_id/approve-step5', async (req, res, next) => {
  try {
    const { project_id } = req.params
    const { audio } = req.body

    if (!audio) {
      return res.status(400).json({ success: false, error: 'audio is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error: pErr } = await db().from('projects').select('id').eq('id', project_id).single()
    if (pErr || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const { data: job } = await db()
      .from('generation_jobs')
      .insert({
        project_id,
        triggered_by: TEST_MEMBER_ID,
        status: 'approved',
        progress: 100,
        current_step: 'step_5_audio',
        input_prompt: `Audio for project ${project_id}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      })
      .select()
      .single()

    const createdAssets = []
    const allAudio = [
      ...(audio.sfx || []).map(s => ({ ...s, audioType: 'sfx' })),
      ...(audio.music || []).map(m => ({ ...m, audioType: 'music' }))
    ]

    for (const item of allAudio) {
      const name = item.name || item.level_name || 'audio'
      const { data: asset } = await db()
        .from('assets')
        .insert({
          project_id,
          job_id: job?.id,
          name,
          type: 'audio',
          discipline: 'audio',
          review_status: 'approved',
          reviewed_by: TEST_MEMBER_ID,
          reviewed_at: new Date().toISOString()
        })
        .select()
        .single()

      if (asset) {
        const { audioType, ...itemMeta } = item
        await db().from('asset_versions').insert({
          asset_id: asset.id,
          version_number: 1,
          source: 'ai_generated',
          storage_url: `audio://${project_id}/${slugify(name)}`,
          storage_bucket: 'local',
          model_used: 'gemini-2.5-flash',
          uploaded_by: TEST_MEMBER_ID,
          is_current: true,
          metadata: { audio_type: audioType, ...itemMeta }
        })
        createdAssets.push(asset)
      }
    }

    res.status(201).json({ success: true, job_id: job?.id, assets: createdAssets })
  } catch (err) {
    next(err)
  }
})

// POST /api/projects/:project_id/export
router.post('/:project_id/export', async (req, res, next) => {
  try {
    const { project_id } = req.params
    const { target_engine = 'unity' } = req.body

    if (!['unity', 'unreal'].includes(target_engine)) {
      return res.status(400).json({ success: false, error: 'target_engine must be unity or unreal', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error: pErr } = await db().from('projects').select('*').eq('id', project_id).single()
    if (pErr || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const { data: assets } = await db()
      .from('assets')
      .select('*, asset_versions!asset_versions_asset_id_fkey(*)')
      .eq('project_id', project_id)
      .eq('review_status', 'approved')

    const root = target_engine === 'unity' ? 'Assets/Forge' : 'Content/Forge'
    const folderMap = {
      unity: { code: 'Scripts', sprite: 'Sprites', background: 'Backgrounds', audio: 'Audio', docs: 'Docs' },
      unreal: { code: 'Scripts', sprite: 'Textures', background: 'Environments', audio: 'Audio', docs: 'Docs' }
    }
    const folders = folderMap[target_engine]

    const manifest = { engine: target_engine, root, files: [] }
    const includedAssets = []

    ensureProjectDir(project_id)
    const timestamp = Date.now()
    const zipFilename = `package-${timestamp}.zip`
    const zipPath = path.join(STORAGE_BASE, 'projects', project_id, 'export', zipFilename)

    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    await new Promise((resolve, reject) => {
      output.on('close', resolve)
      archive.on('error', reject)
      archive.pipe(output)

      for (const asset of (assets || [])) {
        const version = (asset.asset_versions || []).find(v => v.is_current)
        if (!version) continue

        const localPath = version.storage_url.startsWith('/assets/')
          ? path.join(STORAGE_BASE, version.storage_url.replace('/assets/', ''))
          : null

        let destFolder = folders[asset.type] || 'Misc'
        const destFile = `${root}/${destFolder}/${asset.name}`
        manifest.files.push(destFile)
        includedAssets.push(asset.id)

        if (localPath && fs.existsSync(localPath)) {
          archive.file(localPath, { name: destFile })
        } else {
          archive.append(JSON.stringify(version.metadata || {}, null, 2), { name: destFile + '.json' })
        }
      }

      // Always include GDD
      const gddJson = JSON.stringify(project.concept, null, 2)
      archive.append(gddJson, { name: `${root}/Docs/gdd.json` })
      manifest.files.push(`${root}/Docs/gdd.json`)

      archive.finalize()
    })

    const { data: pkg, error: pkgErr } = await db()
      .from('export_packages')
      .insert({
        project_id,
        created_by: TEST_MEMBER_ID,
        target_engine,
        version_label: `v${timestamp}`,
        status: 'complete',
        included_assets: includedAssets,
        package_url: getAssetUrl(project_id, `export/${zipFilename}`),
        manifest,
        total_cost_usd: 0
      })
      .select()
      .single()

    res.status(201).json({
      success: true,
      package_url: getAssetUrl(project_id, `export/${zipFilename}`),
      manifest,
      total_assets: includedAssets.length,
      package_id: pkg?.id
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/projects/:id/approve-node — generic pipeline node approval
// Stores { data, approved: true } in concept.pipeline.{stepKey}
router.post('/:id/approve-node', async (req, res, next) => {
  try {
    const { id } = req.params
    const { stepKey, data: nodeData } = req.body

    if (!stepKey) {
      return res.status(400).json({ success: false, error: 'stepKey is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error: pErr } = await db().from('projects').select('id, concept').eq('id', id).single()
    if (pErr || !project) {
      console.error(`[APPROVE-NODE] Project not found: ${id}`, pErr)
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const pipeline = project.concept?.pipeline || {}
    const updatedPipeline = {
      ...pipeline,
      [stepKey]: { ...(nodeData || {}), approved: true, approved_at: new Date().toISOString() }
    }
    const updatedConcept = { ...project.concept, pipeline: updatedPipeline }

    console.log(`[APPROVE-NODE] Saving stepKey="${stepKey}" for project ${id}`)

    const now = new Date().toISOString()

    const { error: uErr } = await db()
      .from('projects')
      .update({ concept: updatedConcept, updated_at: now })
      .eq('id', id)

    if (uErr) {
      console.error(`[APPROVE-NODE] Supabase update error for project ${id}:`, uErr)
      return res.status(500).json({
        success: false,
        error: 'Failed to update project',
        code: 'SUPABASE_ERROR',
        details: uErr.message,
      })
    }

    // Register in generation_jobs so it appears in the DB audit trail and the pipeline can detect it
    const { error: jErr } = await db().from('generation_jobs').insert({
      project_id: id,
      triggered_by: TEST_MEMBER_ID,
      status: 'approved',
      progress: 100,
      current_step: stepKey,
      input_prompt: `Pipeline node approved: ${stepKey}`,
      started_at: now,
      completed_at: now,
    })

    if (jErr) {
      console.error(`[APPROVE-NODE] generation_jobs insert error:`, jErr)
      // Non-fatal: project.concept was already updated — still return success
    }

    console.log(`[APPROVE-NODE] Saved stepKey="${stepKey}" for project ${id} ✓`)
    res.status(200).json({ success: true, stepKey, approved: true })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/projects/:id/invalidate-from-step
router.patch('/:id/invalidate-from-step', async (req, res, next) => {
  try {
    const { id } = req.params
    const { from_step } = req.body

    if (!from_step || typeof from_step !== 'number') {
      return res.status(400).json({ success: false, error: 'from_step (number) is required', code: 'VALIDATION_ERROR' })
    }

    const stepOrder = ['step_1_concept', 'step_2_sprites', 'step_3_levels', 'step_4_code', 'step_5_audio', 'step_6_export']
    const stepsToInvalidate = stepOrder.slice(from_step - 1)

    const { data: jobs, error: jErr } = await db()
      .from('generation_jobs')
      .update({ status: 'invalidated' })
      .eq('project_id', id)
      .in('current_step', stepsToInvalidate)
      .select()

    if (jErr) {
      return res.status(500).json({ success: false, error: 'Failed to invalidate jobs', code: 'SUPABASE_ERROR' })
    }

    const invalidatedJobIds = (jobs || []).map(j => j.id)
    let invalidatedAssets = 0

    if (invalidatedJobIds.length > 0) {
      const { data: updatedAssets } = await db()
        .from('assets')
        .update({ review_status: 'invalidated' })
        .in('job_id', invalidatedJobIds)
        .select()
      invalidatedAssets = (updatedAssets || []).length
    }

    res.json({ success: true, invalidated_count: (jobs || []).length + invalidatedAssets })
  } catch (err) {
    next(err)
  }
})

// GET /api/projects/:id/members
router.get('/:id/members', async (req, res, next) => {
  try {
    const { id } = req.params
    const { data, error } = await db()
      .from('project_members')
      .select('id, project_role, discipline, joined_at, members(id, display_name, avatar_url, role)')
      .eq('project_id', id)
      .order('joined_at', { ascending: true })

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, members: data || [] })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/members
router.post('/:id/members', async (req, res, next) => {
  try {
    const { id } = req.params
    const { member_id, project_role = 'reviewer', discipline } = req.body

    if (!member_id || !discipline) {
      return res.status(400).json({ success: false, error: 'member_id and discipline are required' })
    }

    const { data, error } = await db()
      .from('project_members')
      .insert({ project_id: id, member_id, project_role, discipline })
      .select('id, project_role, discipline, joined_at, members(id, display_name, avatar_url, role)')
      .single()

    if (error) {
      if (error.code === '23505') return res.status(409).json({ success: false, error: 'Member already in project' })
      return res.status(500).json({ success: false, error: error.message })
    }
    res.json({ success: true, member: data })
  } catch (err) { next(err) }
})

// DELETE /api/projects/:id/members/:memberId
router.delete('/:id/members/:memberId', async (req, res, next) => {
  try {
    const { id, memberId } = req.params
    const { error } = await db()
      .from('project_members')
      .delete()
      .eq('project_id', id)
      .eq('member_id', memberId)

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
