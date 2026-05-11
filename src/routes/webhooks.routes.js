const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')
const { uploadToStorage } = require('../services/storage.service')

// ─── Parser de secciones del markdown GDD ─────────────────────────────────────

function parseGddSections(markdown) {
  const SEPARATOR = /\n-{40,}\n/
  const blocks = markdown.split(SEPARATOR).filter(b => b.trim())
  const sections = {}

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    const titleLine = lines.find(l => l.trim() && !l.startsWith('#'))
    if (!titleLine) continue

    const titleIdx    = lines.indexOf(titleLine)
    const quevaIdx    = lines.findIndex(l => /qué va aquí/i.test(l))
    const templateIdx = lines.findIndex(l => /template notes/i.test(l))

    let contentStart = titleIdx + 1
    if (quevaIdx > titleIdx) {
      // Saltar "Qué va aquí:" y la línea de descripción siguiente
      contentStart = quevaIdx + 2
    }
    const contentEnd = templateIdx > contentStart ? templateIdx : lines.length
    const content = lines.slice(contentStart, contentEnd).join('\n').trim()
    if (!content) continue

    const key = titleLine.trim()
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // quitar tildes
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, '_')
    sections[key] = content
  }
  return sections
}

function extractLine(text, ...prefixes) {
  for (const prefix of prefixes) {
    const m = text.match(new RegExp(`${prefix}[:\\s]+([^\\n]+)`, 'i'))
    if (m?.[1]?.trim()) return m[1].trim()
  }
  return ''
}

function parseNumberedList(text) {
  return (text.match(/^\d+\.\s+.+$/mg) || [])
    .map(l => l.replace(/^\d+\.\s+/, '').trim())
}

// Convierte el markdown completo del GDD → JSON estructurado que espera el resto de la app
function buildGddJson(sections) {
  // Personajes: "1. Nombre (rol): descripción"
  const charText = sections['characters'] || sections['main_characters'] || ''
  const characters = (charText.match(/\d+\.\s+([^(:]+?)(?:\s*\(([^)]+)\))?:\s*([^\n]+)/g) || [])
    .map(line => {
      const m = line.match(/\d+\.\s+([^(:]+?)(?:\s*\(([^)]+)\))?:\s*(.+)/)
      const name = (m?.[1] || '').trim()
      const role = (m?.[2] || '').trim()
      return {
        name,
        role,
        description: (m?.[3] || '').trim(),
        sprite_prompt: name ? `${name}${role ? `, ${role}` : ''}, game character, concept art` : '',
      }
    })
    .filter(c => c.name)

  // Mecánicas
  const mechanics = parseNumberedList(sections['game_mechanics'] || '').map(line => {
    const sep = line.indexOf(':')
    const name = sep > 0 ? line.slice(0, sep).trim() : line
    const desc = sep > 0 ? line.slice(sep + 1).trim() : ''
    return { name, type: 'gameplay', description: desc || name }
  })

  // Niveles / entornos
  const levels = parseNumberedList(sections['environments'] || sections['level_design'] || '').map(line => {
    const sep = line.indexOf(':')
    const name = sep > 0 ? line.slice(0, sep).trim() : line
    const env  = sep > 0 ? line.slice(sep + 1).trim() : ''
    return {
      name,
      environment: env || name,
      difficulty: 'medium',
      background_prompt: `${name} environment, game level, concept art`,
    }
  })

  const gameName  = sections['game_name'] || ''
  const genreText = sections['genre'] || ''
  const styleText = sections['art_style'] || sections['technical_form'] || ''

  return {
    project: {
      name:            extractLine(gameName, 'título oficial', 'official title') || gameName.split('\n')[0],
      genre:           extractLine(genreText, 'género principal', 'main genre') || genreText.split('\n')[0],
      core_loop:       sections['core_loop'] || '',
      tone:            extractLine(sections['design_guidelines'] || '', 'tono', 'tone'),
      elevator_pitch:  (sections['game_play'] || '').slice(0, 600),
      target_platform: (sections['platform'] || '').split('\n').find(l => l.trim()) || '',
    },
    characters,
    levels,
    mechanics,
    art_direction: {
      style:   styleText.split('\n').find(l => l.trim() && !l.startsWith('-')) || '',
      palette: extractLine(sections['style_guide'] || '', 'colores primarios', 'primary colors'),
      mood:    '',
      references: [],
    },
    audio_direction: {
      style: (sections['audio'] || '').split('\n').find(l => l.trim()) || '',
    },
    development: {
      suggested_engine: extractLine(
        sections['language'] || sections['engine_and_tools'] || '',
        'motor principal', 'main engine', 'motor'
      ) || 'Unity',
    },
    raw_sections: sections,
    _source: 'n8n_webhook',
  }
}

// ─── Tabla de step_keys soportados ────────────────────────────────────────────
// step_key recibido → { pipelineKey, parser }
// pipelineKey: clave en concept.pipeline donde se guarda el resultado

const STEP_HANDLERS = {
  n8n_gdd: {
    pipelineKey: 'gdd',
    ext: 'md',
    parse: (output) => {
      const sections = parseGddSections(output)
      return buildGddJson(sections)
    },
  },
  // Añadir aquí futuros steps n8n:
  // n8n_sprites: { pipelineKey: 'sprites', ext: 'txt', parse: (o) => ({ raw: o }) },
}

// ─── POST /api/webhooks ────────────────────────────────────────────────────────
// n8n llama aquí cuando termina un workflow de larga duración

router.post('/', async (req, res) => {
  try {
    // Validar secreto
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
      return res.status(400).json({ success: false, error: `Unknown step_key: "${step_key}". Supported: ${Object.keys(STEP_HANDLERS).join(', ')}` })
    }

    // Verificar que el proyecto existe
    const { data: project, error: projErr } = await db()
      .from('projects').select('id, concept').eq('id', project_id).single()
    if (projErr || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    // Guardar raw en R2
    const raw    = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    const r2Path = `projects/${project_id}/${handler.pipelineKey}/raw.${handler.ext}`
    await uploadToStorage(Buffer.from(raw, 'utf-8'), r2Path, 'text/plain')
    console.log(`[webhook] ${step_key} raw → ${r2Path}`)

    // Parsear output
    const parsedData = handler.parse(output)

    // Actualizar concept.pipeline[pipelineKey] en DB
    const concept  = project.concept  || {}
    const pipeline = concept.pipeline || {}
    pipeline[handler.pipelineKey] = parsedData
    concept.pipeline = pipeline

    const { error: updateErr } = await db()
      .from('projects').update({ concept }).eq('id', project_id)

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
