// Aplica v2.9.30 (DocumentKnowsItsImages): 4 filas de ADN — 3.1, 3.3, 3.4, 3.7.
//
// Qué hace el delta: los cuatro documentos de fase 3 declaran a su hermano de imagen en
// `uses.siblings_if_present` y ganan un bloque IMAGE ANCHORS que los obliga a colocar cada imagen
// con `[ IMAGE: <id> ]` dentro de la sección del elemento que muestra. Además, «escena, no
// diagrama» en los seis sobres de imagen, y el VISUAL THREAD deja de pedir bloques vacíos.
//
// Comparado campo por campo contra el vivo antes de escribir: es ADITIVO. No borra un solo output
// ni toca `constraints`, `inputs`, `tools` ni `skills`. El executor del zip es el del vivo
// (Sonnet 4.6, cambio deliberado del equipo el 03-09) y aun así se comprueba: los zips de deltas
// anteriores llegaron a traer executors congelados que habrían revertido nodos en silencio.
//
// PUERTA PROPIA de este delta: las anclas solo sirven si el motor las lee enteras. Hasta el 04-09
// el lector cortaba el id en el primer guion —«Chain-sync is the score, not the time» resolvía a
// «Chain»— y un ancla que no resuelve se imprime como texto en el PDF. Antes de escribir se
// comprueba que `anchor.format` esté en su versión arreglada, contra un id real del 3.1.
//
// Uso:  node scripts/aplicar-v2_9_30.js            (simula)
//       node scripts/aplicar-v2_9_30.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')
const { idsDeAnclas } = require('../src/services/anchor.format')

const DIR = process.env.V2930_DIR
  || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Documents-V57-Studio-Forge/da14a22a-81f0-4a69-8c7d-14af2e78aa1f/scratchpad/v2930/Forge_v2.9.30'
const APLICAR = process.argv.includes('--apply')

const val = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
const igual = (a, b) => JSON.stringify(val(a)) === JSON.stringify(val(b))
const CAMPOS = ['inputs', 'outputs', 'constraints', 'default_prompt', 'metadata']

;(async () => {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, 'nodes_v2.9.30.json'), 'utf8'))
  const filas = Array.isArray(j) ? j : (j.nodes || j.rows)

  const problemas = []
  const plan = []

  // ── Puerta 0: el motor lee las anclas enteras ───────────────────────────────
  // Un id con guion es lo normal cuando el id es el nombre de un pilar, que es justo lo que este
  // delta prescribe para el 3.1. Si el lector todavía lo corta, el delta nace roto.
  const prueba = '[ IMAGE: Chain-sync is the score, not the time ]'
  const leido = idsDeAnclas(prueba)[0]
  if (leido !== 'Chain-sync is the score, not the time') {
    problemas.push(`el motor todavía trunca las anclas: leyó «${leido}» — aplicar primero el arreglo de anchor.format`)
  }

  // ── Las filas ───────────────────────────────────────────────────────────────
  for (const f of filas) {
    const { data: v } = await db().from('forge_nodes').select('*').eq('node_key', f.node_key).maybeSingle()
    if (!v) { problemas.push(`${f.node_key}: no existe`); continue }
    if (!igual(f.executor, v.executor)) {
      problemas.push(`${f.node_key}: el executor cambiaría · vivo ${JSON.stringify(val(v.executor))} → zip ${JSON.stringify(val(f.executor))}`)
    }
    // Ningún output puede desaparecer: es la falla que más caro sale y la más fácil de no ver.
    const clavesVivas = (val(v.outputs) || []).map(o => o.key || o.name)
    const clavesZip = (val(f.outputs) || []).map(o => o.key || o.name)
    for (const k of clavesVivas) if (!clavesZip.includes(k)) problemas.push(`${f.node_key}: se perdería el output ${k}`)

    // Los campos que este delta NO debe tocar.
    for (const k of ['constraints', 'inputs', 'tools', 'skills']) {
      if (k in f && !igual(f[k], v[k])) problemas.push(`${f.node_key}: ${k} cambiaría y no debería`)
    }

    const campos = {}
    for (const k of CAMPOS) if (k in f && !igual(f[k], v[k])) campos[k] = val(f[k])
    plan.push({ nk: f.node_key, campos, viva: v, nueva: f, clavesVivas, clavesZip })
  }

  console.log('=== v2.9.30 · DocumentKnowsItsImages ===\n')
  for (const p of plan) {
    console.log(`  ${p.nk.padEnd(5)} escribe: ${Object.keys(p.campos).join(', ') || 'nada'}`)
    console.log(`        executor ${JSON.stringify(val(p.viva.executor))}  (sin cambio)`)
    console.log(`        outputs ${p.clavesVivas.length} → ${p.clavesZip.length}, ninguno se pierde`)
    for (const o of (val(p.nueva.outputs) || [])) {
      const k = o.key || o.name
      const antes = (val(p.viva.outputs) || []).find(x => (x.key || x.name) === k)
      if (!antes) continue
      const dif = [...new Set([...Object.keys(o), ...Object.keys(antes)])].filter(x => !igual(o[x], antes[x]))
      if (!dif.length) continue
      const sib = (o.uses?.siblings_if_present || []).filter(s => !(antes.uses?.siblings_if_present || []).includes(s))
      console.log(`        ~ ${k.padEnd(22)} ${dif.join(', ')}${sib.length ? `  · declara hermano: ${sib.join(', ')}` : ''}`)
    }
    // El bloque de anclas tiene que citar el contrato literal, no una metavariable copiable.
    const doc = (val(p.nueva.outputs) || []).find(o => /_doc$|_spec$|_bible$/.test(o.key || o.name))
    if (doc) {
      const tieneAnclas = /IMAGE ANCHORS/.test(doc.prompt || '')
      const metavar = /\[\s*IMAGE:\s*<id>\s*\]/.test(doc.prompt || '')
      console.log(`        anclas en ${doc.key || doc.name}: ${tieneAnclas ? 'sí' : 'NO'}${metavar ? ' · ⚠ trae «<id>» literal' : ''}`)
    }
    console.log()
  }

  if (problemas.length) {
    console.error('*** NO SE APLICA ***')
    for (const x of problemas) console.error(`  · ${x}`)
    process.exit(1)
  }
  console.log('todas las puertas pasan: aditivo, sin perder outputs, executor intacto y el motor lee las anclas enteras.')

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const bdir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(bdir, { recursive: true })
  for (const p of plan) fs.writeFileSync(path.join(bdir, `nodo_${p.nk}_pre_v2.9.30.json`), JSON.stringify(p.viva, null, 2))
  console.log(`\nrespaldos → ${bdir}`)

  for (const p of plan) {
    if (!Object.keys(p.campos).length) continue
    const { error } = await db().from('forge_nodes').update(p.campos).eq('node_key', p.nk)
    if (error) { console.error(`${p.nk}: ${error.message}`); process.exit(1) }
  }

  console.log('\n=== verificación contra lo escrito ===')
  for (const p of plan) {
    const { data: r } = await db().from('forge_nodes')
      .select('executor,outputs,metadata,constraints,inputs,tools,skills,default_prompt').eq('node_key', p.nk).single()
    const okOut = igual(r.outputs, p.nueva.outputs)
    const okExe = igual(r.executor, p.viva.executor)
    const intactos = ['constraints', 'inputs', 'tools', 'skills'].every(k => igual(r[k], p.viva[k]))
    console.log(`  ${p.nk.padEnd(5)} v${val(r.metadata)?.dna_version} · outputs==delta ${okOut} · executor intacto ${okExe} · campos no tocados intactos ${intactos}`)
  }
})()
