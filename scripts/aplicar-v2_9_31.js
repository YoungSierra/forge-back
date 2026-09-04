// Aplica v2.9.31 (SectionsByName): 10 filas de ADN — 1.1, 2.1, 2.2, 2.4, 3.1, 3.3, 3.4, 3.7,
// 3.9, 3.20.
//
// Qué trae: el SECTION CONTRACT deja de ser genérico y ENUMERA los outputs por clave, en orden,
// con la herramienta al final; una cláusula universal «SKILLS ARE METHOD, NOT CONTENT» —un skill
// se sigue, nunca se emite—; `image_count` en los diez outputs de imagen que no lo tenían; y el
// sobre de 3.9 `reference_images`, que hasta hoy era prosa numerada.
//
// El origen es una corrida real del 3.3: 139.935 caracteres de los cuales el 45% era el playbook
// del skill copiado literal, sin `## item_catalog_sheet` por ningún lado, y el respaldo de prosa
// despachó renders que nadie pidió.
//
// PUERTAS
//   0 · La base del zip contra la tabla viva. Pedro pide expresamente parar si difieren, porque
//       su applier compara byte a byte contra ese export y un desvío significa que alguien tocó
//       una fila entremedio.
//   1 · El lector de anclas sin truncar. v2.9.30 dejó los ids como nombres verbatim —con espacios
//       y guiones— y este delta lo confirma; si el lector volviera a cortarlos, los ids nuevos
//       nacerían rotos.
//   2 · Nada se pierde: ningún output desaparece, y `constraints`, `inputs`, `tools` y `skills`
//       quedan intactos.
//   3 · El executor del zip es el del vivo. Los zips anteriores llegaron a traer executors
//       congelados que habrían revertido nodos en silencio.
//
// Uso:  node scripts/aplicar-v2_9_31.js            (simula)
//       node scripts/aplicar-v2_9_31.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')
const { idsDeAnclas } = require('../src/services/anchor.format')

const DIR = process.env.V2931_DIR
  || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Documents-V57-Studio-Forge/da14a22a-81f0-4a69-8c7d-14af2e78aa1f/scratchpad/v2931/Forge_v2.9.31'
const APLICAR = process.argv.includes('--apply')

const val = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
const igual = (a, b) => JSON.stringify(val(a)) === JSON.stringify(val(b))

// Para comparar contra lo que quedó ESCRITO hace falta ignorar el orden de las claves: jsonb no
// lo conserva, así que una fila idéntica vuelve de Postgres con los campos en otro orden y una
// comparación literal la reporta como distinta. Los arreglos sí mantienen su orden, que importa.
const ordenado = v => Array.isArray(v) ? v.map(ordenado)
  : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordenado(v[k])]))
  : v
const mismoContenido = (a, b) => JSON.stringify(ordenado(val(a))) === JSON.stringify(ordenado(val(b)))
const CAMPOS = ['inputs', 'outputs', 'constraints', 'default_prompt', 'metadata']
const COMPARAR = ['inputs', 'outputs', 'constraints', 'tools', 'skills', 'metadata', 'executor',
  'default_prompt', 'purpose', 'role', 'title', 'status', 'phase', 'standalone_prompt']

