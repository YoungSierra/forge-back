require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const TYPE_TO_STEP_KEY = {
  sprite:      'sprites',
  background:  'backgrounds',
  audio:       'audio',
  music:       'audio',
  code:        'code',
  ui_screen:   'uiux',
  hud:         'hud',
  icon:        'icons',
  concept_art: 'concept_art',
  splash_art:  'splash_art',
  marketing:   'marketing',
}

async function run() {
  const { data: assets, error } = await db()
    .from('assets')
    .select('id, type, step_key')
    .is('step_key', null)

  if (error) { console.error('Failed to fetch assets:', error.message); process.exit(1) }
  if (!assets?.length) { console.log('No assets with null step_key found. Nothing to do.'); process.exit(0) }

  console.log(`Found ${assets.length} assets with null step_key`)

  let updated = 0, skipped = 0
  for (const asset of assets) {
    const stepKey = TYPE_TO_STEP_KEY[asset.type]
    if (!stepKey) {
      console.log(`  SKIP  id=${asset.id}  type="${asset.type}" — no mapping`)
      skipped++
      continue
    }
    const { error: uErr } = await db().from('assets').update({ step_key: stepKey }).eq('id', asset.id)
    if (uErr) {
      console.error(`  ERROR id=${asset.id}:`, uErr.message)
    } else {
      console.log(`  OK    id=${asset.id}  type="${asset.type}" → step_key="${stepKey}"`)
      updated++
    }
  }

  console.log(`\nDone: ${updated} updated, ${skipped} skipped`)
}

run()
