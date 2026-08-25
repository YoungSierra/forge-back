// ─── El gate del fan-out tiene que dejar JSON en el cuerpo de la respuesta ────
//
// parseItemsFromContent prefiere JSON y solo cae a raspar prosa si no lo encuentra. El prompt de
// 1.1/concept_seeds YA pide un array JSON — pero ese prompt solo se usa cuando el output corre
// SOLO. Con el nodo corrido entero (sesión output_key = null, «execute summarized manner») la
// respuesta es un documento, el JSON no aparece, y el parser termina leyendo cursivas como
// viñetas: así nacieron los lanes "[PROPOSED" de Smack v3 Pedrito.
//
// El 1.4 ya resuelve esto anclando una sección literal al final de la respuesta. Se le copia el
// mismo mecanismo al 1.1, pero con un bloque ```json — que es lo que el parser prefiere.
//
// Uso:  node scripts/fix-gate-json.js [--apply]

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APPLY = process.argv.includes('--apply')

const ANCLA = `

ALWAYS close your response with this section, even when the node was run as a whole and the answer is a document — it is machine-read to instantiate the concept lanes, and without it the lane names get scraped out of prose:

## concept_seeds

\`\`\`json
[{"id": "...", "title": "...", "one_liner": "...", "rationale": "...", "image_ref": {...}}]
\`\`\`

One object per seed, same values you used above. This block is the contract; the prose is the presentation.`

;(async () => {
  const { data: nodes, error } = await db().from('forge_nodes')
    .select('id, node_key, outputs').eq('node_key', '1.1').eq('status', 'active')
  if (error) { console.error('ERR', error.message); process.exit(1) }

  const n = nodes[0]
  const outs = JSON.parse(JSON.stringify(n.outputs))
  const o = outs.find(x => (x.key || x.name) === 'concept_seeds')
  if (!o) { console.error('ABORTA: 1.1 no tiene concept_seeds'); process.exit(1) }
  if (o.prompt.includes('## concept_seeds')) { console.log('ya estaba aplicado, no se toca'); return }

  console.log('prompt 1.1/concept_seeds:', o.prompt.length, '→', (o.prompt + ANCLA).length, 'chars')
  console.log('se AGREGA al final (no se reescribe nada de lo que ya dice):')
  console.log(ANCLA)

  if (!APPLY) return console.log('\n→ correr con --apply')

  const dir = path.join(__dirname, '..', '..', '_Prod', 'backups')
  fs.writeFileSync(path.join(dir, `forge_nodes_gate_json_${new Date().toISOString().slice(0,10)}.json`), JSON.stringify(nodes, null, 2), 'utf-8')

  o.prompt += ANCLA
  const up = await db().from('forge_nodes').update({ outputs: outs }).eq('id', n.id)
  if (up.error) { console.error('ERR update', up.error.message); process.exit(1) }
  console.log('\n✔ aplicado')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
