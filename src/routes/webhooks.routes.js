const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')
const { uploadToStorage } = require('../services/storage.service')

// ─── Helpers generales ────────────────────────────────────────────────────────

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
}

// ─── Frontmatter: extrae **Key:** Value antes del primer ## ──────────────────

function extractFrontmatter(markdown) {
  const result = {}
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) break
    const m = line.trim().match(/^\*\*([^*]+):\*\*\s*(.+)/)
    if (m) result[m[1].trim().toLowerCase()] = m[2].trim()
  }
  return result
}

// ─── Árbol H2 → H3 → líneas ──────────────────────────────────────────────────

function parseSectionTree(markdown) {
  const tree = {}
  let h2 = null
  let h3 = null

  for (const line of markdown.split('\n')) {
    const m2 = line.match(/^## (.+)$/)
    const m3 = line.match(/^### (.+)$/)

    if (m2) {
      h2 = m2[1].trim(); h3 = null
      if (!tree[h2]) tree[h2] = {}
      continue
    }
    if (m3) {
      h3 = m3[1].trim()
      if (h2 && !tree[h2][h3]) tree[h2][h3] = []
      continue
    }
    if (h2 && h3) tree[h2][h3].push(line)
    else if (h2) {
      if (!tree[h2]['__direct__']) tree[h2]['__direct__'] = []
      tree[h2]['__direct__'].push(line)
    }
  }
  return tree
}

// ─── Acceso a subsección por número (h2Num = '5', h3Num = '5.1') ─────────────

function getSubsection(tree, h2Num, h3Num) {
  const h2Key = Object.keys(tree).find(k => k.startsWith(h2Num + '.'))
  if (!h2Key) return []
  const h3Key = Object.keys(tree[h2Key]).find(k => k.startsWith(h3Num + ' ') || k === h3Num)
  if (!h3Key) return []
  return tree[h2Key][h3Key] || []
}

// ─── Parser de tabla markdown → array de objetos (keys slugificados) ─────────

function parseTable(lines) {
  const rows = lines.map(l => l.trim()).filter(l => l.startsWith('|'))
  if (rows.length < 3) return []
  const headers = rows[0].split('|').slice(1, -1).map(h => slugify(h))
  return rows.slice(2).map(row => {
    const cells = row.split('|').slice(1, -1).map(c => c.trim())
    const obj   = {}
    headers.forEach((h, i) => { obj[h] = cells[i] || '' })
    return obj
  }).filter(row => Object.values(row).some(v => v))
}

// ─── Parser de bold KV: **Key:** Value (soporte multilínea) ──────────────────

function parseBoldKV(lines) {
  const result = {}
  let key = null, val = []

  for (const line of lines) {
    const m = line.trim().match(/^\*\*([^*]+):\*\*\s*(.*)/)
    if (m) {
      if (key) result[key] = val.join(' ').trim()
      key = slugify(m[1])
      val = m[2] ? [m[2].trim()] : []
    } else if (key) {
      const t = line.trim()
      if (t && !t.startsWith('#')) val.push(t)
    }
  }
  if (key) result[key] = val.join(' ').trim()
  return result
}

// ─── Extrae texto de párrafo (excluye tablas, listas, headers, bold KV) ───────

function extractParagraph(lines) {
  return lines
    .map(l => l.trim())
    .filter(l => l
      && !l.startsWith('|')
      && !/^[-*]\s+/.test(l)
      && !l.startsWith('#')
      && !l.startsWith('---')
      && !/^\d+\.\s+/.test(l)
      && !/^\*\*[^*]+:\*\*/.test(l)
    )
    .join(' ')
    .trim()
}

// ─── Extrae ítems de lista de bullets ────────────────────────────────────────

function extractBullets(lines) {
  return lines.map(l => l.trim())
    .filter(l => /^[-*]\s+/.test(l))
    .map(l => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
}

// ─── Extrae ítems de lista numerada ──────────────────────────────────────────

function extractNumbered(lines) {
  return lines.map(l => l.trim())
    .filter(l => /^\d+\.\s+/.test(l))
    .map(l => l.replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)
}

// ─── Convierte markdown GDD (formato n8n nuevo) → JSON estructurado ───────────

function buildGddJson(rawMarkdown) {
  // Normalizar CRLF → LF para que los regex funcionen igual en cualquier SO
  const markdown = rawMarkdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const fm   = extractFrontmatter(markdown)
  const tree = parseSectionTree(markdown)
  const s    = (h2, h3) => getSubsection(tree, h2, h3)

  // ── project ──────────────────────────────────────────────────────────────
  const classTable = parseTable(s('2', '2.1'))
  const classField = (name) =>
    classTable.find(r => (r.field || '').toLowerCase().includes(name.toLowerCase()))?.value || ''

  const coreLoopLine = s('4', '4.1').find(l => l.includes('→'))
  const coreLoop     = (coreLoopLine || '').replace(/\*\*/g, '').trim()

  const visualText = extractParagraph(s('10', '10.1'))
  const toneMatch  = visualText.match(/emotional tone is ([^.]+)/)

  // ── design_pillars ────────────────────────────────────────────────────────
  const designPillars = parseTable(s('1', '1.2')).map(r => ({
    pillar:      r.pillar      || '',
    description: r.description || '',
  })).filter(p => p.pillar)

  // ── key_features ──────────────────────────────────────────────────────────
  const keyFeatures = extractBullets(s('3', '3.3'))
    .map(l => l.replace(/\*\*/g, '').trim())
    .filter(Boolean)

  // ── characters ────────────────────────────────────────────────────────────
  const section8Key = Object.keys(tree).find(k => k.startsWith('8.'))
  const characters  = []
  if (section8Key) {
    for (const [h3Key, lines] of Object.entries(tree[section8Key])) {
      if (!/^\d+\.\d+/.test(h3Key)) continue
      const rows     = parseTable(lines)
      const getField = (name) =>
        rows.find(r => (r.field || '').toLowerCase().includes(name.toLowerCase()))?.detail || ''
      const namePart = h3Key.replace(/^\d+\.\d+\s+/, '').split(/\s+[—–]\s+/)[0]
      // eliminar apodo entre comillas (rectas o curvas)
      const charName = namePart.replace(/\s*[“”"'][^“”"']*[“”"']/g, '').trim()
      if (!charName) continue
      const appearance    = getField('appearance')
      const gameplayRole  = getField('gameplay abilities') || getField('gameplay role')
      const personality   = getField('personality')
      const role          = getField('role')

      // Construir sprite_prompt desde los campos del formato n8n
      const spriteParts = [appearance, personality, gameplayRole].filter(Boolean)
      const sprite_prompt = spriteParts.length
        ? `${charName}, ${role || 'character'} — ${spriteParts.join(', ')}`
        : ''

      characters.push({
        name:          charName,
        role,
        age:           getField('age'),
        appearance,
        personality,
        backstory:     getField('backstory'),
        motivation:    getField('motivation'),
        arc:           getField('character arc'),
        gameplay_role: gameplayRole,
        sprite_prompt,
      })
    }
  }

  // ── mechanics ─────────────────────────────────────────────────────────────
  const section5Key = Object.keys(tree).find(k => k.startsWith('5.'))
  const mechanics   = []
  if (section5Key) {
    for (const [h3Key, lines] of Object.entries(tree[section5Key])) {
      if (!/^\d+\.\d+/.test(h3Key)) continue
      const kv       = parseBoldKV(lines)
      const mechName = h3Key.replace(/^\d+\.\d+\s+/, '').trim()
      if (!mechName) continue
      mechanics.push({
        name:        mechName,
        category:    kv['category']    || '',
        description: kv['description'] || '',
        player_goal: kv['player_goal'] || '',
        rules:       kv['rules']       || '',
        depth:       kv['depth']       || '',
        integration: kv['integration'] || '',
      })
    }
  }

  // ── levels ────────────────────────────────────────────────────────────────
  const levels = parseTable(s('7', '7.7')).map(r => ({
    name:                   r.environment || r.name || '',
    visual_feel:            r.visual_feel            || '',
    gameplay_role:          r.gameplay_role          || '',
    narrative_significance: r.narrative_significance || '',
  })).filter(l => l.name)

  // ── story_acts ────────────────────────────────────────────────────────────
  const storyActs = []
  let actNum = 0, actTitle = '', actBuf = []
  for (const line of s('7', '7.4')) {
    const m = line.trim().match(/^\*\*Act\s+(\d+)\s*[—–-]\s*(.+)\*\*/)
    if (m) {
      if (actTitle && actBuf.length) storyActs.push({ act: actNum, title: actTitle, summary: actBuf.join(' ').trim() })
      actNum = parseInt(m[1]); actTitle = m[2].trim(); actBuf = []
    } else if (actTitle) {
      const t = line.trim()
      if (t && !t.startsWith('#')) actBuf.push(t)
    }
  }
  if (actTitle && actBuf.length) storyActs.push({ act: actNum, title: actTitle, summary: actBuf.join(' ').trim() })

  // ── themes ────────────────────────────────────────────────────────────────
  const themes = parseTable(s('7', '7.5')).map(r => ({
    theme:         r.theme        || '',
    manifestation: r.how_it_manifests_in_the_game || r.manifestation || '',
  })).filter(t => t.theme)

  // ── factions ──────────────────────────────────────────────────────────────
  const factions = parseTable(s('7', '7.6')).map(r => ({
    name:                r.name                || '',
    alignment:           r.alignment           || '',
    goals:               r.goals               || '',
    player_relationship: r.player_relationship || '',
  })).filter(f => f.name)

  // ── game_phases ───────────────────────────────────────────────────────────
  const gamePhases = parseTable(s('6', '6.2')).map(r => ({
    phase:             r.phase             || '',
    time_range:        r.time_range        || '',
    power_level:       r.power_level       || '',
    content_available: r.content_available || '',
    key_unlock:        r.key_unlock        || '',
  })).filter(p => p.phase)

  // ── player_stats ──────────────────────────────────────────────────────────
  const playerStats = parseTable(s('6', '6.3')).map(r => ({
    stat:         r.stat         || '',
    description:  r.description  || '',
    base_value:   r.base_value   || '',
    max_value:    r.max_value    || '',
    how_it_grows: r.how_it_grows || '',
  })).filter(s => s.stat)

  // ── player_abilities ──────────────────────────────────────────────────────
  const playerAbilities = parseTable(s('6', '6.4')).map(r => ({
    ability:          r.ability          || '',
    unlock_condition: r.unlock_condition || '',
    description:      r.description      || '',
    cooldown_cost:    r.cooldown_cost    || '',
  })).filter(a => a.ability)

  // ── art_direction ─────────────────────────────────────────────────────────
  const artPalette = parseTable(s('10', '10.3')).map(r => ({
    role:              r.role              || '',
    color_description: r.color_description || '',
    tone:              r.tone              || '',
    usage:             r.usage             || '',
  })).filter(p => p.role)

  const artRefs = parseTable(s('10', '10.2')).map(r => ({
    reference:    r.reference             || '',
    what_we_take: r.what_we_take_from_it || r.what_we_take || '',
  })).filter(r => r.reference)

  const techTargets = extractBullets(s('10', '10.6'))
    .map(l => l.replace(/\*\*/g, '').trim())
    .join('; ')

  // ── audio_direction ───────────────────────────────────────────────────────
  const audioMap = {}
  parseTable(s('10', '10.7')).forEach(r => {
    audioMap[slugify(r.element || '')] = r.description || ''
  })

  // ── magic_moments ─────────────────────────────────────────────────────────
  const magicMoments = extractNumbered(s('10', '10.8'))
    .map(l => l.replace(/\*\*/g, '').trim())

  // ── economy ───────────────────────────────────────────────────────────────
  const econKV = parseBoldKV(s('11', '11.1'))
  const currencies = parseTable(s('11', '11.2')).map(r => ({
    currency:    r.currency    || '',
    type:        r.type        || '',
    how_earned:  r.how_earned  || '',
    how_spent:   r.how_spent   || '',
    purchasable: r.purchasable || '',
  })).filter(c => c.currency)

  const rewardStructure = parseTable(s('11', '11.3')).map(r => ({
    reward_type:      r.reward_type      || '',
    trigger:          r.trigger          || '',
    frequency:        r.frequency        || '',
    emotion_targeted: r.emotion_targeted || '',
  })).filter(r => r.reward_type)

  // ── development ───────────────────────────────────────────────────────────
  const toolsRows = parseTable(s('12', '12.1'))
  const toolsMap  = {}
  toolsRows.forEach(r => { toolsMap[slugify(r.category || '')] = r.tool_technology || r.tool || '' })

  return {
    project: {
      name:            fm['title']    || '',
      tagline:         fm['tagline']  || '',
      genre:           fm['genre']    || '',
      target_platform: fm['platform'] || '',
      description:     extractParagraph(s('1', '1.1')),
      elevator_pitch:  extractParagraph(s('1', '1.5')),
      logline:         extractParagraph(s('7', '7.1')),
      core_loop:       coreLoop,
      player_mode:     classField('player mode'),
      camera:          classField('camera'),
      art_style:       classField('art style'),
      setting:         extractParagraph(s('7', '7.2')),
      lore:            extractParagraph(s('7', '7.3')),
      tone:            toneMatch ? toneMatch[1].trim() : '',
      target_audience: extractParagraph(s('1', '1.3')),
    },
    design_pillars:   designPillars,
    key_features:     keyFeatures,
    characters,
    mechanics,
    levels,
    story_acts:       storyActs,
    themes,
    factions,
    game_phases:      gamePhases,
    player_stats:     playerStats,
    player_abilities: playerAbilities,
    art_direction: {
      style:             visualText,
      palette:           artPalette,
      references:        artRefs,
      character_style:   extractParagraph(s('10', '10.4')),
      environment_style: extractParagraph(s('10', '10.5')),
      technical_targets: techTargets,
    },
    audio_direction: {
      music_genre:        audioMap['music_genre']        || '',
      instrumentation:    audioMap['instrumentation']    || '',
      adaptive_music:     audioMap['adaptive_music']     || '',
      sound_design_style: audioMap['sound_design_style'] || '',
      voice_over:         audioMap['voice_over']         || '',
      ambience:           audioMap['ambience']           || '',
    },
    magic_moments:    magicMoments,
    economy: {
      model:            econKV['model']       || '',
      price:            econKV['price_point'] || '',
      currencies,
      reward_structure: rewardStructure,
    },
    development: {
      suggested_engine: toolsMap['game_engine']       || '',
      language:         toolsMap['primary_language']  || '',
      tools:            toolsRows.map(r => ({
        category: r.category        || '',
        tool:     r.tool_technology || r.tool || '',
      })),
    },
    _source: 'n8n_webhook',
  }
}

// ─── Tabla de step_keys soportados ───────────────────────────────────────────

const STEP_HANDLERS = {
  n8n_gdd: {
    pipelineKey: 'gdd',
    ext: 'md',
    parse: (output) => buildGddJson(output),
    updateProject: (parsed) => {
      const raw    = (parsed.development?.suggested_engine || '').toLowerCase()
      const engine = raw.includes('unreal') ? 'unreal'
                   : raw.includes('godot')  ? 'godot'
                   : raw.includes('phaser') ? 'phaser'
                   : 'unity'
      return {
        description:   parsed.project?.description || parsed.project?.elevator_pitch || '',
        genre:         parsed.project?.genre        || '',
        target_engine: engine,
        status:        'active',
      }
    },
  },
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
