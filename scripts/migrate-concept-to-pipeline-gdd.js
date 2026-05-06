/**
 * Migration: move top-level GDD fields from concept.* to concept.pipeline.gdd.*
 *
 * Before: { concept: { project, characters, mechanics, ... } }
 * After:  { concept: { pipeline: { gdd: { project, characters, mechanics, ... }, ...existing_pipeline_nodes } } }
 *
 * R2 images stored in concept.pipeline.* are untouched.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const { createClient } = require('@supabase/supabase-js')

const GDD_KEYS = [
  'project', 'characters', 'mechanics', 'levels', 'art_direction',
  'audio_direction', 'development', 'narrative', 'world', 'glossary',
  'open_questions', 'uiux_direction', 'systems',
]

async function run() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { db: { schema: process.env.SUPABASE_SCHEMA || 'v57' } }
  )

  const { data: projects, error } = await supabase
    .from('projects')
    .select('id, name, concept')

  if (error) {
    console.error('Failed to fetch projects:', error.message)
    process.exit(1)
  }

  console.log(`Found ${projects.length} project(s)\n`)

  let migrated = 0
  let skipped = 0

  for (const project of projects) {
    const concept = project.concept || {}

    // Check if already migrated (has pipeline.gdd)
    if (concept.pipeline?.gdd) {
      console.log(`[SKIP] "${project.name}" (${project.id}) — already migrated`)
      skipped++
      continue
    }

    // Collect GDD fields from top-level concept
    const gddData = {}
    let hasAny = false
    for (const key of GDD_KEYS) {
      if (concept[key] !== undefined) {
        gddData[key] = concept[key]
        hasAny = true
      }
    }

    if (!hasAny) {
      console.log(`[SKIP] "${project.name}" (${project.id}) — no GDD fields found`)
      skipped++
      continue
    }

    // Build new concept: remove top-level GDD keys, set pipeline.gdd
    const newConcept = { ...concept }
    for (const key of GDD_KEYS) {
      delete newConcept[key]
    }
    newConcept.pipeline = {
      ...(concept.pipeline || {}),
      gdd: gddData,
    }

    const { error: updateError } = await supabase
      .from('projects')
      .update({ concept: newConcept })
      .eq('id', project.id)

    if (updateError) {
      console.error(`[ERROR] "${project.name}" (${project.id}): ${updateError.message}`)
    } else {
      const keys = Object.keys(gddData).join(', ')
      console.log(`[OK]   "${project.name}" (${project.id}) — moved: ${keys}`)
      migrated++
    }
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}`)
}

run().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
