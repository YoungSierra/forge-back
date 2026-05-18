const express = require('express')
const router  = express.Router()
const { db }         = require('../services/supabase.service')
const { callLLM }    = require('../services/llm.service')
const { getPrompt }  = require('../services/prompt.service')
const { validateStepConfig } = require('../services/config.service')
const { injectVars } = require('../utils/inject-vars')

// Mapeo de section_key → prompt step_key, en orden
// El orden define cómo se acumula el prior_context automáticamente
const GDD_SECTION_ORDER = [
  'gdd_overview',
  'gdd_genre_platform',
  'gdd_gameplay',
  'gdd_core_loop',
  'gdd_mechanics',
  'gdd_progression',
  'gdd_narrative',
  'gdd_characters',
  'gdd_ui_ux',
  'gdd_art_audio',
  'gdd_economy',
  'gdd_technical',
]
const GDD_SECTION_SET = new Set(GDD_SECTION_ORDER)

// Lee concept.pipeline.gdd_sections del proyecto
async function loadProject(projectId) {
  const { data: project, error } = await db()
    .from('projects')
    .select('concept')
    .eq('id', projectId)
    .single()
  if (error || !project) throw new Error('Project not found')
  return project
}

// Guarda la salida de una sección en concept.pipeline.gdd_sections
async function saveSectionOutput(projectId, sectionKey, output) {
  const project = await loadProject(projectId)
  const updatedConcept = {
    ...project.concept,
    pipeline: {
      ...(project.concept?.pipeline || {}),
      gdd_sections: {
        ...(project.concept?.pipeline?.gdd_sections || {}),
        [sectionKey]: {
          output,
          generated_at: new Date().toISOString(),
        },
      },
    },
  }
  const { error } = await db()
    .from('projects')
    .update({ concept: updatedConcept, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  if (error) throw new Error(`Failed to save gdd_sections.${sectionKey}: ${error.message}`)
}

// Construye el prior_context concatenando todas las secciones anteriores aprobadas
function buildPriorContext(gddSections, sectionKey) {
  const idx = GDD_SECTION_ORDER.indexOf(sectionKey)
  if (idx === 0) return 'none — this is the first section.'

  const priorSections = GDD_SECTION_ORDER.slice(0, idx)
  const parts = priorSections
    .map(key => gddSections?.[key]?.output)
    .filter(Boolean)

  return parts.length > 0 ? parts.join('\n\n---\n\n') : 'none — no prior sections have been generated yet.'
}

// POST /api/generate/gdd-section
// Body: { project_id, section_key, prior_context? }
// prior_context es opcional — si no se pasa, se construye desde el proyecto
router.post('/gdd-section', async (req, res, next) => {
  try {
    const { project_id, section_key, prior_context } = req.body

    if (!project_id)  return res.status(400).json({ success: false, error: 'project_id is required' })
    if (!section_key) return res.status(400).json({ success: false, error: 'section_key is required' })
    if (!GDD_SECTION_SET.has(section_key)) {
      return res.status(400).json({
        success: false,
        error: `Invalid section_key. Must be one of: ${GDD_SECTION_ORDER.join(', ')}`,
      })
    }

    // Validar config del nodo
    const check = await validateStepConfig(section_key)
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })

    // Cargar proyecto
    const project = await loadProject(project_id)
    const gameIdea = project.concept?.pipeline?.game_idea?.text
    if (!gameIdea) {
      return res.status(422).json({
        success: false,
        error: 'Game idea not found. Complete Stage 0 (idea expansion + direction lock) first.',
        code: 'GAME_IDEA_MISSING',
      })
    }

    // Cargar templates desde R2
    const rulesTemplate    = await getPrompt('rules')
    const sectionTemplate  = await getPrompt(section_key)

    if (!rulesTemplate) {
      return res.status(422).json({
        success: false,
        error: 'rules.md prompt not configured. Set R2 path in Admin → Prompts.',
        code: 'PROMPT_NOT_CONFIGURED',
      })
    }
    if (!sectionTemplate) {
      return res.status(422).json({
        success: false,
        error: `Prompt for ${section_key} not configured. Set R2 path in Admin → Prompts.`,
        code: 'PROMPT_NOT_CONFIGURED',
      })
    }

    // Construir prior_context si no viene en el body
    const gddSections = project.concept?.pipeline?.gdd_sections || {}
    const resolvedPriorContext = prior_context ?? buildPriorContext(gddSections, section_key)

    // Inyectar variables
    const systemPrompt = injectVars(rulesTemplate, { GAME_IDEA: gameIdea })
    const userMessage  = injectVars(sectionTemplate, { PRIOR_CONTEXT: resolvedPriorContext })

    let result
    try {
      result = await callLLM(systemPrompt, userMessage, {
        step: section_key,
        rawText: true,
        maxOutputTokens: 8192,
        temperature: 0.7,
      })
    } catch (err) {
      const isRateLimit = err.status === 429 || err.code === 'RATE_LIMIT'
      return res.status(502).json({
        success: false,
        error: isRateLimit ? 'Rate limit reached. Try again in a few seconds.' : 'LLM call failed',
        code: isRateLimit ? 'RATE_LIMIT' : (err.code || 'LLM_ERROR'),
      })
    }

    // Guardar salida en el proyecto
    await saveSectionOutput(project_id, section_key, result.data)

    console.log(`[gdd-section] project=${project_id} section=${section_key} chars=${result.data.length}`)
    res.json({ success: true, output: result.data, section_key, meta: result.meta })
  } catch (err) {
    next(err)
  }
})

// GET /api/generate/gdd-section/:project_id
// Retorna todas las secciones guardadas del proyecto
router.get('/gdd-section/:project_id', async (req, res, next) => {
  try {
    const { project_id } = req.params

    const project = await loadProject(project_id)
    const gddSections = project.concept?.pipeline?.gdd_sections || {}

    const sections = GDD_SECTION_ORDER.map((key, idx) => ({
      section_key: key,
      order: idx + 1,
      generated: !!gddSections[key]?.output,
      generated_at: gddSections[key]?.generated_at || null,
      output: gddSections[key]?.output || null,
    }))

    res.json({ success: true, sections })
  } catch (err) {
    next(err)
  }
})

module.exports = router
