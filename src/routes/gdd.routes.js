const express = require('express')
const path = require('path')
const router = express.Router()
const { callLLM } = require('../services/llm.service')
const { buildCodePrompt } = require('../prompts/code.prompt')
const { getPrompt } = require('../services/prompt.service')
const { db } = require('../services/supabase.service')
const { ensureProjectDir, getAssetUrl, slugify, clearNodeStorage, STORAGE_BASE } = require('../services/storage.service')
const { generateImagesSequential, generateImageForNode } = require('../services/image.service')
const { validateStepConfig, getWorkflowById } = require('../services/config.service')
const { generateImageComfyUI } = require('../services/providers/comfyui.provider')
const { callN8n } = require('../services/n8n.service')
const { makeTimer } = require('../utils/timer')

function llmErr(err) {
  if (err.status === 429 || err.status === 503 || err.code === 'RATE_LIMIT') return { status: 502, error: 'Model is busy — try again in a few seconds.', code: 'RATE_LIMIT' }
  if (err.code === 'MAX_TOKENS')   return { status: 502, error: 'Response too long. Try again or simplify the project.', code: 'MAX_TOKENS' }
  if (err.code === 'INVALID_JSON') return { status: 502, error: 'LLM returned malformed JSON. Try again.', code: 'INVALID_JSON' }
  return { status: 502, error: 'LLM API call failed', code: 'LLM_ERROR' }
}

// Sends project_id + step_key + input_context to n8n and proxies the response.
// Returns true if response was handled (caller should return immediately).
async function tryN8n(config, project_id, step_key, input_context, res) {
  if (config.integration_type !== 'n8n') return false
  try {
    const data = await callN8n(config.webhook_url, { project_id, step_key, input_context })
    res.status(200).json(data)
  } catch (err) {
    res.status(502).json({ success: false, error: err.message, code: err.code || 'N8N_ERROR' })
  }
  return true
}

// Unified GDD accessor — all node outputs live in concept.pipeline.gdd
const gddOf = (concept) => concept?.pipeline?.gdd || {}

// Builds a style prefix from GDD art direction + ADI to keep all generated images visually coherent
function styleContext(gdd, adi) {
  const style   = adi?.visual_style?.style_name   || gdd?.art_direction?.style   || ''
  const palette = adi?.visual_style?.color_palette || gdd?.art_direction?.palette || ''
  const mood    = adi?.visual_style?.mood          || gdd?.art_direction?.mood    || ''
  return [style, palette, mood].filter(Boolean).join(', ')
}

// Prepends style context to a prompt — no-op if context is empty
function withStyle(prompt, styleCtx) {
  if (!styleCtx || !prompt) return prompt || ''
  return `${styleCtx} — ${prompt}`
}

