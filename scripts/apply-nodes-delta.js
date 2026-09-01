// Aplica un delta de Pedro que viene como FILAS COMPLETAS (nodes_vX.json), no como patch
// quirúrgico.
//
// Un full-replace del bloque `outputs` es lo que revirtió el 3.9 en su momento, así que acá se
// comprueba antes de escribir: ningún output puede desaparecer y ningún campo de un output puede
// perderse. Si algo se cae, se DETIENE y se reporta — no se escribe nada.
//
// Uso:  node scripts/apply-nodes-delta.js <nodes_vX.json>            (verifica y simula)
//       node scripts/apply-nodes-delta.js <nodes_vX.json> --apply
//       ... --backup=<ruta.json>   guarda las filas vivas antes de tocarlas
require('dotenv').config()
const fs = require('fs')
const { db } = require('../src/services/supabase.service')

const RUTA    = process.argv[2]
const APLICAR = process.argv.includes('--apply')
const BACKUP  = process.argv.find(a => a.startsWith('--backup='))?.split('=')[1]
if (!RUTA) { console.error('uso: <nodes_vX.json> [--apply] [--backup=ruta]'); process.exit(1) }

const parse = v => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : v)
const claveDe = o => o.key || o.name

// Campos de la fila que el delta puede traer. `id`, `created_at` y demás NO se tocan.
const CAMPOS = ['title', 'phase', 'purpose', 'inputs', 'outputs', 'constraints', 'tools',
                'skills', 'default_prompt', 'executor', 'standalone_prompt', 'role', 'metadata']

// Campos que NO se pisan aunque el delta los traiga. El ejecutor es el caso claro: el modelo de un
// nodo se cambia desde el admin y es una decisión del estudio, no de la DNA. Los deltas se derivan
// de un export viejo, así que arrastran el modelo de entonces: v2.9.23 habría devuelto trece nodos
// de MiniMax-M3 a Sonnet 4.6 sin que el changelog lo mencionara.
//
//   node scripts/apply-nodes-delta.js <json> --apply --conservar=executor,skills
const CONSERVAR = new Set(
  (process.argv.find(a => a.startsWith('--conservar='))?.split('=')[1] || '')
    .split(',').map(s => s.trim()).filter(Boolean))

;(async () => {
  const filas = JSON.parse(fs.readFileSync(RUTA, 'utf8'))
  console.log(`${filas.length} fila(s): ${filas.map(f => f.node_key).join(', ')}\n`)

  const vivos = {}
  let fallos = 0

  for (const f of filas) {
    const { data: vivo, error } = await db().from('forge_nodes').select('*').eq('node_key', f.node_key).single()
    if (error) { console.error(`  ✗ ${f.node_key}: ${error.message}`); fallos++; continue }
    vivos[f.node_key] = vivo

    const nuevos = parse(f.outputs) || []
    const actual = parse(vivo.outputs) || []
    const kn = new Set(nuevos.map(claveDe)), ka = new Set(actual.map(claveDe))

    const seVan = [...ka].filter(k => !kn.has(k))
    if (seVan.length) { console.error(`  ✗ ${f.node_key}: DESAPARECEN outputs → ${seVan.join(', ')}`); fallos++ }

    for (const k of [...ka].filter(k => kn.has(k))) {
      const a = actual.find(o => claveDe(o) === k), n = nuevos.find(o => claveDe(o) === k)
      const perdidos = Object.keys(a).filter(c => !(c in n))
      if (perdidos.length) { console.error(`  ✗ ${f.node_key}/${k}: SE PIERDEN campos → ${perdidos.join(', ')}`); fallos++ }
    }

    const llegan = [...kn].filter(k => !ka.has(k))
    console.log(`  ${f.node_key}: ${actual.length} → ${nuevos.length} outputs${llegan.length ? '  (+ ' + llegan.join(', ') + ')' : ''}` +
                `  · dna_version ${parse(vivo.metadata)?.dna_version ?? '—'} → ${parse(f.metadata)?.dna_version ?? '—'}`)
  }

  if (fallos) { console.error(`\nDETENIDO: ${fallos} problema(s). No se escribió nada.`); process.exit(1) }
  console.log('\nverificación OK: ningún output desaparece, ningún campo se pierde')

  if (BACKUP) {
    fs.writeFileSync(BACKUP, JSON.stringify(Object.values(vivos), null, 1))
    console.log(`respaldo de las filas vivas → ${BACKUP}`)
  }
  if (CONSERVAR.size) console.log(`\ncampos que NO se tocan: ${[...CONSERVAR].join(', ')}`)
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  for (const f of filas) {
    const upd = {}
    // El export trae TODO como string, incluidas las columnas json/array. Postgres rechaza
    // un text[] recibido como cadena JSON, así que se deserializa lo que sea deserializable.
    for (const c of CAMPOS) if (c in f && !CONSERVAR.has(c)) upd[c] = parse(f[c])
    const { error } = await db().from('forge_nodes').update(upd).eq('node_key', f.node_key)
    if (error) { console.error('  UPDATE ' + f.node_key + ': ' + JSON.stringify(error)); process.exit(1) }
  }

  console.log('\n=== verificación posterior ===')
  for (const f of filas) {
    const { data: v } = await db().from('forge_nodes').select('outputs, metadata').eq('node_key', f.node_key).single()
    const outs = parse(v.outputs) || []
    console.log(`  ${f.node_key}: ${outs.length} outputs · dna_version ${parse(v.metadata)?.dna_version}`)
  }
  // Y lo conservado: decir que no se tocó sin mirarlo es lo mismo que no haberlo conservado.
  for (const c of CONSERVAR) {
    const { data: vs } = await db().from('forge_nodes').select('node_key, ' + c).in('node_key', filas.map(f => f.node_key))
    const intactos = (vs || []).filter(v => {
      const enDelta = filas.find(f => f.node_key === v.node_key)?.[c]
      return enDelta !== undefined && JSON.stringify(parse(enDelta)) !== JSON.stringify(v[c])
    })
    console.log(`  ${c}: ${intactos.length} fila(s) conservaron su valor vivo, distinto del que traía el delta`)
  }
})()
