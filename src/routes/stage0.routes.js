const express = require('express')
const router  = express.Router()
const { db }         = require('../services/supabase.service')
const { callLLM }    = require('../services/llm.service')
const { getPrompt }  = require('../services/prompt.service')
const { validateStepConfig } = require('../services/config.service')
const { injectVars } = require('../utils/inject-vars')

// Extrae el logline/descripción del game_idea — primer párrafo sustancial
function extractLogline(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    const clean = line.replace(/^#+\s*/, '').replace(/\*+/g, '').trim()
    if (clean.length > 40 && !/^(title|genre|tone|platform|engine|scope|working title|logline|game idea)/i.test(clean)) {
      return clean.slice(0, 300)
    }
  }
  return null
}

// Extrae el género del game_idea buscando patrones "Genre: ..."
function extractGenre(text) {
  const m = text.match(/genre[:\s]+([^\n,]{3,60})/i)
  if (!m) return null
  return m[1].replace(/\*+/g, '').trim().split('/')[0].trim().slice(0, 60)
}

// Guarda un campo en concept.pipeline del proyecto
async function saveToPipeline(projectId, key, value) {
  const { data: project, error } = await db()
    .from('projects')
    .select('concept')
    .eq('id', projectId)
    .single()

  if (error || !project) throw new Error('Project not found')

  const updatedConcept = {
    ...project.concept,
    pipeline: {
      ...(project.concept?.pipeline || {}),
      [key]: value,
    },
  }

  const { error: uErr } = await db()
    .from('projects')
    .update({ concept: updatedConcept, updated_at: new Date().toISOString() })
    .eq('id', projectId)

  if (uErr) throw new Error(`Failed to save pipeline.${key}: ${uErr.message}`)
}

// POST /api/generate/idea-expansion  (Stage 0a)
// Body: { project_id, raw_idea, genre?, tone?, scope?, engine? }
// Retorna: { success, output: <markdown string>, meta }
router.post('/idea-expansion', async (req, res, next) => {
  try {
    const { project_id, raw_idea, genre, tone, scope, engine } = req.body

    if (!project_id)       return res.status(400).json({ success: false, error: 'project_id is required' })
    if (!raw_idea?.trim()) return res.status(400).json({ success: false, error: 'raw_idea is required' })

    const check = await validateStepConfig('00a_idea_expansion')
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })

    // Contexto adicional de params como parte del raw_idea inyectado
    const contextLines = [
      raw_idea.trim(),
      genre  && `Genre preferences: ${genre}`,
      tone   && `Tone preferences: ${tone}`,
      scope  && `Scope: ${scope}`,
      engine && `Target engine: ${engine}`,
    ].filter(Boolean).join('\n')

    const template = await getPrompt('00a_idea_expansion')
    if (!template) return res.status(422).json({ success: false, error: 'Prompt for 00a_idea_expansion not configured. Set R2 path in Admin → Prompts.', code: 'PROMPT_NOT_CONFIGURED' })

    const userMessage = injectVars(template, { RAW_IDEA: contextLines })

    // Sistema mínimo — rules.md no aplica todavía (no hay GAME_IDEA)
    const systemPrompt = 'You only expand the raw idea into a structured brief and three design directions per the user template. Output the exact template — no preamble, no extra sections.'

    let result
    try {
      result = await callLLM(systemPrompt, userMessage, {
        step: '00a_idea_expansion',
        rawText: true,
        maxOutputTokens: 4096,
        temperature: 0.85,
      })
    } catch (err) {
      const isRateLimit = err.status === 429 || err.code === 'RATE_LIMIT'
      return res.status(502).json({
        success: false,
        error: isRateLimit ? 'Rate limit reached. Try again in a few seconds.' : 'LLM call failed',
        code: isRateLimit ? 'RATE_LIMIT' : (err.code || 'LLM_ERROR'),
      })
    }

    // Eliminar instrucciones meta del prompt que el LLM puede colar en el output
    const output = result.data
      .replace(/stop here\..*$/is, '')
      .replace(/the next pipeline step.*$/is, '')
      .trim()

    // Guardar en el proyecto para poder retomar si el usuario cierra el modal
    await saveToPipeline(project_id, 'idea_expansion', {
      output,
      raw_idea: contextLines,
      created_at: new Date().toISOString(),
    })

    console.log(`[stage0a] project=${project_id} output_chars=${output.length}`)
    res.json({ success: true, output, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// POST /api/generate/direction-lock  (Stage 0b)
// Body: { project_id, stage0a_output, selected_direction }
// Retorna: { success, game_idea: <canonical block string>, meta }
router.post('/direction-lock', async (req, res, next) => {
  try {
    const { project_id, stage0a_output, selected_direction } = req.body

    if (!project_id)       return res.status(400).json({ success: false, error: 'project_id is required' })
    if (!stage0a_output)   return res.status(400).json({ success: false, error: 'stage0a_output is required' })
    if (!selected_direction || !['1','2','3'].includes(String(selected_direction))) {
      return res.status(400).json({ success: false, error: 'selected_direction must be 1, 2 or 3' })
    }

    const check = await validateStepConfig('00b_direction_lock')
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })

    const template = await getPrompt('00b_direction_lock')
    if (!template) return res.status(422).json({ success: false, error: 'Prompt for 00b_direction_lock not configured. Set R2 path in Admin → Prompts.', code: 'PROMPT_NOT_CONFIGURED' })

    const userMessage = injectVars(template, {
      STAGE0A_OUTPUT:     stage0a_output,
      SELECTED_DIRECTION: String(selected_direction),
    })

    const systemPrompt = 'You only assemble the canonical game-idea string from the supplied Stage 0a output. Output only the canonical block — no preamble, no extra text.'

    let result
    try {
      result = await callLLM(systemPrompt, userMessage, {
        step: '00b_direction_lock',
        rawText: true,
        maxOutputTokens: 1024,
        temperature: 0.3,
      })
    } catch (err) {
      const isRateLimit = err.status === 429 || err.code === 'RATE_LIMIT'
      return res.status(502).json({
        success: false,
        error: isRateLimit ? 'Rate limit reached. Try again in a few seconds.' : 'LLM call failed',
        code: isRateLimit ? 'RATE_LIMIT' : (err.code || 'LLM_ERROR'),
      })
    }

    const game_idea = result.data

    // Guardar como fuente de verdad del proyecto — todos los nodos GDD lo leerán de aquí
    await saveToPipeline(project_id, 'game_idea', {
      text: game_idea,
      selected_direction: Number(selected_direction),
      locked_at: new Date().toISOString(),
    })

    // Extraer metadata — genre viene del 00a output (más confiable), logline del game_idea
    const description = extractLogline(game_idea)
    const genre       = extractGenre(stage0a_output) || extractGenre(game_idea)

    const projectUpdate = { status: 'active', updated_at: new Date().toISOString() }
    if (description) projectUpdate.description = description
    if (genre)       projectUpdate.genre = genre

    await db().from('projects').update(projectUpdate).eq('id', project_id)

    console.log(`[stage0b] project=${project_id} direction=${selected_direction} game_idea_chars=${game_idea.length}`)
    res.json({ success: true, game_idea, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

module.exports = router