;(async () => {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, 'nodes_v2.9.31.json'), 'utf8'))
  const filas = Array.isArray(j) ? j : (j.nodes || j.rows)

  const baseRaw = JSON.parse(fs.readFileSync(path.join(DIR, 'base_export_20260903_plus_v2.9.30.json'), 'utf8'))
  const baseFilas = Array.isArray(baseRaw) ? baseRaw : (baseRaw.nodes || baseRaw.rows || Object.values(baseRaw)[0])
  const porBase = Object.fromEntries(baseFilas.map(f => [f.node_key, f]))

  const problemas = []
  const plan = []

  // ── Puerta 1: el motor lee las anclas enteras ───────────────────────────────
  const prueba = 'Chain-sync is the score, not the time'
  if (idsDeAnclas(`[ IMAGE: ${prueba} ]`)[0] !== prueba) {
    problemas.push('el motor todavía trunca las anclas — aplicar primero el arreglo de anchor.format')
  }

  for (const f of filas) {
    const { data: v } = await db().from('forge_nodes').select('*').eq('node_key', f.node_key).maybeSingle()
    if (!v) { problemas.push(`${f.node_key}: no existe`); continue }

    // ── Puerta 0: la base del zip contra lo vivo ─────────────────────────────
    // Una fila ya aplicada difiere de la base A PROPÓSITO —la base es el estado ANTERIOR—, así
    // que primero se pregunta si lo vivo ya es el delta. Sin esta distinción, correr el script
    // dos veces acusa a Pedro de haber cambiado algo cuando el único que escribió fui yo.
    const yaAplicada = COMPARAR.filter(c => c in f).every(c => mismoContenido(f[c], v[c]))
    const b = porBase[f.node_key]
    if (yaAplicada) {
      console.log(`  ${f.node_key.padEnd(5)} ya está aplicada (lo vivo es idéntico al delta)`)
    } else if (!b) {
      problemas.push(`${f.node_key}: no está en la base del zip`)
    } else {
      const desviado = COMPARAR.filter(c => c in b && !igual(b[c], v[c]))
      if (desviado.length) problemas.push(`${f.node_key}: la base difiere del vivo en ${desviado.join(', ')} — parar y avisar a Pedro`)
    }

    // ── Puertas 2 y 3 ────────────────────────────────────────────────────────
    if (!igual(f.executor, v.executor)) {
      problemas.push(`${f.node_key}: el executor cambiaría · vivo ${JSON.stringify(val(v.executor))} → zip ${JSON.stringify(val(f.executor))}`)
    }
    const clavesVivas = (val(v.outputs) || []).map(o => o.key || o.name)
    const clavesZip = (val(f.outputs) || []).map(o => o.key || o.name)
    for (const k of clavesVivas) if (!clavesZip.includes(k)) problemas.push(`${f.node_key}: se perdería el output ${k}`)
    for (const k of ['constraints', 'inputs', 'tools', 'skills']) {
      if (k in f && !igual(f[k], v[k])) problemas.push(`${f.node_key}: ${k} cambiaría y no debería`)
    }

    // Qué hay que escribir de verdad. Por contenido, no literal: si solo cambia el orden de las
    // claves que devuelve jsonb, no hay nada que escribir.
    const campos = {}
    for (const k of CAMPOS) if (k in f && !mismoContenido(f[k], v[k])) campos[k] = val(f[k])
    plan.push({ nk: f.node_key, campos, viva: v, nueva: f, clavesVivas, clavesZip })
  }

  console.log('=== v2.9.31 · SectionsByName ===\n')
  for (const p of plan) {
    console.log(`  ${p.nk.padEnd(5)} v${val(p.viva.metadata)?.dna_version} → v${val(p.nueva.metadata)?.dna_version}`
      + `  escribe: ${Object.keys(p.campos).join(', ') || 'nada'}`)
    for (const o of (val(p.nueva.outputs) || [])) {
      const k = o.key || o.name
      const antes = (val(p.viva.outputs) || []).find(x => (x.key || x.name) === k)
      if (!antes) { console.log(`        + NUEVO output ${k}`); continue }
      const dif = [...new Set([...Object.keys(o), ...Object.keys(antes)])].filter(x => !mismoContenido(o[x], antes[x]))
      if (!dif.length) continue
      const ic = o.image_count !== undefined && antes.image_count === undefined
        ? `  image_count=${JSON.stringify(o.image_count)}` : ''
      console.log(`        ~ ${k.padEnd(24)} ${dif.join(', ')}${ic}`)
    }
    // Las dos cláusulas que dan nombre a la entrega.
    const dp = String(p.nueva.default_prompt || '')
    if (Object.keys(p.campos).includes('default_prompt')) {
      console.log(`        secciones por nombre: ${/SECTION CONTRACT/i.test(dp) ? 'sí' : 'NO'}`
        + ` · skills como método: ${/SKILLS ARE METHOD/i.test(dp) ? 'sí' : 'NO'}`)
    }
  }

  if (problemas.length) {
    console.error('\n*** NO SE APLICA ***')
    for (const x of problemas) console.error(`  · ${x}`)
    process.exit(1)
  }
  console.log('\ntodas las puertas pasan: base == vivo, sin perder outputs, executor intacto, anclas enteras.')

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const bdir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(bdir, { recursive: true })
  for (const p of plan) fs.writeFileSync(path.join(bdir, `nodo_${p.nk}_pre_v2.9.31.json`), JSON.stringify(p.viva, null, 2))
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
    const intactos = ['constraints', 'inputs', 'tools', 'skills'].every(k => mismoContenido(r[k], p.viva[k]))
    const conCuenta = (val(r.outputs) || []).filter(o => o.image_gen && o.image_count !== undefined).length
    const deImagen = (val(r.outputs) || []).filter(o => o.image_gen).length
    console.log(`  ${p.nk.padEnd(5)} v${val(r.metadata)?.dna_version} · outputs==delta ${mismoContenido(r.outputs, p.nueva.outputs)}`
      + ` · executor intacto ${mismoContenido(r.executor, p.viva.executor)} · no tocados intactos ${intactos}`
      + ` · image_count ${conCuenta}/${deImagen}`)
  }
})()
