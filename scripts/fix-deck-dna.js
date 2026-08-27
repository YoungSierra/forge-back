// Arregla los dos desajustes que `preflight-workflows.js` detecta:
//
//   1. `image_gen_model` que nombra un workflow inexistente. Pasa porque el generador de decks
//      resuelve por un mapa fijo en slide-composer y NUNCA lee la DNA, así que un nombre malo no
//      rompe la generación — solo los caminos que sí la leen, como iterar una página.
//   2. Outputs de deck sin `page_prefixes`. Sin eso no se puede resolver de qué output salió una
//      página cuando la clave de su sesión envejece por un rename.
//
// Solo actúa cuando la corrección es inequívoca: un nombre se corrige si al quitarle el segmento
// `Vertical_Slice_` aparece EXACTAMENTE un workflow registrado; las páginas se rellenan solo si
// ese output es el ÚNICO de su nodo que usa ese workflow, en cuyo caso las cubre todas.
//
// Uso:  node scripts/fix-deck-dna.js            (simula)
//       node scripts/fix-deck-dna.js --apply    (escribe)
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const APLICAR = process.argv.includes('--apply')

;(async () => {
  const { data: wfs } = await db().from('comfyui_workflows').select('name, inject_config')
  const registrados = new Map(wfs.map(w => [w.name, w]))

  const { data: nodes } = await db().from('forge_nodes').select('id, node_key, outputs')
  let cambios = 0

  for (const n of nodes) {
    const outs = Array.isArray(n.outputs) ? n.outputs : []
    if (!outs.length) continue
    let tocado = false

    // Primera pasada: corregir nombres.
    const conNombre = outs.map(o => {
      const modelo = o.image_gen_model
      if (!modelo || !String(modelo).startsWith('comfyui:')) return o
      const nombre = String(modelo).slice('comfyui:'.length)
      if (registrados.has(nombre)) return o

      const alterno = nombre.replace('Vertical_Slice_', '')
      if (alterno === nombre || !registrados.has(alterno)) {
        console.log(`  ⚠ ${n.node_key}/${o.key || o.name}: "${nombre}" no existe y no hay corrección inequívoca`)
        return o
      }
      console.log(`  nombre  ${n.node_key}/${o.key || o.name}: "${nombre}" → "${alterno}"`)
      tocado = true
      return { ...o, image_gen_model: `comfyui:${alterno}` }
    })

    // Segunda pasada: rellenar páginas, ya con los nombres buenos.
    const porWorkflow = {}
    for (const o of conNombre) {
      const m = o.image_gen_model
      if (!m || !String(m).startsWith('comfyui:')) continue
      const nm = String(m).slice('comfyui:'.length)
      ;(porWorkflow[nm] ||= []).push(o.key || o.name)
    }

    const finales = conNombre.map(o => {
      const m = o.image_gen_model
      if (!m || !String(m).startsWith('comfyui:')) return o
      const nombre = String(m).slice('comfyui:'.length)
      const wf = registrados.get(nombre)
      if (wf?.inject_config?.mode !== 'per_page') return o
      if ((o.page_prefixes || []).length) return o

      // Solo si es el único output del nodo sobre ese workflow: si son varios, el reparto es una
      // decisión de diseño y adivinarlo silenciosamente es peor que dejarlo marcado.
      if (porWorkflow[nombre].length !== 1) {
        console.log(`  ⚠ ${n.node_key}/${o.key || o.name}: ${porWorkflow[nombre].length} outputs comparten "${nombre}" — el reparto hay que declararlo a mano`)
        return o
      }
      const page_prefixes = (wf.inject_config.pages || []).map(p => p.name)
      if (o.image_count && o.image_count !== page_prefixes.length) {
        console.log(`  ⚠ ${n.node_key}/${o.key || o.name}: image_count=${o.image_count} pero el workflow tiene ${page_prefixes.length} páginas`)
        return o
      }
      console.log(`  páginas ${n.node_key}/${o.key || o.name}: ${page_prefixes.length} declaradas`)
      tocado = true
      return { ...o, page_prefixes }
    })

    if (!tocado) continue
    cambios++
    // Superposición sobre la fila viva: se reescribe `outputs` con los mismos objetos y solo los
    // campos tocados cambian. Nunca un full-replace armado desde cero.
    if (APLICAR) {
      const { error } = await db().from('forge_nodes').update({ outputs: finales }).eq('id', n.id)
      if (error) throw error
    }
  }

  console.log(`\n${cambios} nodo(s) ${APLICAR ? 'actualizados' : 'a actualizar'}`)
  if (!APLICAR) console.log('(simulación — usar --apply para escribir)')
})()
