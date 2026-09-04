// ¿Sigue habiendo segundos despachos? Pedro pidió que el documento incruste por `id` lo ya
// renderizado y no vuelva a despachar, con esta métrica: imágenes por corrida = lo que declara
// la respuesta. Esto la calcula sobre TODAS las corridas vivas.
//
// Para cada sesión con imágenes se corren el guard y el parser de HOY contra el texto EXACTO que
// el modelo devolvió entonces, y se compara con las imágenes que de verdad se produjeron:
//
//   · «coincide»  → se renderizó lo que la respuesta declaraba.
//   · «de más»    → se renderizó MÁS de lo declarado: segundo despacho, o prosa ilustrada.
//                   Es lo que hay que ver en cero.
//   · «de menos»  → falló algún render, o el motor de entonces era más estricto. No es esto.
//
// Es retrospectivo a propósito: mide qué haría el motor de hoy con el material que ya existe,
// en vez de esperar a que vuelva a pasar y pagar otra vez para verlo.
//
// Uso:  node scripts/preflight-redespacho.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { parseOutputItems, esDeck } = require('../src/services/image-gen.service')
const { extractSection } = require('../src/utils/extract-section')

// El guard que corre en el despacho: si la respuesta trae secciones de OTROS outputs pero no la
// de éste, el output no se emitió y no hay nada que ilustrar.
const cortaElGuard = (texto, claves, clave) => {
  const conSeccion = claves.filter(k => extractSection(texto, k, claves.filter(x => x !== k)))
  return conSeccion.length > 0 && !conSeccion.includes(clave)
}

;(async () => {
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key,outputs').eq('status', 'active')
  const conImagen = nodos.filter(n => (n.outputs || []).some(o => o.image_gen))
  const porId = Object.fromEntries(conImagen.map(n => [n.id, n]))
  console.log(`nodos con outputs de imagen: ${conImagen.length}\n`)

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions')
      .select('id,node_id,project_id,output_key,output_images,created_at')
      .in('node_id', conImagen.map(n => n.id)).range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }

  let coincide = 0, deMas = 0, deMenos = 0, sinTexto = 0, decks = 0
  const casos = []

  for (const s of ses) {
    const n = porId[s.node_id]
    const claves = (n.outputs || []).map(o => o.key || o.name).filter(Boolean)

    for (const [clave, items] of Object.entries(s.output_images || {})) {
      const def = (n.outputs || []).find(o => (o.key || o.name) === clave)
      if (!def?.image_gen) continue
      // Un deck no se enumera desde la respuesta: sus páginas son nodos fijos del workflow y las
      // compone `generateDeck` desde los documentos aprobados. Compararlo contra el parser diría
      // «31 de más» en cada corrida del 3.20, que es ruido, no un segundo despacho.
      if (await esDeck(def)) { decks++; continue }
      const producidas = (items || []).filter(it => (it.variations || []).length || it.url).length
      if (!producidas) continue

      // El texto de esa corrida: el de esta sesión, o el de la general de la misma instancia.
      const { data: ms } = await db().from('forge_messages')
        .select('content,role').eq('session_id', s.id).order('order_index')
      let texto = (ms || []).filter(m => m.role === 'agent').pop()?.content
      if (!texto) { sinTexto++; continue }
      texto = String(texto)

      const cortado = cortaElGuard(texto, claves, clave)
      const declaradas = cortado ? 0 : (parseOutputItems(texto, def.format || 'png', clave) || []).length

      if (producidas === declaradas) { coincide++; continue }
      const fila = {
        nk: n.node_key, clave, fecha: s.created_at.slice(0, 10), sid: s.id.slice(0, 8),
        producidas, declaradas, cortado,
      }
      if (producidas > declaradas) { deMas++; casos.push(fila) } else deMenos++
    }
  }

  console.log('corridas con imágenes, comparadas contra el motor de hoy:\n')
  console.log(`  coinciden              : ${coincide}`)
  console.log(`  se renderizó DE MÁS    : ${deMas}   ← segundos despachos`)
  console.log(`  se renderizó de menos  : ${deMenos}`)
  console.log(`  sin texto que comparar : ${sinTexto}`)
  console.log(`  decks, no se enumeran  : ${decks}\n`)

  for (const c of casos.sort((a, b) => (b.producidas - b.declaradas) - (a.producidas - a.declaradas)).slice(0, 25)) {
    console.log(`  ${c.nk.padEnd(5)} ${c.clave.padEnd(22)} ${c.fecha}  ${c.sid}`
      + `  produjo ${String(c.producidas).padStart(2)} · hoy daría ${String(c.declaradas).padStart(2)}`
      + (c.cortado ? '  (el guard lo corta)' : ''))
  }
})()
