// v2.9.15 de Pedro — 2.5/visual_pitch_plan: las imágenes ancla vienen SOLO del 2.4.
//
// El delta pide reemplazo QUIRÚRGICO: si algún `old` no coincide byte a byte con la fila viva,
// parar y reportar, porque significa que la base derivó. Este script lo verifica antes de tocar
// nada y solo escribe el output afectado — nunca el bloque `outputs` entero, que es como se
// revirtió el 3.9 en su momento.
//
// Uso:  node scripts/apply-v2_9_15.js            (verifica y simula)
//       node scripts/apply-v2_9_15.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APLICAR = process.argv.includes('--apply')
const PATCH = process.argv.find(a => a.startsWith('--patch='))?.split('=')[1]
  || 'C:/Users/Admin/Documents/V57 Studio/Forge/P-27082026/x_v2915/Forge_v2.9.15/patch_v2.9.15.json'

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

;(async () => {
  const delta = JSON.parse(fs.readFileSync(PATCH, 'utf8'))
  console.log(`delta ${delta.delta_version} · ${delta.patches.length} patch(es)\n`)

  for (const p of delta.patches) {
    const { data: node, error } = await db().from('forge_nodes')
      .select('id, node_key, outputs, metadata').eq('node_key', p.node_key).single()
    if (error) throw error

    const clave = /key=([^\]]+)/.exec(p.target)?.[1]
    const idx = node.outputs.findIndex(o => (o.key || o.name) === clave)
    if (idx < 0) throw new Error(`${p.node_key}: no existe el output "${clave}"`)

    const out = node.outputs[idx]
    const nuevoOut = JSON.parse(JSON.stringify(out))
    let fallos = 0

    for (const c of p.changes) {
      if (c.field === 'prompt') {
        const trae = String(out.prompt || '')
        if (!trae.includes(c.old)) {
          console.error(`  ✗ ${p.id} · prompt: el texto "old" NO está en la fila viva`)
          console.error(`     esperado: ${JSON.stringify(c.old).slice(0, 120)}…`)
          fallos++; continue
        }
        nuevoOut.prompt = trae.replace(c.old, c.new)
        console.log(`  ✔ ${p.id} · prompt: ${trae.length} → ${nuevoOut.prompt.length} chars`)
        console.log(`     − ${c.old}`)
        console.log(`     + ${c.new}`)
      } else if (c.field === 'uses.inputs') {
        const trae = out.uses?.inputs ?? []
        if (!igual(trae, c.old)) {
          console.error(`  ✗ ${p.id} · uses.inputs: no coincide`)
          console.error(`     vivo:     ${JSON.stringify(trae)}`)
          console.error(`     esperado: ${JSON.stringify(c.old)}`)
          fallos++; continue
        }
        nuevoOut.uses = { ...(out.uses || {}), inputs: c.new }
        console.log(`  ✔ ${p.id} · uses.inputs: ${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`)
      } else {
        console.error(`  ✗ campo no soportado: ${c.field}`); fallos++
      }
    }

    if (fallos) { console.error('\nDETENIDO: la base derivó respecto de la base del delta. No se escribió nada.'); process.exit(1) }

    if (!APLICAR) { console.log('\n(simulación — usar --apply para escribir)'); continue }

    // Superposición: se reescribe SOLO ese output; los demás quedan idénticos.
    const outputs = node.outputs.map((o, i) => i === idx ? nuevoOut : o)
    const metadata = { ...(node.metadata || {}), ...(p.metadata_update || {}) }
    const { error: e2 } = await db().from('forge_nodes').update({ outputs, metadata }).eq('id', node.id)
    if (e2) throw e2

    const { data: v } = await db().from('forge_nodes').select('outputs, metadata').eq('id', node.id).single()
    const vo = v.outputs.find(o => (o.key || o.name) === clave)
    console.log(`\n  escrito · outputs intactos: ${v.outputs.length === node.outputs.length}`)
    console.log(`  uses.inputs vivo: ${JSON.stringify(vo.uses?.inputs)}`)
    console.log(`  dna_version: ${v.metadata?.dna_version}`)
    console.log(`  el prompt ya NO menciona pitch_images: ${!/pitch_images/.test(vo.prompt || '')}`)
  }

  if (delta.out_of_scope_flags?.length) {
    console.log('\nfuera de alcance, sin tocar:')
    delta.out_of_scope_flags.forEach(f => console.log('  · ' + f))
  }
})()
