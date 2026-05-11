const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')
const { uploadToStorage } = require('../services/storage.service')

// ─── Normaliza título de sección → snake_case sin tildes ─────────────────────

function normalizeKey(title) {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
}

// Encabezados de documento que NO son secciones de contenido
const SKIP_HEADER = /^(\(GDD\)|V57[\s ]+GAME|VERSION\b|Author[\s]+Name|Date[\s]+document|INDEX\b|Template[\s]+Notes)/i

// ─── Parser principal: detecta ## Sección y extrae direct + notes ─────────────
// Formato esperado por sección:
//   ## Nombre de Sección
//   What goes here:
//   [descripción del template — se ignora]
//   [blank]
//   [contenido directo llenado por n8n — se extrae]
//   ## Template Notes / Ideas:
//   ## 1. nota
//   ## 2. nota

function parseGddSections(markdown) {
  const lines = markdown.split('\n')
  const sections = {}
  let currentTitle = null
  let currentLines = []

  function flushSection() {
    if (!currentTitle) return
    const key = normalizeKey(currentTitle)
    if (key) {
      const content = parseSectionContent(currentLines)
      if (content.direct || content.notes.length > 0) {
        sections[key] = content
      }
    }
    currentTitle = null
    currentLines = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // "## Título" donde el primer char después de "## " es letra o (
    const headerMatch = trimmed.match(/^## ([A-Za-z(].+)$/)
    if (headerMatch) {
      const title = headerMatch[1].trim()

      // Ignorar encabezados de metadatos del documento
      if (SKIP_HEADER.test(title)) continue

      // "## Template Notes / Ideas:" se pliega en la sección actual, no abre una nueva
      if (/^Template[\s]+Notes/i.test(title)) {
        if (currentTitle) currentLines.push(line)
        continue
      }

      flushSection()
      currentTitle = title
      continue
    }

    if (currentTitle) currentLines.push(line)
  }
  flushSection()

  return sections
}

// Extrae contenido directo y notas numeradas de las líneas de una sección
function parseSectionContent(lines) {
  // Estados: before → what_goes_here_desc → direct → template_notes
  let state = 'before'
  const direct = []
  const notes  = []

  for (const line of lines) {
    const trimmed = line.trim()

    if (/^what goes here:/i.test(trimmed)) {
      state = 'what_goes_here_desc'
      continue
    }

    if (/^## template[\s]+notes/i.test(trimmed)) {
      state = 'template_notes'
      continue
    }

    if (state === 'what_goes_here_desc') {
      // Línea en blanco = fin de descripción del template, empieza contenido real
      if (trimmed === '') state = 'direct'
      continue
    }

    if (state === 'direct') {
      if (trimmed) direct.push(trimmed)
      continue
    }

    if (state === 'template_notes') {
      // "## 1. Contenido de la nota"
      const m = trimmed.match(/^## \d+\.\s+(.+)/)
      if (m) notes.push(m[1].trim())
    }
  }

  return { direct: direct.join('\n').trim(), notes }
}

// ─── Helpers de acceso a secciones ───────────────────────────────────────────

function d(sections, key)  { return sections[key]?.direct || '' }
function n(sections, key)  { return sections[key]?.notes  || [] }
function dn(sections, key) { return d(sections, key) || n(sections, key).join('. ') }

// ─── Convierte secciones parseadas → JSON estructurado del GDD ───────────────

function buildGddJson(sections) {
  // Personajes: notas con patrón "Name – role, description" o "Name - description"
  const characters = n(sections, 'characters').map(note => {
    const m = note.match(/^([^–\-]+?)\s*[–\-]\s*(.+)/)
    const name = (m?.[1] || note).trim()
    const desc = (m?.[2] || '').trim()
    const role = desc.split(/[,;]/)[0].trim()
    return {
      name,
      role,
      description: desc,
      sprite_prompt: `${name}, ${role}, game character, concept art`,
    }
  }).filter(c => c.name)

  // Mecánicas: notas con patrón "Name – description"
  const mechanics = n(sections, 'game_mechanics').map(note => {
    const m = note.match(/^([^–\-]+?)\s*[–\-]\s*(.+)/)
    const name = (m?.[1] || note).trim()
    const desc = (m?.[2] || '').trim()
    return { name, type: 'gameplay', description: desc || name }
  })

  // Niveles: de notas de environments
  const levels = n(sections, 'environments').map((note, i) => {
    const m = note.match(/^([^–\-,]+?)\s*[–\-,]\s*(.+)/)
    const name = (m?.[1] || `Level ${i + 1}`).trim()
    const env  = (m?.[2] || note).trim()
    return {
      name,
      environment: env,
      difficulty: 'medium',
      background_prompt: `${env}, game level environment, concept art`,
    }
  })

  // Core loop: notas como pasos del ciclo
  const coreLoop = d(sections, 'core_loop') || n(sections, 'core_loop').join(' → ')

  // Genre: primera parte antes de la coma
  const genreRaw = d(sections, 'genre') || n(sections, 'genre')[0] || ''
  const genre = genreRaw.split(/[,;]/)[0].trim()

  // Art direction
  const styleNotes     = n(sections, 'art_style')
  const styleGuideNotes = n(sections, 'style_guide')
  const palette = styleGuideNotes.find(note => /color|palette|saturat|vibrant/i.test(note)) || ''

  // Audio
  const audioNotes = n(sections, 'audio')

  // Engine: busca nombre de motor en notas
  const engineNote = n(sections, 'engine_and_tools')
    .find(note => /unity|unreal|godot|pygame|cocos/i.test(note)) || ''
  const engineMatch = engineNote.match(/unity|unreal|godot|pygame|cocos/i)
  const suggestedEngine = engineMatch ? engineMatch[0] : 'Unity'

  const gameplayText = d(sections, 'game_play')

  return {
    project: {
      name:            d(sections, 'game_name'),
      genre,
      description:     gameplayText.slice(0, 600),
      elevator_pitch:  gameplayText.slice(0, 600),
      core_loop:       coreLoop,
      tone:            '',
      target_platform: d(sections, 'platform') || n(sections, 'platform')[0] || '',
      camera:          d(sections, 'view')     || n(sections, 'view')[0]     || '',
      player_mode:     d(sections, 'player')   || n(sections, 'player')[0]   || '',
      target_devices:  d(sections, 'device')   || '',
      lore:            n(sections, 'lore').join('. '),
      game_play_outline: d(sections, 'game_play_outline'),
    },
    characters,
    levels,
    mechanics,
    art_direction: {
      style:          styleNotes[0]          || d(sections, 'art_style') || '',
      palette,
      mood:           '',
      references:     [],
      technical_form: d(sections, 'technical_form') || '',
    },
    audio_direction: {
      style: audioNotes[0] || '',
    },
    development: {
      suggested_engine: suggestedEngine,
      target_devices:   d(sections, 'device') || '',
      language:         n(sections, 'language').join(', '),
    },
    raw_sections: sections,
    _source: 'n8n_webhook',
  }
}

// ─── Tabla de step_keys soportados ───────────────────────────────────────────
// Cada entry: { pipelineKey, ext, parse, updateProject? }
// updateProject: campos extra a actualizar en la tabla projects

const STEP_HANDLERS = {
  n8n_gdd: {
    pipelineKey: 'gdd',
    ext: 'md',
    parse: (output) => {
      const sections = parseGddSections(output)
      return buildGddJson(sections)
    },
    updateProject: (parsed) => ({
      description:   parsed.project?.description || parsed.project?.elevator_pitch || '',
      genre:         parsed.project?.genre        || '',
      target_engine: parsed.development?.suggested_engine || 'Unity',
      status:        'active',
    }),
  },
  // Futuros steps:
  // n8n_sprites: { pipelineKey: 'sprites', ext: 'txt', parse: (o) => ({ raw: o }) },
}

// ─── POST /api/webhooks ───────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const secret = req.headers['x-forge-secret'] || req.body.secret
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    const { project_id, step_key, output } = req.body
    if (!project_id)    return res.status(400).json({ success: false, error: 'project_id is required' })
    if (!step_key)      return res.status(400).json({ success: false, error: 'step_key is required' })
    if (output == null) return res.status(400).json({ success: false, error: 'output is required' })

    const handler = STEP_HANDLERS[step_key]
    if (!handler) {
      return res.status(400).json({
        success: false,
        error: `Unknown step_key: "${step_key}". Supported: ${Object.keys(STEP_HANDLERS).join(', ')}`,
      })
    }

    const { data: project, error: projErr } = await db()
      .from('projects').select('id, concept').eq('id', project_id).single()
    if (projErr || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    // Guardar raw en R2
    const raw    = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    const r2Path = `projects/${project_id}/${handler.pipelineKey}/raw.${handler.ext}`
    await uploadToStorage(Buffer.from(raw, 'utf-8'), r2Path, 'text/plain')
    console.log(`[webhook] ${step_key} raw → ${r2Path}`)

    // Parsear y guardar en concept.pipeline
    const parsedData = handler.parse(output)
    const concept    = project.concept  || {}
    const pipeline   = concept.pipeline || {}
    pipeline[handler.pipelineKey] = parsedData
    concept.pipeline = pipeline

    // Campos extra a nivel de proyecto (description, genre, status…)
    const extraFields = handler.updateProject ? handler.updateProject(parsedData) : {}

    const { error: updateErr } = await db()
      .from('projects').update({ concept, ...extraFields }).eq('id', project_id)

    if (updateErr) {
      console.error(`[webhook] DB update error:`, updateErr.message)
      return res.status(500).json({ success: false, error: updateErr.message })
    }

    console.log(`[webhook] step=${step_key} pipeline=${handler.pipelineKey} project=${project_id} ✓`)
    res.json({ success: true, step_key, pipeline_key: handler.pipelineKey, project_id })
  } catch (err) {
    console.error('[webhook] error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

module.exports = router
