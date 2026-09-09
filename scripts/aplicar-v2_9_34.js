// ─── v2.9.34 · entrega tipada + 3.8 como ensamble ───────────────────────────
//
// Superpone campo por campo sobre la fila VIVA; nunca reemplaza la fila entera. Los ZIP traen la
// fila completa y con ella cosas viejas —un `executor` de hace tres versiones, un modelo revertido
// a Sonnet— que se colarían sin que nadie las pidiera.
//
// Qué trae el delta, medido contra la BD del 09-09:
//   2.3, 3.15 → solo metadata (reemisión tipada; el contenido es idéntico a lo ya aplicado)
//   3.8       → +5 inputs (feel_statement, char_abilities, menu_tree, control_map, financial_case),
//               `assembly: true` + `template_ref` en gdd_source_md y gdd_complete,
//               fuera el skill `gdd_consistency_validation` (decisión 3: la aprobación aguas
//               arriba es la garantía), y constraints/default_prompt nuevos.
//   No cambia ningún `executor` ni se pierde un solo input.
//
// Uso:  node scripts/aplicar-v2_9_34.js [--apply]
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APLICAR = process.argv.includes('--apply')
const DELTA = process.argv.find(a => a.endsWith('.json') && !a.startsWith('--'))
  || path.join(__dirname, '..', '..', 'P-20260909', 'nodes_v2.9.34.json')
const BK = path.join(__dirname, '..', '..', '_Prod', 'backups')

// Los seis campos jsonb tienen que llegar TIPADOS. Los exports los mandan como string y guardarlos
// así rompe a todo el que los lee con `.map` — es el propio reporte que originó esta versión.
const JSONB = ['inputs', 'outputs', 'tools', 'skills', 'executor', 'metadata']
const desenv = v => {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!/^[[{]/.test(t)) return v
  try { return JSON.parse(t) } catch { return v }
}
const canon = v => {
  const ord = o => Array.isArray(o) ? o.map(ord) : (o && typeof o === 'object')
    ? Object.fromEntries(Object.keys(o).sort().map(k => [k, ord(o[k])])) : o
  return JSON.stringify(ord(desenv(v)))
}

// Lo que NO se toca aunque el delta lo traiga: la identidad de la fila y su historia.
const INTOCABLES = ['id', 'node_key', 'created_at', 'created_by', 'parent_id', 'phase', 'status']

;(async () => {
  const delta = JSON.parse(fs.readFileSync(DELTA, 'utf8'))
  console.log(`delta: ${DELTA}\nfilas: ${delta.length}\n`)
  if (!fs.existsSync(BK)) fs.mkdirSync(BK, { recursive: true })

  for (const d of delta) {
    const { data: vivo } = await db().from('forge_nodes').select('*').eq('id', d.id).maybeSingle()
    if (!vivo) { console.log(`✗ ${d.node_key}: no existe en la BD — se salta`); continue }
    console.log(`### ${d.node_key} ${vivo.title}`)

    const cambios = {}
    for (const k of Object.keys(d)) {
      if (INTOCABLES.includes(k) || k === 'updated_at') continue
      if (canon(vivo[k]) === canon(d[k])) continue
      cambios[k] = JSONB.includes(k) ? desenv(d[k]) : d[k]
      console.log(`   ~ ${k}`)
    }
    if (!Object.keys(cambios).length) { console.log('   (sin cambios)\n'); continue }

    // Guarda: ningún jsonb puede quedar como string.
    for (const k of JSONB) {
      if (k in cambios && typeof cambios[k] === 'string') throw new Error(`${d.node_key}: ${k} quedaría como string`)
    }
    // Guarda: no se pierde ningún input.
    if (cambios.inputs) {
      const claves = v => { const o = desenv(v) || []; const a = Array.isArray(o) ? o : Object.values(o).flat(); return a.map(x => typeof x === 'string' ? x : (x.key || x.name)) }
      const perdidos = claves(vivo.inputs).filter(x => x && !claves(cambios.inputs).includes(x))
      if (perdidos.length) throw new Error(`${d.node_key}: se perderían inputs — ${perdidos.join(', ')}`)
    }

    const ruta = path.join(BK, `nodo_${d.node_key}_pre_v2.9.34.json`)
    fs.writeFileSync(ruta, JSON.stringify(vivo, null, 2), 'utf8')
    console.log(`   respaldo → ${path.basename(ruta)}`)

    if (!APLICAR) { console.log('   (simulación)\n'); continue }
    const { error } = await db().from('forge_nodes').update(cambios).eq('id', d.id)
    if (error) throw error

    const { data: post } = await db().from('forge_nodes').select('*').eq('id', d.id).single()
    let fallos = 0
    for (const k of Object.keys(cambios)) {
      const ok = canon(post[k]) === canon(cambios[k])
      if (!ok) fallos++
      console.log(`   ${ok ? '✓' : '✗'} ${k} escrito`)
    }
    for (const k of JSONB) {
      if (typeof post[k] === 'string') { console.log(`   ✗ ${k} quedó como string en la BD`); fallos++ }
    }
    console.log(`   ${fallos ? '✗ ' + fallos + ' fallo(s)' : '✓ verificado'}\n`)
  }
  console.log(APLICAR ? 'listo' : '\n(simulación — usar --apply para escribir)')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
