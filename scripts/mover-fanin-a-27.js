// Mueve el punto de fan-in de 2.5 a 2.7: cada concepto llega hasta su propia presentación y su
// propia revisión, y el gate decide entre los dos.
//
// El motor elige el fan-in como «el primer nodo con CUALQUIER puerto one_or_more»
// (fan-out.service.js:50). Todo lo que queda entre el fan-out y ese nodo es un lane node; todo lo
// posterior queda fuera. Por eso 2.6 estaba fuera aunque no lo pidiera: venía después de 2.5.
//
// Uso:  node scripts/mover-fanin-a-27.js            (verifica y simula)
//       node scripts/mover-fanin-a-27.js --apply --backup=<ruta.json>
require('dotenv').config()
const fs = require('fs')
const { db } = require('../src/services/supabase.service')

const APLICAR = process.argv.includes('--apply')
const BACKUP  = process.argv.find(a => a.startsWith('--backup='))?.split('=')[1]

// Qué puerto pasa a qué cardinalidad. Lo que no está aquí no se toca.
const CAMBIOS = {
  '2.5': { concept_data: 'single', elevator_line: 'single', orientation_images: 'single', financial_case: 'single' },
  '2.6': { concept_data: 'single', financial_case: 'single' },
  '2.7': { investor_deck: 'one_or_more', review_verdict: 'one_or_more' },
}

;(async () => {
  const { data: nodos } = await db().from('forge_nodes')
    .select('id,node_key,title,inputs,metadata').in('node_key', Object.keys(CAMBIOS))

  const vivos = []
  const nuevos = []
  for (const n of nodos.sort((a, b) => a.node_key.localeCompare(b.node_key, undefined, { numeric: true }))) {
    vivos.push(n)
    const plan = CAMBIOS[n.node_key]
    const wired = (n.inputs?.wired || []).map(w => ({ ...w }))
    console.log(`\n${n.node_key} · ${n.title}`)
    let tocados = 0
    for (const w of wired) {
      const destino = plan[w.key]
      if (!destino) { console.log(`   ${w.key.padEnd(22)} ${String(w.cardinality || 'single').padEnd(12)} (sin cambio)`); continue }
      const antes = w.cardinality || 'single'
      if (antes === destino) { console.log(`   ${w.key.padEnd(22)} ${antes.padEnd(12)} (ya estaba)`); continue }
      w.cardinality = destino
      tocados++
      console.log(`   ${w.key.padEnd(22)} ${antes} → ${destino}`)
    }
    const faltan = Object.keys(plan).filter(k => !wired.some(w => w.key === k))
    if (faltan.length) console.log(`   ⚠ no existen en este nodo: ${faltan.join(', ')}`)
    nuevos.push({ id: n.id, node_key: n.node_key, inputs: { ...n.inputs, wired }, tocados })
  }

  // Comprobación de la topología resultante, con la MISMA regla del motor
  const cardsDe = ins => (ins?.wired || []).map(w => w.cardinality || 'single')
  console.log('\n=== topología resultante ===')
  for (const x of nuevos) {
    const tieneOOM = cardsDe(x.inputs).includes('one_or_more')
    console.log(`  ${x.node_key} · ¿tiene algún one_or_more? ${tieneOOM}  → ${tieneOOM ? 'sería FAN-IN' : 'lane node'}`)
  }
  const primerFanIn = nuevos.find(x => cardsDe(x.inputs).includes('one_or_more'))
  console.log(`\n  el fan-in pasaría a ser: ${primerFanIn?.node_key ?? 'NINGUNO (¡nadie converge!)'}`)
  if (primerFanIn?.node_key !== '2.7') {
    console.error('\nDETENIDO: el fan-in no queda en 2.7. No se escribió nada.')
    process.exit(1)
  }

  if (BACKUP) { fs.writeFileSync(BACKUP, JSON.stringify(vivos, null, 1)); console.log(`\nrespaldo → ${BACKUP}`) }
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  for (const x of nuevos) {
    const { error } = await db().from('forge_nodes').update({ inputs: x.inputs }).eq('id', x.id)
    if (error) { console.error(`  ✗ ${x.node_key}: ${error.message}`); process.exit(1) }
  }

  console.log('\n=== verificación posterior ===')
  const { data: v } = await db().from('forge_nodes').select('node_key,inputs').in('node_key', Object.keys(CAMBIOS))
  for (const n of v.sort((a, b) => a.node_key.localeCompare(b.node_key, undefined, { numeric: true }))) {
    console.log(`  ${n.node_key}: ${(n.inputs?.wired || []).map(w => `${w.key}:${w.cardinality || 'single'}`).join('  ')}`)
  }
})()
