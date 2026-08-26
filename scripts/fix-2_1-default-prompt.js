// ─── El 2.1 tiene que pedir sus TRES outputs, no solo el documento ───────────
//
// Medido el 26-08: al correr el nodo entero, el prompt que recibe el modelo (38.864 chars) no
// nombra `pitch_image_plan` ni una vez. Devuelve el documento porque es lo único que se le pide.
// Sin el plan, el pitch no tiene imágenes declaradas y el motor terminaba ofreciendo como sujetos
// las viñetas de «Numbers That Matter» — datos de mercado.
//
// La causa está en `canvas-chat.service.js:433`: cuando el nodo tiene `default_prompt`, ese texto
// REEMPLAZA el bloque «## Outputs to produce» en vez de sumarse. Le pasa a 28 de los 33 nodos con
// más de un output, así que arreglar el código toca todo el sistema y hay que medirlo aparte.
// Esto arregla el 2.1 nombrando sus outputs en su propio prompt, que es de un solo nodo.
//
// Uso:  node scripts/fix-2_1-default-prompt.js [--apply]

require('dotenv').config()
const fs   = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APPLY = process.argv.includes('--apply')

// Se conserva el texto que ya estaba y se le agrega el contrato de salidas. Cada línea resume el
// prompt del output, que en modo nodo-entero el modelo tampoco ve.
const CONTRATO = `

Emit THREE sections, each opened by a level-2 heading with the output's exact name:

## elevator_line
The locked line, one sentence, no hedging.

## pitch_image_plan
The decision record of which images this pitch needs — one entry per image, between 3 and 5. The
entry's TITLE is the image identifier, formatted pitch_NN_section (pitch_01_hook, pitch_02_why_now);
downstream nodes cite that title verbatim. Under each title: the target section, the subject, the
generation prompt, and why the image earns its place. This section is for review and is never
copied into the document.

## pitch_document
The one-page pitch, with its images rendered inline — one per entry of pitch_image_plan, each in
the section its entry declared and captioned with that entry's title. Never print the plan itself.

Without pitch_image_plan there are no declared images, and the pitch ships without art.`

;(async () => {
  const { data: n, error } = await db().from('forge_nodes')
    .select('id, node_key, title, default_prompt, outputs').eq('node_key', '2.1').eq('status', 'active').single()
  if (error) { console.error('ERR', error.message); process.exit(1) }

  if (/pitch_image_plan/.test(n.default_prompt || '')) {
    return console.log('ya estaba aplicado: el default_prompt ya nombra pitch_image_plan')
  }

  const nuevo = `${(n.default_prompt || '').trim()}${CONTRATO}`
  console.log(APPLY ? '### APLICANDO' : '### SIMULACIÓN')
  console.log(`\ndefault_prompt: ${(n.default_prompt || '').length} → ${nuevo.length} chars`)
  console.log('\nlos outputs quedan nombrados:')
  for (const o of n.outputs) console.log('  ', String(o.key).padEnd(18), nuevo.includes(o.key) ? '✔' : '✘')
  console.log('\n--- se AGREGA al final (no se toca lo que ya decía) ---')
  console.log(CONTRATO.trim())

  if (!APPLY) return console.log('\n→ correr con --apply')

  const dest = path.join(__dirname, '..', '..', '_Prod', 'backups',
    `forge_node_2_1_pre_outputs_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
  fs.writeFileSync(dest, JSON.stringify(n, null, 2), 'utf-8')
  console.log('\nbackup →', dest)

  const up = await db().from('forge_nodes').update({ default_prompt: nuevo }).eq('id', n.id)
  if (up.error) { console.error('ERR update', up.error.message); process.exit(1) }
  console.log('✔ aplicado')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
