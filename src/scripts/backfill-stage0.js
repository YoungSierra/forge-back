/**
 * Backfill: actualiza status/description/genre en proyectos que ya tienen
 * concept.pipeline.game_idea.text pero aún están en DRAFT.
 * Uso: node src/scripts/backfill-stage0.js
 */
require('dotenv').config()
const { db } = require('../services/supabase.service')

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

function extractGenre(text) {
  const m = text.match(/genre[:\s]+([^\n,]{3,60})/i)
  if (!m) return null
  return m[1].replace(/\*+/g, '').trim().split('/')[0].trim().slice(0, 60)
}

async function run() {
  console.log('[backfill] Buscando proyectos con game_idea pero en DRAFT...')

  // Busca proyectos con game_idea sin genre ni description (draft o active)
  const { data: projects, error } = await db()
    .from('projects')
    .select('id, name, status, genre, description, concept')

  if (error) { console.error(error); process.exit(1) }

  let updated = 0
  for (const p of projects) {
    const gameIdea        = p.concept?.pipeline?.game_idea?.text
    if (!gameIdea) continue
    // Saltar si ya tiene genre real (no "tbd" ni vacío) y description
    const hasGenre = p.genre && p.genre !== 'tbd' && p.genre !== 'TBD'
    if (p.status === 'active' && hasGenre && p.description) continue

    const ideaExpOutput   = p.concept?.pipeline?.idea_expansion?.output || ''
    const description     = extractLogline(gameIdea)
    const genre           = extractGenre(ideaExpOutput) || extractGenre(gameIdea)
    const patch       = { status: 'active', updated_at: new Date().toISOString() }
    if (description) patch.description = description
    if (genre)       patch.genre = genre

    const { error: uErr } = await db().from('projects').update(patch).eq('id', p.id)
    if (uErr) {
      console.error(`[backfill] Error en ${p.name} (${p.id}):`, uErr.message)
    } else {
      console.log(`[backfill] ✓ ${p.name} → active | genre: ${genre ?? 'n/a'}`)
      updated++
    }
  }

  console.log(`[backfill] Listo. ${updated} proyecto(s) actualizados.`)
  process.exit(0)
}

run()
