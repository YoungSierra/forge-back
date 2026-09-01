// Aplica v2.9.25 (DefaultClarity): 1 fila de ADN (2.2), solo `default_prompt`.
//
// Dos precisiones de una línea, sin cambios de contrato ni de outputs:
//   P-1  el «No placeholders» exceptúa los anclajes `[ IMAGE: <id> ]`, que son justo lo que el
//        documento DEBE usar — el texto viejo podía leerse como que los prohibía.
//   P-2  el sobre de emisión es de `development_images` y de nadie más; el plan es un output de
//        TEXTO, bajo su propio '## development_image_plan', antes del bloque y nunca dentro.
//
// Se escriben SOLO los campos que cambian. Nunca la fila entera: el full-replace de v2.9.23 iba a
// revertir 13 executors de MiniMax a Sonnet en silencio.
//
// Uso:  node scripts/aplicar-v2_9_25.js            (simula)
//       node scripts/aplicar-v2_9_25.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const DIR = process.env.V2925_DIR
  || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Documents-V57-Studio-Forge/da14a22a-81f0-4a69-8c7d-14af2e78aa1f/scratchpad/v2925/Forge_v2.9.25'
const APLICAR = process.argv.includes('--apply')

const val = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
const igual = (a, b) => JSON.stringify(val(a)) === JSON.stringify(val(b))

;(async () => {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, 'nodes_v2.9.25.json'), 'utf8'))
  const fila = (Array.isArray(j) ? j : (j.nodes || j.rows))[0]
  const { data: viva } = await db().from('forge_nodes').select('*').eq('node_key', '2.2').single()

  const problemas = []
  if (fila.node_key !== '2.2') problemas.push(`la fila no es del 2.2 (${fila.node_key})`)
  if (!igual(fila.executor, viva.executor)) problemas.push(`el executor cambiaría: ${JSON.stringify(val(viva.executor))} → ${JSON.stringify(val(fila.executor))}`)
  if (!igual(fila.outputs, viva.outputs)) problemas.push('los outputs cambiarían — v2.9.25 dice que solo toca default_prompt')
  if (val(viva.metadata)?.dna_version !== '2.9.24') problemas.push(`la fila viva está en ${val(viva.metadata)?.dna_version}, se esperaba 2.9.24`)

  console.log('=== v2.9.25 sobre la fila viva ===')
  console.log(`  default_prompt: ${String(viva.default_prompt || '').length} → ${String(fila.default_prompt || '').length} chars`)
  console.log(`  dna_version:    ${val(viva.metadata)?.dna_version} → ${val(fila.metadata)?.dna_version}`)
  console.log(`  executor:       ${JSON.stringify(val(viva.executor))}  (sin tocar)`)
  console.log(`  outputs:        idénticos`)

  if (problemas.length) {
    console.error('\n*** NO SE APLICA ***')
    for (const p of problemas) console.error(`  · ${p}`)
    process.exit(1)
  }

  const bdir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(bdir, { recursive: true })
  fs.writeFileSync(path.join(bdir, 'nodo_2.2_pre_v2.9.25.json'), JSON.stringify(viva, null, 2))
  console.log(`\nrespaldo → ${path.join(bdir, 'nodo_2.2_pre_v2.9.25.json')}`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const { error } = await db().from('forge_nodes')
    .update({ default_prompt: fila.default_prompt, metadata: val(fila.metadata) })
    .eq('node_key', '2.2')
  if (error) { console.error('fallo al escribir:', error.message); process.exit(1) }

  const { data: rel } = await db().from('forge_nodes').select('default_prompt,metadata,executor,outputs').eq('node_key', '2.2').single()
  console.log('\n=== verificación ===')
  console.log(`  default_prompt idéntico al delta: ${rel.default_prompt === fila.default_prompt}`)
  console.log(`  dna_version: ${val(rel.metadata)?.dna_version}`)
  console.log(`  executor: ${JSON.stringify(val(rel.executor))}`)
  console.log(`  outputs intactos: ${igual(rel.outputs, viva.outputs)}`)
  // Las dos frases que el delta promete, comprobadas por su contenido y no por su tamaño.
  console.log(`  P-1 exceptúa los anclajes: ${/\[\s*IMAGE\s*:\s*<id>\s*\]/i.test(rel.default_prompt)}`)
  console.log(`  P-2 el plan es output de texto: ${/development_image_plan is a TEXT output/i.test(rel.default_prompt)}`)
})()
