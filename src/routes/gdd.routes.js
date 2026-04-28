const express = require('express')
const path = require('path')
const router = express.Router()
const { callLLM } = require('../services/llm.service')
const { GDD_SYSTEM_PROMPT } = require('../prompts/gdd.prompt')
const { SPRITES_SYSTEM_PROMPT } = require('../prompts/sprites.prompt')
const { LEVELS_SYSTEM_PROMPT } = require('../prompts/levels.prompt')
const { buildCodePrompt } = require('../prompts/code.prompt')
const { AUDIO_SYSTEM_PROMPT } = require('../prompts/audio.prompt')
const { VISUAL_GUIDE_SYSTEM_PROMPT } = require('../prompts/visual_guide.prompt')
const { BACKGROUNDS_SYSTEM_PROMPT } = require('../prompts/backgrounds.prompt')
const { SFX_SYSTEM_PROMPT } = require('../prompts/sfx.prompt')
const { CONCEPT_ART_SYSTEM_PROMPT } = require('../prompts/concept_art.prompt')
const { UIUX_SYSTEM_PROMPT } = require('../prompts/uiux.prompt')
const { ICONS_SYSTEM_PROMPT } = require('../prompts/icons.prompt')
const { HUD_SYSTEM_PROMPT } = require('../prompts/hud.prompt')
const { MODELING_SYSTEM_PROMPT } = require('../prompts/modeling.prompt')
const { CHARACTERS3D_SYSTEM_PROMPT } = require('../prompts/characters3d.prompt')
const { VFX_SYSTEM_PROMPT } = require('../prompts/vfx.prompt')
const { TEXTURING_SYSTEM_PROMPT } = require('../prompts/texturing.prompt')
const { RIGGING_SYSTEM_PROMPT } = require('../prompts/rigging.prompt')
const { LIGHTING_SYSTEM_PROMPT } = require('../prompts/lighting.prompt')
const { ANIMATION_SYSTEM_PROMPT } = require('../prompts/animation.prompt')
const { CINEMATICS_SYSTEM_PROMPT } = require('../prompts/cinematics.prompt')
const { VOICE_SYSTEM_PROMPT } = require('../prompts/voice.prompt')
const { db, TEST_MEMBER_ID } = require('../services/supabase.service')
const { ensureProjectDir, getAssetUrl, slugify, STORAGE_BASE } = require('../services/storage.service')
const { generateImage, generateImagesSequential } = require('../services/image.service')

function llmErr(err) {
  if (err.status === 429 || err.code === 'RATE_LIMIT')  return { status: 502, error: 'Rate limit reached. Try again later.', code: 'RATE_LIMIT' }
  if (err.code === 'MAX_TOKENS')   return { status: 502, error: 'Response too long. Try again or simplify the project.', code: 'MAX_TOKENS' }
  if (err.code === 'INVALID_JSON') return { status: 502, error: 'LLM returned malformed JSON. Try again.', code: 'INVALID_JSON' }
  return { status: 502, error: 'LLM API call failed', code: 'LLM_ERROR' }
}

