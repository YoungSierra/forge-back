// ─── v2.9.13 de Pedro, superpuesto sobre la fila viva ────────────────────────
//
// Dos bugs suyos: 1.4 avanzaba tres semillas cuando le pedían una, y el 2.1 imprimía el PLAN de
// imagen —con su justificación interna— dentro de un pitch para inversores.
//
// Se aplica por OUTPUT, no reemplazando el bloque `outputs` entero: el delta trae tres outputs y
// el nodo tiene los que tiene. Un full-replace es lo que revirtió el 3.9 en su momento.
//
// TRES COSAS QUE EL DELTA ROMPERÍA SI SE APLICARA TAL CUAL, y que este script preserva:
//
//   1. `uses.inputs: ["concept_seed"]` — el TIPO donde va la CLAVE. Es el bug que se arregló en la
//      base el 25-ago y que el delta arrastra desde la migración 027. Se corrige al vuelo a
//      `selected_seeds`; ver scripts/fix-uses-inputs.js.
//   2. `CARRY image_ref VERBATIM` — el prompt de 1.4/selected_seeds que trae el delta NO lo
//      incluye, y sin eso el hilo visual se corta en la selección. El propio changelog avisa
//      («apply v2.9.10 first, then this, or merge both»): se re-agrega desde la fila viva.
//   3. El ancla `## concept_seeds` del 1.1 no se toca porque este delta no toca el 1.1 — pero se
//      verifica al final, junto con el preflight, que nada quedó roto.
//
// Uso:  node scripts/apply-v2_9_13.js [--apply]

require('dotenv').config()
const fs   = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APPLY = process.argv.includes('--apply')
// La carpeta se pasa por argumento: Pedro re-derivó el delta desde la fila viva del 26-08 y lo
// reenvió, así que hay más de una versión del mismo paquete y hay que poder decir cuál.
const DIR   = process.argv.find(a => a.startsWith('--dir='))?.slice(6)
  ?? path.join(__dirname, '..', '..', 'P-26082026', 'x_v2913_new', 'v2913', 'patches')
// Los patches se descubren en la carpeta: cada paquete trae los nodos que trae, y una lista fija
// obligaba a editar el script en cada entrega.
const PATCHES = Object.fromEntries(fs.readdirSync(DIR)
  .filter(f => f.endsWith('_patch.json'))
  .map(f => [JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8')).node_key, f]))

// El tipo, y la clave que de verdad le corresponde en estos nodos.
const TIPO_POR_CLAVE = { concept_seed: 'selected_seeds' }
const ANCLA_IMAGE_REF = /CARRY image_ref VERBATIM[\s\S]*/

const corregirUses = (uses, nodeKey, outKey, avisos) => {
  if (!uses?.inputs) return uses
  const inputs = uses.inputs.map(ref => {
    const fix = TIPO_POR_CLAVE[ref]
    if (!fix) return ref
    avisos.push(`${nodeKey}/${outKey}: "${ref}" → "${fix}" (el delta traía el tipo, no la clave)`)
    return fix
  })
  return { ...uses, inputs: [...new Set(inputs)] }
}

;(async () => {
  const { data: nodes, error } = await db().from('forge_nodes')
    .select('id, node_key, title, outputs, inputs, purpose, constraints')
    .in('node_key', Object.keys(PATCHES)).eq('status', 'active')
  if (error) { console.error('ERR lectura:', error.message); process.exit(1) }

  if (APPLY) {
    const dest = path.join(__dirname, '..', '..', '_Prod', 'backups',
      `forge_nodes_pre_v2913_${new Date().toISOString().slice(0, 10)}.json`)
    fs.writeFileSync(dest, JSON.stringify(nodes, null, 2), 'utf-8')
    console.log('backup →', dest, '\n')
  }

  const avisos = []
  for (const n of nodes) {
    const p = JSON.parse(fs.readFileSync(path.join(DIR, PATCHES[n.node_key]), 'utf-8'))
    const cambios = {}
    console.log(`\n### ${n.node_key} ${n.title}`)

    // ── outputs: uno por uno, cada campo del delta sobre el output vivo ────────
    const outs = JSON.parse(JSON.stringify(n.outputs))
    for (const nuevo of (p.changes.outputs || [])) {
      const i = outs.findIndex(o => (o.key || o.name) === nuevo.key)
      if (i === -1) { console.log(`   ${nuevo.key}: NO existe en el nodo vivo — se AGREGA`); outs.push(nuevo); continue }

      const antes = outs[i]
      const fusion = { ...antes, ...nuevo }
      fusion.uses = corregirUses(nuevo.uses ?? antes.uses, n.node_key, nuevo.key, avisos)

      // El delta reescribe el prompt entero. Si el vivo tenía el bloque del hilo visual y el nuevo
      // no lo trae, se re-agrega: son instrucciones de deltas distintos sobre el mismo campo.
      if (nuevo.prompt && ANCLA_IMAGE_REF.test(String(antes.prompt || '')) && !/CARRY image_ref VERBATIM/.test(nuevo.prompt)) {
        const bloque = String(antes.prompt).match(ANCLA_IMAGE_REF)[0].trim()
        fusion.prompt = `${nuevo.prompt.trim()}\n\n${bloque}`
        avisos.push(`${n.node_key}/${nuevo.key}: se conservó el bloque "CARRY image_ref VERBATIM" que el delta no traía`)
      }

      const campos = Object.keys(nuevo).filter(k => JSON.stringify(antes[k]) !== JSON.stringify(fusion[k]))
      console.log(`   ${String(nuevo.key).padEnd(18)} cambia: ${campos.join(', ') || '(nada)'}`)
      outs[i] = fusion
    }

    // Un output que el delta declara eliminado: v2.9.13 saca `pitch_images` del 2.1.
    const quitar = (p.changes.remove_outputs || []).concat(
      n.node_key === '2.1' && !(p.changes.outputs || []).some(o => o.key === 'pitch_images') &&
      outs.some(o => (o.key || o.name) === 'pitch_images') ? ['pitch_images'] : [])
    for (const k of [...new Set(quitar)]) {
      const antes = outs.length
      const idx = outs.findIndex(o => (o.key || o.name) === k)
      if (idx !== -1) outs.splice(idx, 1)
      if (outs.length !== antes) console.log(`   ${String(k).padEnd(18)} ELIMINADO (el delta lo retira)`)
    }
    cambios.outputs = outs

    // ── campos sueltos del nodo ───────────────────────────────────────────────
    for (const campo of ['inputs', 'purpose', 'constraints', 'default_prompt']) {
      if (p.changes[campo] === undefined) continue
      if (JSON.stringify(p.changes[campo]) === JSON.stringify(n[campo])) continue
      cambios[campo] = p.changes[campo]
      console.log(`   ${campo}: se actualiza`)
    }

    if (!APPLY) continue
    const up = await db().from('forge_nodes').update(cambios).eq('id', n.id)
    if (up.error) { console.error('ERR update', n.node_key, up.error.message); process.exit(1) }
    console.log('   ✔ escrito')
  }

  console.log('\n── correcciones aplicadas sobre el delta ──')
  for (const a of avisos) console.log('  ·', a)
  console.log(APPLY ? '\n✔ aplicado — correr scripts/preflight-inputs.js para confirmar 0 rotas'
                    : '\n→ correr con --apply')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