// POST /api/generate/gdd
router.post('/gdd', async (req, res, next) => {
  try {
    const { prompt, project_id } = req.body

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ success: false, error: 'prompt is required', code: 'VALIDATION_ERROR' })
    }
    if (prompt.length < 10 || prompt.length > 1000) {
      return res.status(400).json({ success: false, error: 'prompt must be 10–1000 characters', code: 'VALIDATION_ERROR' })
    }

    const timer = makeTimer('GDD')

    const checkGdd = await validateStepConfig('gdd')
    if (!checkGdd.valid) return res.status(422).json({ success: false, error: checkGdd.error, code: checkGdd.code })
    timer.lap('validate config')

    const config = checkGdd.config

    if (config.integration_type === 'comfyui') {
      return res.status(422).json({
        success: false,
        error: 'Step "gdd" is configured as ComfyUI but GDD generates a text document. Change integration type to llm or n8n in Admin → Integrations.',
        code: 'STEP_MISCONFIGURED',
      })
    }

    // ── get GDD document (n8n or llm) ─────────────────────────────────────────
    let gdd, meta = {}

    if (config.integration_type === 'n8n') {
      try {
        const data = await callN8n(config.webhook_url, { project_id, step_key: 'gdd', input_context: { prompt } })
        gdd = data.gdd || data
        meta = data.meta || {}
        timer.lap('n8n webhook')
      } catch (err) {
        return res.status(502).json({ success: false, error: err.message, code: err.code || 'N8N_ERROR' })
      }
    } else {
      let result
      try {
        let projectName = null
        if (project_id) {
          const { data: proj } = await db().from('projects').select('name').eq('id', project_id).single()
          projectName = proj?.name || null
        }
        const namePrefix = projectName ? `The game title is "${projectName}". Use this exact name in the GDD. ` : ''
        result = await callLLM(await getPrompt('gdd'), `${namePrefix}Generate a complete Game Design Document for this game idea: ${prompt}`, {
          step: 'gdd',
          maxOutputTokens: 32768
        })
        timer.lap('LLM generation')
      } catch (err) {
        console.error(`[GDD] LLM error — ${err.message} (status=${err.status} code=${err.code})`)
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
      gdd  = result.data
      meta = result.meta

    }

    // ── image generation for characters and levels (if enabled + project exists) ─
    if (config.image_enabled && project_id && gdd) {
      await clearNodeStorage(project_id, 'gdd')

      // All image tasks in one pool — ComfyUI cloud handles 2 concurrent jobs max
      const imageTasks = [
        ...(Array.isArray(gdd.characters) ? gdd.characters.filter(c => c.sprite_prompt).map(char => async () => {
          const img = await generateImageForNode('gdd', char.sprite_prompt, 1024, 1024, `projects/${project_id}/gdd/characters/${slugify(char.name || 'char')}.jpg`)
          if (img?.url) char.preview_url = img.url
        }) : []),
        ...(Array.isArray(gdd.levels) ? gdd.levels.filter(l => l.background_prompt).map(level => async () => {
          const img = await generateImageForNode('gdd', level.background_prompt, 1024, 512, `projects/${project_id}/gdd/levels/${slugify(level.name || 'level')}.jpg`)
          if (img?.url) level.preview_url = img.url
        }) : []),
      ]

      // Concurrency-limited runner: max 2 parallel to match ComfyUI cloud slot limit
      const CONCURRENCY = 1
      let idx = 0
      async function worker() {
        while (idx < imageTasks.length) {
          const task = imageTasks[idx++]
          await task()
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      timer.lap(`images total (${imageTasks.length})`)
    }

    timer.end()
    res.status(201).json({ success: true, gdd, meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/sprites
router.post('/sprites', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body

    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const check = await validateStepConfig('sprites')
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })
    if (await tryN8n(check.config, project_id, 'sprites', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const characters = gdd.characters || []
    if (characters.length === 0) {
      return res.status(400).json({ success: false, error: 'Project has no characters in concept', code: 'VALIDATION_ERROR' })
    }

    const adi = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const styleCtx = styleContext(gdd, adi)
    await clearNodeStorage(project_id, 'sprites')
    const tasks = characters.map(char => ({
      prompt: withStyle(char.sprite_prompt || char.name, styleCtx),
      width: 512, height: 512,
      storagePath: `projects/${project_id}/sprites/char-${slugify(char.name)}/sprite.jpg`,
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
    const { project_id, input_context } = req.body

    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }
    const checkLevels = await validateStepConfig('levels')
    if (!checkLevels.valid) return res.status(422).json({ success: false, error: checkLevels.error, code: checkLevels.code })
    if (await tryN8n(checkLevels.config, project_id, 'levels', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const adi = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const levels = gdd.levels || []
    if (levels.length === 0) {
      return res.status(400).json({ success: false, error: 'Project has no levels in concept', code: 'VALIDATION_ERROR' })
    }

    const adiContext = adi ? `\nArt direction: style=${adi.visual_style?.style_name || ''}, palette=${adi.visual_style?.color_palette || ''}, mood=${adi.visual_style?.mood || ''}, lighting=${adi.environment_art?.lighting_style || ''}` : ''

    let result
    try {
      result = await callLLM(
        await getPrompt('levels'),
        `Expand these levels for the game "${project.name}". Characters available: ${JSON.stringify(gdd.characters?.map(c => c.name))}.${adiContext} Levels: ${JSON.stringify(levels)}`,
        { step: 'levels', maxOutputTokens: 8192 }
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
    const styleCtx = styleContext(gdd, adi)
    await clearNodeStorage(project_id, 'levels')
    const expandedLevels = await Promise.all(
      levelList.map(async (level, i) => {
        const storagePath = `projects/${project_id}/levels/level-${slugify(level.name)}/map.jpg`
        const img = await generateImageForNode('levels', withStyle(level.background_prompt || level.name, styleCtx), 1280, 640, storagePath)
        return { ...level, preview_url: img.url }
      })
    )

    res.status(200).json({ success: true, levels: expandedLevels, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/code
router.post('/code', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body

    if (!project_id) {
      return res.status(400).json({
        success: false,
        error: 'project_id is required',
        code: 'VALIDATION_ERROR'
      })
    }
    const checkCode = await validateStepConfig('code')
    if (!checkCode.valid) return res.status(422).json({ success: false, error: checkCode.error, code: checkCode.code })
    if (await tryN8n(checkCode.config, project_id, 'code', input_context, res)) return

    const { data: project, error } = await db()
      .from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({
        success: false, error: 'Project not found', code: 'NOT_FOUND'
      })
    }

    const targetEngine = project.target_engine || 'unity'
    const gdd = input_context?.gdd ?? gddOf(project.concept)

    const gameContext = {
      name: gdd.project?.name,
      genre: gdd.project?.genre,
      core_loop: gdd.project?.core_loop,
      tone: gdd.project?.tone,
      target_engine: targetEngine,
      mechanics: gdd.mechanics?.slice(0, 3).map(m => ({
        name: m.name,
        type: m.type,
        description: m.description
      })),
      characters: gdd.characters?.map(c => ({
        name: c.name,
        role: c.role,
        abilities: c.abilities?.slice(0, 3),
        description: c.description?.slice(0, 150)
      })),
      levels: gdd.levels?.slice(0, 3).map(l => ({
        name: l.name,
        difficulty: l.difficulty,
        environment: l.environment
      })),
      art_direction: {
        style: gdd.art_direction?.style,
        resolution: gdd.art_direction?.resolution
      }
    }

    const systemPrompt = buildCodePrompt(targetEngine, gameContext)

    let result
    try {
      result = await callLLM(
        systemPrompt,
        `Generate the ${targetEngine} scripts for: ${gameContext.name}`,
        { step: 'code', maxOutputTokens: 8000 }
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
        content: file.content || ''
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
    const { project_id, input_context } = req.body

    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }
    const checkAudio = await validateStepConfig('audio')
    if (!checkAudio.valid) return res.status(422).json({ success: false, error: checkAudio.error, code: checkAudio.code })
    if (await tryN8n(checkAudio.config, project_id, 'audio', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    let result
    try {
      result = await callLLM(
        await getPrompt('audio'),
        `Generate a complete audio design plan for this game: ${JSON.stringify(gdd)}`,
        { step: 'audio', maxOutputTokens: 4096 }
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
    const { project_id, input_context } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }
    const checkVg = await validateStepConfig('visual_guide')
    if (!checkVg.valid) return res.status(422).json({ success: false, error: checkVg.error, code: checkVg.code })
    if (await tryN8n(checkVg.config, project_id, 'visual_guide', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const adi = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const artDir = gdd.art_direction || {}
    const projInfo = gdd.project || {}

    const userPrompt = `Generate a Visual Style Guide for this game:
Title: ${projInfo.name || project.name}
Genre: ${projInfo.genre || project.genre}
Tone: ${projInfo.tone || 'neutral'}
Art style: ${artDir.style || adi?.visual_style?.style_name || 'unspecified'}
Palette: ${artDir.palette || adi?.visual_style?.color_palette || 'unspecified'}
Lighting: ${artDir.lighting_style || 'unspecified'}
References: ${(artDir.references || []).join(', ') || 'none'}
Description: ${projInfo.elevator_pitch || ''}${adi ? `\nArt direction pillars: ${(adi.art_direction_pillars || []).map(p => p.name).join(', ')}` : ''}`

    let result
    try {
      result = await callLLM(await getPrompt('visual_guide'), userPrompt, { step: 'visual_guide', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    res.status(200).json({ success: true, visual_guide: result.data, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/art-direction-intake
router.post('/art-direction-intake', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }
    const checkAdi = await validateStepConfig('art_direction_intake')
    if (!checkAdi.valid) return res.status(422).json({ success: false, error: checkAdi.error, code: checkAdi.code })
    if (await tryN8n(checkAdi.config, project_id, 'art_direction_intake', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const userPrompt = `Analyze this Game Design Document and generate the Art Direction Intake Document:\n\n${JSON.stringify(gdd, null, 2)}`

    let result
    try {
      result = await callLLM(await getPrompt('art_direction_intake'), userPrompt, { step: 'art_direction_intake', maxOutputTokens: 6144 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    res.status(200).json({ success: true, art_direction_intake: result.data, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/concept-art
router.post('/concept-art', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }

    const check = await validateStepConfig('concept_art')
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })
    if (await tryN8n(check.config, project_id, 'concept_art', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const adi = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const vg  = input_context?.visual_guide ?? project.concept?.pipeline?.visual_guide
    const userPrompt = `Game: ${project.name}
Genre: ${gdd.project?.genre || project.genre}
Art style: ${gdd.art_direction?.style || adi?.visual_style?.style_name || 'unspecified'}
${vg ? `Visual style guide: ${JSON.stringify({ style_summary: vg.style_summary, sprite_rules: vg.sprite_rules?.slice(0, 3) })}` : ''}
${adi ? `Art direction pillars: ${(adi.art_direction_pillars || []).map(p => `${p.name}: ${p.description}`).join(' | ')}` : ''}
Characters: ${JSON.stringify((gdd.characters || []).map(c => ({ name: c.name, role: c.role, description: c.description })))}
Levels/environments: ${JSON.stringify((gdd.levels || []).map(l => ({ name: l.name, environment: l.environment })))}`

    let promptResult
    try {
      promptResult = await callLLM(await getPrompt('concept_art'), userPrompt, { step: 'concept_art', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const concepts = promptResult.data

    // Generate images sequentially to avoid Pollinations rate limiting
    const charList = concepts.character_concepts || []
    const envList  = concepts.environment_concepts || []

    const styleCtx = styleContext(gdd, adi)
    await clearNodeStorage(project_id, 'concept_art')
    const charTasks = charList.map(c => ({
      prompt: withStyle(c.prompt, styleCtx), width: 512, height: 512,
      storagePath: `projects/${project_id}/concept_art/char-${slugify(c.name)}/concept.jpg`,
    }))
    const envTasks = envList.map(e => ({
      prompt: withStyle(e.prompt, styleCtx), width: 768, height: 512,
      storagePath: `projects/${project_id}/concept_art/env-${slugify(e.name)}/concept.jpg`,
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
    const { project_id, input_context } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }
    const checkSfx = await validateStepConfig('sfx')
    if (!checkSfx.valid) return res.status(422).json({ success: false, error: checkSfx.error, code: checkSfx.code })
    if (await tryN8n(checkSfx.config, project_id, 'sfx', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const userPrompt = `Game: ${project.name}
Genre: ${gdd.project?.genre || project.genre}
Mechanics: ${JSON.stringify((gdd.mechanics || []).map(m => ({ name: m.name, description: m.description })))}
Audio direction: ${JSON.stringify(gdd.audio_direction || {})}
Characters: ${(gdd.characters || []).map(c => c.name).join(', ')}`

    let result
    try {
      result = await callLLM(await getPrompt('sfx'), userPrompt, { step: 'sfx', maxOutputTokens: 4096 })
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
    const { project_id, input_context } = req.body
    if (!project_id) {
      return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    }
    const check = await validateStepConfig('backgrounds')
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })
    if (await tryN8n(check.config, project_id, 'backgrounds', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    // Accept levels from a connected levels node in the canvas context
    const levelsData = input_context?.levels ?? null
    const levels = (levelsData?.approved_levels ?? levelsData?.levels ?? levelsData) || gdd.levels || []
    if (!Array.isArray(levels) || levels.length === 0) {
      return res.status(400).json({ success: false, error: 'Project has no levels', code: 'VALIDATION_ERROR' })
    }

    const vg = input_context?.visual_guide ?? project.concept?.pipeline?.visual_guide
    const artDir = gdd.art_direction || {}

    const userPrompt = `Game: ${project.name}, Art style: ${artDir.style || vg?.style_summary || 'unspecified'}, Palette: ${artDir.palette || vg?.palette?.map(p => p.hex).join(', ') || 'unspecified'}
${vg ? `Background rules: ${(vg.background_rules || []).slice(0, 3).join(' | ')}` : ''}
Levels: ${JSON.stringify(levels.map(l => ({ name: l.name, environment: l.environment, background_prompt: l.background_prompt })))}`

    let promptResult
    try {
      promptResult = await callLLM(await getPrompt('backgrounds'), userPrompt, { step: 'backgrounds', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const bgList = promptResult.data.backgrounds || []
    const styleCtx = styleContext(gdd, input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake)

    await clearNodeStorage(project_id, 'backgrounds')
    const bgTasks = bgList.map((bg, i) => {
      const level = levels[i] || levels[0]
      const slug = `bg-${slugify(bg.level_name || level.name || `level${i}`)}`
      return {
        prompt: withStyle(bg.prompt || level.background_prompt || bg.level_name, styleCtx),
        width: 1280, height: 640,
        storagePath: `projects/${project_id}/backgrounds/${slug}/bg.jpg`,
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
    const { project_id, input_context } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    const checkUiux = await validateStepConfig('uiux')
    if (!checkUiux.valid) return res.status(422).json({ success: false, error: checkUiux.error, code: checkUiux.code })
    if (await tryN8n(checkUiux.config, project_id, 'uiux', input_context, res)) return
    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const adi = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const vg  = input_context?.visual_guide ?? project.concept?.pipeline?.visual_guide
    const userPrompt = `Game: ${project.name}, Genre: ${gdd.project?.genre || project.genre}
Mechanics: ${(gdd.mechanics || []).map(m => m.name).join(', ')}
Art style: ${gdd.art_direction?.style || adi?.visual_style?.style_name || 'unspecified'}
UI style: ${gdd.art_direction?.ui_style || adi?.ui_visual_direction?.style || 'unspecified'}
${adi?.ui_visual_direction ? `UI direction: palette_notes=${adi.ui_visual_direction.palette_notes}, hud_philosophy=${adi.ui_visual_direction.hud_philosophy}` : ''}
${vg ? `Visual style: ${vg.style_summary?.slice(0, 200) || ''}` : ''}
Platform: ${gdd.project?.target_platform || 'PC'}`

    let result
    try {
      result = await callLLM(await getPrompt('uiux'), userPrompt, { step: 'uiux', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const screens = result.data?.screens || []
    const styleCtx = styleContext(gdd, adi)
    await clearNodeStorage(project_id, 'uiux')
    const screensWithImages = await Promise.all(
      screens.map(async (screen, i) => {
        const slug = slugify(screen.name || `screen_${i}`)
        const storagePath = `projects/${project_id}/uiux/${slug}.png`
        const img = await generateImageForNode('uiux', withStyle(screen.image_prompt || screen.description || screen.name, styleCtx), 1280, 720, storagePath)
        return { ...screen, image_url: img.url }
      })
    )

    res.status(200).json({ success: true, uiux: { ...result.data, screens: screensWithImages }, meta: result.meta })
  } catch (err) { next(err) }
})

// POST /api/generate/icons
router.post('/icons', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    const checkIcons = await validateStepConfig('icons')
    if (!checkIcons.valid) return res.status(422).json({ success: false, error: checkIcons.error, code: checkIcons.code })
    if (await tryN8n(checkIcons.config, project_id, 'icons', input_context, res)) return
    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const adi = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const uiux = input_context?.uiux ?? project.concept?.pipeline?.uiux
    const userPrompt = `Game: ${project.name}, Genre: ${gdd.project?.genre || project.genre}
Mechanics: ${JSON.stringify((gdd.mechanics || []).map(m => ({ name: m.name, type: m.type })))}
Characters: ${(gdd.characters || []).map(c => c.name).join(', ')}
Art style: ${gdd.art_direction?.style || adi?.visual_style?.style_name || 'unspecified'}
${uiux ? `Icon style from UI/UX: ${uiux.design_system?.icon_style || 'unspecified'}` : ''}
${adi?.ui_visual_direction?.iconography_style ? `Iconography style: ${adi.ui_visual_direction.iconography_style}` : ''}`

    let result
    try {
      result = await callLLM(await getPrompt('icons'), userPrompt, { step: 'icons', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const icons = result.data?.icons || []
    const styleCtx = styleContext(gdd, adi)
    await clearNodeStorage(project_id, 'icons')
    const iconResults = await Promise.all(
      icons.map(async (icon, i) => {
        const slug = slugify(icon.name || `icon_${i}`)
        const storagePath = `projects/${project_id}/icons/${slug}/icon.png`
        const img = await generateImageForNode('icons', withStyle(icon.prompt || icon.description || icon.name, styleCtx), 1024, 1024, storagePath)
        return { ...icon, image_url: img.url }
      })
    )

    res.status(200).json({
      success: true,
      icons: { ...result.data, icons: iconResults },
      meta: result.meta,
    })
  } catch (err) { next(err) }
})

// POST /api/generate/hud
router.post('/hud', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    const checkHud = await validateStepConfig('hud')
    if (!checkHud.valid) return res.status(422).json({ success: false, error: checkHud.error, code: checkHud.code })
    if (await tryN8n(checkHud.config, project_id, 'hud', input_context, res)) return
    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const adi = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const uiux = input_context?.uiux ?? project.concept?.pipeline?.uiux
    const userPrompt = `Game: ${project.name}, Genre: ${gdd.project?.genre || project.genre}
Mechanics: ${JSON.stringify((gdd.mechanics || []).map(m => ({ name: m.name, description: m.description })))}
Core loop: ${gdd.project?.core_loop || ''}
Platform: ${gdd.project?.target_platform || 'PC'}
Art style: ${gdd.art_direction?.style || adi?.visual_style?.style_name || 'unspecified'}
${uiux ? `HUD elements from UI/UX: ${(uiux.hud_elements || []).join(', ')}` : ''}
${adi?.ui_visual_direction?.hud_philosophy ? `HUD philosophy: ${adi.ui_visual_direction.hud_philosophy}` : ''}`

    let result
    try {
      result = await callLLM(await getPrompt('hud'), userPrompt, { step: 'hud', maxOutputTokens: 4096 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const data = result.data
    const styleCtx = styleContext(gdd, adi)
    await clearNodeStorage(project_id, 'hud')
    const storagePath = `projects/${project_id}/hud/layout.png`
    const img = await generateImageForNode('hud', withStyle(data.image_prompt || `HUD layout for ${project.name}: ${data.layout?.description || ''}`, styleCtx), 1920, 1080, storagePath)

    res.status(200).json({ success: true, hud: { ...data, image_url: img.url }, meta: result.meta })
  } catch (err) { next(err) }
})

// POST /api/generate/splash-art
router.post('/splash-art', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    const checkSplash = await validateStepConfig('splash')
    if (!checkSplash.valid) return res.status(422).json({ success: false, error: checkSplash.error, code: checkSplash.code })
    if (await tryN8n(checkSplash.config, project_id, 'splash_art', input_context, res)) return
    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    const gdd   = input_context?.gdd ?? gddOf(project.concept)
    const adi   = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const sm    = adi?.splash_and_marketing || {}
    const chars = (gdd.characters || []).slice(0, 3).map(c => `${c.name}: ${c.description || c.role || ''}`).join('\n')
    const levels = (gdd.levels || []).slice(0, 3).map(l => l.name).join(', ')

    const userPrompt = `Game: ${project.name}
Genre: ${gdd.project?.genre || project.genre}
Tone: ${gdd.project?.tone || ''}
Art style: ${gdd.art_direction?.style || adi?.visual_style?.style_name || 'unspecified'}
Color palette: ${gdd.art_direction?.color_palette || adi?.visual_style?.color_palette || ''}
Main characters: ${chars || 'not specified'}
Key settings: ${levels || 'not specified'}
Key art direction: ${sm.key_art_direction || ''}
Composition notes: ${sm.composition_notes || ''}
Brand identity: ${sm.brand_identity || ''}`

    let result
    try {
      result = await callLLM(await getPrompt('splash'), userPrompt, { step: 'splash', maxOutputTokens: 2048 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const data = result.data
    const styleCtx = styleContext(gdd, adi)
    await clearNodeStorage(project_id, 'splash_art')
    const storagePath = `projects/${project_id}/splash_art/hero.png`
    const img = await generateImageForNode('splash', withStyle(data.image_prompt, styleCtx), 1792, 1024, storagePath)

    res.status(200).json({ success: true, splash_art: { ...data, image_url: img.url }, meta: result.meta })
  } catch (err) { next(err) }
})

// POST /api/generate/marketing
router.post('/marketing', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
    const checkMarketing = await validateStepConfig('marketing')
    if (!checkMarketing.valid) return res.status(422).json({ success: false, error: checkMarketing.error, code: checkMarketing.code })
    if (await tryN8n(checkMarketing.config, project_id, 'marketing', input_context, res)) return
    const { data: project, error } = await db().from('projects').select('id, name, genre, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    const gdd      = input_context?.gdd ?? gddOf(project.concept)
    const adi      = input_context?.art_direction_intake ?? project.concept?.pipeline?.art_direction_intake
    const sm       = adi?.splash_and_marketing || {}
    const splashArt = input_context?.splash_art ?? project.concept?.pipeline?.splash_art

    const userPrompt = `Game: ${project.name}
Genre: ${gdd.project?.genre || project.genre}
Tone: ${gdd.project?.tone || ''}
Target platform: ${gdd.project?.target_platform || 'PC'}
Art style: ${gdd.art_direction?.style || adi?.visual_style?.style_name || 'unspecified'}
Color palette: ${gdd.art_direction?.color_palette || adi?.visual_style?.color_palette || ''}
Brand identity: ${sm.brand_identity || ''}
Social format guidance: ${sm.social_format_guidance || ''}
${splashArt?.image_prompt ? `Splash art reference prompt: ${splashArt.image_prompt}` : ''}`

    let result
    try {
      result = await callLLM(await getPrompt('marketing'), userPrompt, { step: 'marketing', maxOutputTokens: 6144 })
    } catch (err) {
      const { status, ...body } = llmErr(err)
      return res.status(status).json({ success: false, ...body })
    }

    const assets = result.data?.assets || []
    const styleCtx = styleContext(gdd, adi)
    await clearNodeStorage(project_id, 'marketing')
    const assetResults = []
    for (const asset of assets) {
      const storagePath = `projects/${project_id}/marketing/${asset.name}/asset.png`
      const img = await generateImageForNode('marketing', withStyle(asset.image_prompt, styleCtx), asset.width, asset.height, storagePath)
      assetResults.push({ ...asset, image_url: img.url })
    }

    res.status(200).json({
      success: true,
      marketing: { ...result.data, assets: assetResults },
      meta: result.meta,
    })
  } catch (err) { next(err) }
})

// Shared helper: generate a doc-only node result (no images)
async function generateDocNode(systemPrompt, userPrompt, stepKey, res) {
  const check = await validateStepConfig(stepKey)
  if (!check.valid) {
    res.status(422).json({ success: false, error: check.error, code: check.code })
    return null
  }

  let result
  try {
    result = await callLLM(systemPrompt, userPrompt, { step: stepKey, maxOutputTokens: 4096 })
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

function makeDocRoute(stepKey, promptKey, buildUserPrompt) {
  router.post(`/${stepKey}`, async (req, res, next) => {
    try {
      const { project_id, input_context } = req.body
      if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })
      const check = await validateStepConfig(stepKey)
      if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })
      if (await tryN8n(check.config, project_id, stepKey, input_context, res)) return
      const { data: project, error } = await db().from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
      if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
      const systemPrompt = await getPrompt(promptKey)
      const data = await generateDocNode(systemPrompt, buildUserPrompt(project, input_context), stepKey, res)
      if (!data) return
      res.status(200).json({ success: true, [stepKey]: data })
    } catch (err) { next(err) }
  })
}

const baseCtx = (project, gdd) => {
  return `Game: ${project.name}, Genre: ${gdd.project?.genre || project.genre}, Engine: ${gdd.development?.suggested_engine || project.target_engine}`
}

makeDocRoute('modeling', 'modeling', (p, ctx) => {
  const gdd = ctx?.gdd ?? gddOf(p.concept)
  return `${baseCtx(p, gdd)}\nCharacters: ${JSON.stringify((gdd.characters || []).map(c => ({ name: c.name, role: c.role })))}\nLevels: ${(gdd.levels || []).map(l => l.environment).join(', ')}`
})

// ── charaters — custom route with per-character ComfyUI image generation ──────
router.post('/charaters', async (req, res, next) => {
  try {
    const { project_id, input_context } = req.body
    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required', code: 'VALIDATION_ERROR' })

    const check = await validateStepConfig('charaters')
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })
    if (await tryN8n(check.config, project_id, 'charaters', input_context, res)) return

    const { data: project, error } = await db().from('projects').select('id, name, genre, target_engine, concept').eq('id', project_id).single()
    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })

    // Require image_reference to be connected and approved
    if (!input_context?.image_reference) {
      return res.status(422).json({
        success: false,
        error: 'The "Image Reference" node must be connected to this node in the pipeline.',
        code: 'DEPENDENCY_NOT_CONNECTED',
      })
    }
    if (!project.concept?.pipeline?.image_reference?.approved) {
      return res.status(422).json({
        success: false,
        error: 'The "Image Reference" node must be approved before generating characters.',
        code: 'DEPENDENCY_NOT_MET',
      })
    }

    const gdd = input_context?.gdd ?? gddOf(project.concept)
    const userPrompt = `${baseCtx(project, gdd)}\nCharacters: ${JSON.stringify((gdd.characters || []).map(c => ({ name: c.name, role: c.role, description: c.description })))}`
    const data = await generateDocNode(await getPrompt('charaters'), userPrompt, 'charaters', res)
    if (!data) return

    // ── per-character ComfyUI image generation ─────────────────────────────
    const config = check.config
    if (config.image_enabled && config.image_integration_type === 'comfyui' && config.image_workflow_id) {
      const workflow = await getWorkflowById(config.image_workflow_id)
      if (!workflow) {
        console.warn('[charaters] ComfyUI workflow not found:', config.image_workflow_id)
        return res.status(200).json({ success: true, charaters: data })
      }

      const characters  = gdd.characters || []
      const namesStr    = JSON.stringify(characters.map(c => c.name))
      const promptsStr  = JSON.stringify(characters.map(c => c.sprite_prompt || c.name))

      for (let i = 0; i < characters.length; i++) {
        const char    = characters[i]
        const charKey = char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

        // Approved reference images for this character
        const { data: refs } = await db()
          .from('character_image_refs')
          .select('image_url')
          .eq('project_id', project_id)
          .eq('character_key', charKey)
          .eq('selected', true)
          .order('created_at', { ascending: true })
          .limit(2)

        const refA = refs?.[0]?.image_url || ''
        const refB = refs?.[1]?.image_url || refA

        const storagePath = `projects/${project_id}/charaters/${charKey}_${Date.now()}.png`
        try {
          const result = await generateImageComfyUI(workflow.name, '', 1024, 1024, storagePath, {
            char_index:   i,
            names_list:   namesStr,
            prompts_list: promptsStr,
            ref_image_a:  refA,
            ref_image_b:  refB,
          })
          console.log(`[charaters] ${char.name} → ${result.url}`)
        } catch (e) {
          console.error(`[charaters] image failed for "${char.name}":`, e.message)
        }
      }
    }

    res.status(200).json({ success: true, charaters: data })
  } catch (err) { next(err) }
})

makeDocRoute('vfx', 'vfx', (p, ctx) => {
  const gdd = ctx?.gdd ?? gddOf(p.concept)
  return `${baseCtx(p, gdd)}\nMechanics: ${(gdd.mechanics || []).map(m => m.name).join(', ')}\nTone: ${gdd.project?.tone || ''}`
})

makeDocRoute('texturing', 'texturing', (p, ctx) => {
  const gdd = ctx?.gdd ?? gddOf(p.concept)
  return `${baseCtx(p, gdd)}\nArt style: ${gdd.art_direction?.style || 'unspecified'}\nCharacters: ${(gdd.characters || []).map(c => c.name).join(', ')}`
})

makeDocRoute('rigging', 'rigging', (p, ctx) => {
  const gdd = ctx?.gdd ?? gddOf(p.concept)
  return `${baseCtx(p, gdd)}\nCharacters: ${JSON.stringify((gdd.characters || []).map(c => ({ name: c.name, role: c.role })))}`
})

makeDocRoute('lighting', 'lighting', (p, ctx) => {
  const gdd = ctx?.gdd ?? gddOf(p.concept)
  return `${baseCtx(p, gdd)}\nLevels: ${JSON.stringify((gdd.levels || []).map(l => ({ name: l.name, environment: l.environment })))}\nArt style: ${gdd.art_direction?.style || ''}`
})

makeDocRoute('animation', 'animation', (p, ctx) => {
  const gdd = ctx?.gdd ?? gddOf(p.concept)
  return `${baseCtx(p, gdd)}\nCharacters: ${JSON.stringify((gdd.characters || []).map(c => ({ name: c.name, role: c.role })))}\nMechanics: ${(gdd.mechanics || []).map(m => m.name).join(', ')}`
})

makeDocRoute('cinematics', 'cinematics', (p, ctx) => {
  const gdd = ctx?.gdd ?? gddOf(p.concept)
  return `${baseCtx(p, gdd)}\nCharacters: ${JSON.stringify((gdd.characters || []).map(c => ({ name: c.name, role: c.role })))}\nLevels: ${(gdd.levels || []).map(l => l.name).join(', ')}\nCore loop: ${gdd.project?.core_loop || ''}`
})

makeDocRoute('voice', 'voice', (p, ctx) => {
  const gdd = ctx?.gdd ?? gddOf(p.concept)
  return `${baseCtx(p, gdd)}\nCharacters: ${JSON.stringify((gdd.characters || []).map(c => ({ name: c.name, role: c.role, personality: c.personality, description: c.description })))}\nTone: ${gdd.project?.tone || ''}`
})

module.exports = router