// POST /api/generate/gdd
router.post('/gdd', async (req, res, next) => {
  try {
    const { prompt } = req.body

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ success: false, error: 'prompt is required', code: 'VALIDATION_ERROR' })
    }
    if (prompt.length < 10 || prompt.length > 1000) {
      return res.status(400).json({ success: false, error: 'prompt must be 10–1000 characters', code: 'VALIDATION_ERROR' })
    }

    let result
    try {
      result = await callLLM(GDD_SYSTEM_PROMPT, `Generate a complete Game Design Document for this game idea: ${prompt}`, {
        step: 'step_1_gdd',
        maxOutputTokens: 8192
      })
    } catch (err) {
      const code = err.code || 'LLM_ERROR'
      const isRateLimit = err.status === 429 || code === 'RATE_LIMIT'
      return res.status(502).json({
        success: false,
        error: isRateLimit ? 'Rate limit reached. Try again later or switch models.' : 'LLM API call failed',
        code: isRateLimit ? 'RATE_LIMIT' : (err.code || 'LLM_ERROR'),
        retry_after_ms: err.retry_after_ms || null,
        ...(process.env.NODE_ENV === 'development' && { details: { message: err.message } })
      })
    }

    res.status(201).json({
      success: true,
      gdd: result.data,
      meta: result.meta
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/sprites
router.post('/sprites', async (req, res, next) => {
  try {
    const { project_id } = req.body

    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error } = await db().from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const characters = project.concept?.characters || []
    if (characters.length === 0) {
      return res.status(400).json({ success: false, error: 'Project has no characters in concept', code: 'VALIDATION_ERROR' })
    }

    const genId = Date.now().toString(36)
    const tasks = characters.map(char => ({
      prompt: char.sprite_prompt || char.name,
      width: 512, height: 512,
      storagePath: `projects/${project_id}/${slugify(char.name)}-${genId}.jpg`,
    }))
    const imgResults = await generateImagesSequential(tasks)
    const sprites = characters.map((char, i) => ({
      character_name: char.name,
      character_role: char.role,
      sprite_prompt: char.sprite_prompt,
      preview_url: imgResults[i].url,
      placeholder: imgResults[i].source === 'placeholder',
    }))

    res.status(200).json({ success: true, sprites })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/levels
router.post('/levels', async (req, res, next) => {
  try {
    const { project_id } = req.body

    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error } = await db().from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const levels = project.concept?.levels || []
    if (levels.length === 0) {
      return res.status(400).json({ success: false, error: 'Project has no levels in concept', code: 'VALIDATION_ERROR' })
    }

    let result
    try {
      result = await callLLM(
        LEVELS_SYSTEM_PROMPT,
        `Expand these levels for the game "${project.name}". Characters available: ${JSON.stringify(project.concept.characters?.map(c => c.name))}. Levels: ${JSON.stringify(levels)}`,
        { step: 'step_3_levels', maxOutputTokens: 8192 }
      )
    } catch (err) {
      const code = err.code || 'LLM_ERROR'
      const isRateLimit = err.status === 429 || code === 'RATE_LIMIT'
      return res.status(502).json({
        success: false,
        error: isRateLimit ? 'Rate limit reached. Try again later or switch models.' : 'LLM API call failed',
        code: isRateLimit ? 'RATE_LIMIT' : (err.code || 'LLM_ERROR'),
        retry_after_ms: err.retry_after_ms || null,
        ...(process.env.NODE_ENV === 'development' && { details: { message: err.message } })
      })
    }

    const levelList = result.data.levels || []
    const genId = Date.now().toString(36)
    const levelTasks = levelList.map(level => ({
      prompt: level.background_prompt || level.name,
      width: 1280, height: 640,
      storagePath: `projects/${project_id}/level-${slugify(level.name)}-${genId}.jpg`,
    }))
    const levelImgs = await generateImagesSequential(levelTasks)
    const expandedLevels = levelList.map((level, i) => ({
      ...level,
      preview_url: levelImgs[i].url,
    }))

    res.status(200).json({ success: true, levels: expandedLevels, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/code
router.post('/code', async (req, res, next) => {
  try {
    const { project_id } = req.body

    if (!project_id) {
      return res.status(400).json({
        success: false,
        error: 'project_id is required',
        code: 'VALIDATION_ERROR'
      })
    }

    const { data: project, error } = await db()
      .from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({
        success: false, error: 'Project not found', code: 'NOT_FOUND'
      })
    }

    const targetEngine = project.target_engine || 'unity'

    const gameContext = {
      name: project.concept.project?.name,
      genre: project.concept.project?.genre,
      core_loop: project.concept.project?.core_loop,
      tone: project.concept.project?.tone,
      target_engine: targetEngine,
      mechanics: project.concept.mechanics?.slice(0, 3).map(m => ({
        name: m.name,
        type: m.type,
        description: m.description
      })),
      characters: project.concept.characters?.map(c => ({
        name: c.name,
        role: c.role,
        abilities: c.abilities?.slice(0, 3),
        description: c.description?.slice(0, 150)
      })),
      levels: project.concept.levels?.slice(0, 3).map(l => ({
        name: l.name,
        difficulty: l.difficulty,
        environment: l.environment
      })),
      art_direction: {
        style: project.concept.art_direction?.style,
        resolution: project.concept.art_direction?.resolution
      }
    }

    const systemPrompt = buildCodePrompt(targetEngine, gameContext)

    let result
    try {
      result = await callLLM(
        systemPrompt,
        `Generate the ${targetEngine} scripts for: ${gameContext.name}`,
        { step: 'step_4_code', maxOutputTokens: 8000 }
      )
      // LOG TEMPORAL
      console.log('=== LLM CODE RESPONSE ===')
      console.log(JSON.stringify(result.data, null, 2).slice(0, 2000))
      console.log('=== END ===')
    } catch (err) {
      const isRateLimit = err.status === 429
      return res.status(502).json({
        success: false,
        error: isRateLimit
          ? 'Rate limit reached. Try again later or switch models.'
          : 'LLM API call failed',
        code: isRateLimit ? 'RATE_LIMIT' : 'LLM_ERROR',
        retry_after_ms: err.retry_after_ms || null,
        ...(process.env.NODE_ENV === 'development' && {
          details: { message: err.message }
        })
      })
    }

    const { files, architecture_md, engine } = result.data
    if (!files || !Array.isArray(files)) {
      return res.status(502).json({
        success: false,
        error: 'LLM returned invalid script structure',
        code: 'INVALID_RESPONSE'
      })
    }

    ensureProjectDir(project_id)
    const codePath = require('path').join(STORAGE_BASE, 'projects', project_id, 'code')

    const savedFiles = []
    for (const file of files) {
      const filePath = require('path').join(codePath, file.filename)
      require('fs').writeFileSync(filePath, file.content || '')
      savedFiles.push({
        filename: file.filename,
        description: file.description,
        url: getAssetUrl(project_id, `code/${file.filename}`),
        size_bytes: Buffer.byteLength(file.content || '', 'utf8'),
        content: file.content || ''  // ← agregar esto
      })
    }

    if (architecture_md) {
      require('fs').writeFileSync(
        require('path').join(codePath, 'architecture.md'),
        architecture_md
      )
    }

    res.status(200).json({
      success: true,
      engine: targetEngine,
      files: savedFiles,
      architecture_md: architecture_md || '',
      meta: result.meta
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/audio
router.post('/audio', async (req, res, next) => {
  try {
    const { project_id } = req.body

    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    let result
    try {
      result = await callLLM(
        AUDIO_SYSTEM_PROMPT,
        `Generate a complete audio design plan for this game: ${JSON.stringify(project.concept)}`,
        { step: 'step_5_audio', maxOutputTokens: 4096 }
      )
    } catch (err) {
      const code = err.code || 'LLM_ERROR'
      const isRateLimit = err.status === 429 || code === 'RATE_LIMIT'
      return res.status(502).json({
        success: false,
        error: isRateLimit ? 'Rate limit reached. Try again later or switch models.' : 'LLM API call failed',
        code: isRateLimit ? 'RATE_LIMIT' : (err.code || 'LLM_ERROR'),
        retry_after_ms: err.retry_after_ms || null,
        ...(process.env.NODE_ENV === 'development' && { details: { message: err.message } })
      })
    }

    res.status(200).json({ success: true, audio: result.data, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/visual-guide
router.post('/visual-guide', async (req, res, next) => {
  try {
    const { project_id } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const artDir = project.concept?.art_direction || {}
    const projInfo = project.concept?.project || {}

    const userPrompt = `Generate a Visual Style Guide for this game:
Title: ${projInfo.name || project.name}
Genre: ${projInfo.genre || project.genre}
Tone: ${projInfo.tone || 'neutral'}
Art style: ${artDir.style || 'unspecified'}
Palette: ${artDir.palette || 'unspecified'}
Lighting: ${artDir.lighting_style || 'unspecified'}
References: ${(artDir.references || []).join(', ') || 'none'}
Description: ${projInfo.elevator_pitch || ''}`

    let result
    try {
      result = await callLLM(VISUAL_GUIDE_SYSTEM_PROMPT, userPrompt, { step: 'pipeline_visual_guide', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    res.status(200).json({ success: true, visual_guide: result.data, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/concept-art
router.post('/concept-art', async (req, res, next) => {
  try {
    const { project_id } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const userPrompt = `Game: ${project.name}
Genre: ${project.concept?.project?.genre || project.genre}
Art style: ${project.concept?.art_direction?.style || 'unspecified'}
Characters: ${JSON.stringify((project.concept?.characters || []).map(c => ({ name: c.name, role: c.role, description: c.description })))}
Levels/environments: ${JSON.stringify((project.concept?.levels || []).map(l => ({ name: l.name, environment: l.environment })))}`

    let promptResult
    try {
      promptResult = await callLLM(CONCEPT_ART_SYSTEM_PROMPT, userPrompt, { step: 'pipeline_concept_art', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const concepts = promptResult.data

    // Generate images sequentially to avoid Pollinations rate limiting
    const charList = concepts.character_concepts || []
    const envList  = concepts.environment_concepts || []

    const genId = Date.now().toString(36)
    const charTasks = charList.map(c => ({
      prompt: c.prompt, width: 512, height: 512,
      storagePath: `projects/${project_id}/concept-char-${slugify(c.name)}-${genId}.jpg`,
    }))
    const envTasks = envList.map(e => ({
      prompt: e.prompt, width: 768, height: 512,
      storagePath: `projects/${project_id}/concept-env-${slugify(e.name)}-${genId}.jpg`,
    }))
    const charImgs = await generateImagesSequential(charTasks)
    const envImgs  = await generateImagesSequential(envTasks)

    const charConcepts = charList.map((c, i) => ({
      ...c,
      preview_url: charImgs[i].url,
      placeholder: charImgs[i].source === 'placeholder',
    }))
    const envConcepts = envList.map((e, i) => ({
      ...e,
      preview_url: envImgs[i].url,
      placeholder: envImgs[i].source === 'placeholder',
    }))

    res.status(200).json({
      success: true,
      character_concepts: charConcepts,
      environment_concepts: envConcepts,
      style_notes: concepts.style_notes || '',
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/sfx
router.post('/sfx', async (req, res, next) => {
  try {
    const { project_id } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const userPrompt = `Game: ${project.name}
Genre: ${project.concept?.project?.genre || project.genre}
Mechanics: ${JSON.stringify((project.concept?.mechanics || []).map(m => ({ name: m.name, description: m.description })))}
Audio direction: ${JSON.stringify(project.concept?.audio_direction || {})}
Characters: ${(project.concept?.characters || []).map(c => c.name).join(', ')}`

    let result
    try {
      result = await callLLM(SFX_SYSTEM_PROMPT, userPrompt, { step: 'pipeline_sfx', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    res.status(200).json({ success: true, sfx_pack: result.data.sfx_pack || [], implementation_notes: result.data.implementation_notes, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/backgrounds
router.post('/backgrounds', async (req, res, next) => {
  try {
    const { project_id } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const levels = project.concept?.levels || []
    if (levels.length === 0) {
      return res.status(400).json({ success: false, error: 'Project has no levels', code: 'VALIDATION_ERROR' })
    }

    const artDir = project.concept?.art_direction || {}
    const visualGuide = project.concept?.pipeline?.visual_guide || null

    // Build prompts from existing background_prompt + art style
    const userPrompt = `Game: ${project.name}, Art style: ${artDir.style || 'unspecified'}, Palette: ${artDir.palette || 'unspecified'}
Levels: ${JSON.stringify(levels.map(l => ({ name: l.name, environment: l.environment, background_prompt: l.background_prompt })))}`

    let promptResult
    try {
      promptResult = await callLLM(BACKGROUNDS_SYSTEM_PROMPT, userPrompt, { step: 'pipeline_backgrounds', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const bgList = promptResult.data.backgrounds || []

    const genId = Date.now().toString(36)
    const bgTasks = bgList.map((bg, i) => {
      const level = levels[i] || levels[0]
      const slug = `bg-${slugify(bg.level_name || level.name || `level${i}`)}`
      return {
        prompt: bg.prompt || level.background_prompt || bg.level_name,
        width: 1280, height: 640,
        storagePath: `projects/${project_id}/${slug}-${genId}.jpg`,
        _meta: { bg, level, slug },
      }
    })
    const bgImgs = await generateImagesSequential(bgTasks)
    const results = bgTasks.map((task, i) => {
      const { bg, level } = task._meta
      return {
        level_name: bg.level_name || level.name,
        environment: bg.environment || level.environment,
        prompt: task.prompt,
        layers: bg.layers || [],
        preview_url: bgImgs[i].url,
        placeholder: bgImgs[i].source === 'placeholder',
      }
    })

    res.status(200).json({ success: true, backgrounds: results })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/uiux
router.post('/uiux', async (req, res, next) => {
  try {
    const { project_id } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    const userPrompt = `Game: ${project.name}, Genre: ${project.concept?.project?.genre || project.genre}
Mechanics: ${(project.concept?.mechanics || []).map(m => m.name).join(', ')}
Art style: ${project.concept?.art_direction?.style || 'unspecified'}
UI style: ${project.concept?.art_direction?.ui_style || 'unspecified'}
Platform: ${project.concept?.project?.target_platform || 'PC'}`

    let result
    try {
      result = await callLLM(UIUX_SYSTEM_PROMPT, userPrompt, { step: 'pipeline_uiux', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }
    res.status(200).json({ success: true, uiux: result.data, meta: result.meta })
  } catch (err) { next(err) }
})

// POST /api/generate/icons
router.post('/icons', async (req, res, next) => {
  try {
    const { project_id } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    const userPrompt = `Game: ${project.name}, Genre: ${project.concept?.project?.genre || project.genre}
Mechanics: ${JSON.stringify((project.concept?.mechanics || []).map(m => ({ name: m.name, type: m.type })))}
Characters: ${(project.concept?.characters || []).map(c => c.name).join(', ')}
Art style: ${project.concept?.art_direction?.style || 'unspecified'}`

    let result
    try {
      result = await callLLM(ICONS_SYSTEM_PROMPT, userPrompt, { step: 'pipeline_icons', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }
    res.status(200).json({ success: true, icons: result.data, meta: result.meta })
  } catch (err) { next(err) }
})

// POST /api/generate/hud
router.post('/hud', async (req, res, next) => {
  try {
    const { project_id } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    const userPrompt = `Game: ${project.name}, Genre: ${project.concept?.project?.genre || project.genre}
Mechanics: ${JSON.stringify((project.concept?.mechanics || []).map(m => ({ name: m.name, description: m.description })))}
Core loop: ${project.concept?.project?.core_loop || ''}
Platform: ${project.concept?.project?.target_platform || 'PC'}
Art style: ${project.concept?.art_direction?.style || 'unspecified'}`

    let result
    try {
      result = await callLLM(HUD_SYSTEM_PROMPT, userPrompt, { step: 'pipeline_hud', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }
    res.status(200).json({ success: true, hud: result.data, meta: result.meta })
  } catch (err) { next(err) }
})

// Shared helper: generate a doc-only node result (no images)
async function generateDocNode(systemPrompt, userPrompt, stepKey, res) {
  let result
  try {
    result = await callLLM(systemPrompt, userPrompt, { step: 'pipeline_3d', maxOutputTokens: 4096 })
  } catch (err) {
    const isRateLimit = err.status === 429 || err.code === 'RATE_LIMIT'
    const isMaxTokens = err.code === 'MAX_TOKENS'
    const isInvalidJson = err.code === 'INVALID_JSON'
    res.status(502).json({
      success: false,
      error: isRateLimit   ? 'Rate limit reached. Try again later.'
           : isMaxTokens   ? 'Response too long. Try again or simplify the project.'
           : isInvalidJson ? 'LLM returned malformed JSON. Try again.'
           : 'LLM API call failed',
      code: isRateLimit ? 'RATE_LIMIT' : isMaxTokens ? 'MAX_TOKENS' : isInvalidJson ? 'INVALID_JSON' : 'LLM_ERROR'
    })
    return null
  }
  return result.data
}

function makeDocRoute(stepKey, systemPrompt, buildUserPrompt) {
  router.post(`/${stepKey}`, async (req, res, next) => {
    try {
      const { project_id } = req.body
      if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
      const { data: project, error } = await db().from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
      if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
      const data = await generateDocNode(systemPrompt, buildUserPrompt(project), stepKey, res)
      if (!data) return
      res.status(200).json({ success: true, [stepKey]: data })
    } catch (err) { next(err) }
  })
}

const baseCtx = (project) =>
  `Game: ${project.name}, Genre: ${project.concept?.project?.genre || project.genre}, Engine: ${project.concept?.development?.suggested_engine || project.target_engine}`

makeDocRoute('modeling', MODELING_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nCharacters: ${JSON.stringify((p.concept?.characters || []).map(c => ({ name: c.name, role: c.role })))}\nLevels: ${(p.concept?.levels || []).map(l => l.environment).join(', ')}`)

makeDocRoute('charaters', CHARACTERS3D_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nCharacters: ${JSON.stringify((p.concept?.characters || []).map(c => ({ name: c.name, role: c.role, description: c.description })))}`)

makeDocRoute('vfx', VFX_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nMechanics: ${(p.concept?.mechanics || []).map(m => m.name).join(', ')}\nTone: ${p.concept?.project?.tone || ''}`)

makeDocRoute('texturing', TEXTURING_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nArt style: ${p.concept?.art_direction?.style || 'unspecified'}\nCharacters: ${(p.concept?.characters || []).map(c => c.name).join(', ')}`)

makeDocRoute('rigging', RIGGING_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nCharacters: ${JSON.stringify((p.concept?.characters || []).map(c => ({ name: c.name, role: c.role })))}`)

makeDocRoute('lighting', LIGHTING_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nLevels: ${JSON.stringify((p.concept?.levels || []).map(l => ({ name: l.name, environment: l.environment })))}\nArt style: ${p.concept?.art_direction?.style || ''}`)

makeDocRoute('animation', ANIMATION_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nCharacters: ${JSON.stringify((p.concept?.characters || []).map(c => ({ name: c.name, role: c.role })))}\nMechanics: ${(p.concept?.mechanics || []).map(m => m.name).join(', ')}`)

makeDocRoute('cinematics', CINEMATICS_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nCharacters: ${JSON.stringify((p.concept?.characters || []).map(c => ({ name: c.name, role: c.role })))}\nLevels: ${(p.concept?.levels || []).map(l => l.name).join(', ')}\nCore loop: ${p.concept?.project?.core_loop || ''}`)

makeDocRoute('voice', VOICE_SYSTEM_PROMPT, (p) =>
  `${baseCtx(p)}\nCharacters: ${JSON.stringify((p.concept?.characters || []).map(c => ({ name: c.name, role: c.role, personality: c.personality, description: c.description })))}\nTone: ${p.concept?.project?.tone || ''}`)

module.exports = router
