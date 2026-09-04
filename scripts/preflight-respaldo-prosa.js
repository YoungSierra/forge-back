// Pedro pide quitar el respaldo que busca imágenes en la prosa, con una regla exacta:
// **sin sección no hay sobre, y sin sobre no hay llamada.**
//
// Esto mide esa regla, no una aproximación: para cada par (sesión, output de imagen) vivo se
// pregunta si la respuesta trae la sección propia del output, y cuántos ítems saca el parser.
// Lo que se perdería al aplicar la regla es exactamente lo que hoy produce imágenes SIN sección.
//
// Importa medirlo por fecha. El contrato del sobre entró el 1-sep; antes no había sección que
// leer, así que contar la historia entera hace que el respaldo parezca imprescindible cuando lo
// único que dice es que antes no existía la alternativa.
//
// Precedente: la vez que se volvió incondicional una regla parecida, 46 de 144 pares se fueron a
// cero —3.9 de 24 a 0, 3.3 de 14 a 0— y hubo que revertir. De ahí que esto se mida antes.
//
// Uso:  node scripts/preflight-respaldo-prosa.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { parseOutputItems, esDeck } = require('../src/services/image-gen.service')
const { extractSection } = require('../src/utils/extract-section')

;(async () => {
  const CORTE = process.env.CORTE_SOBRE || '2026-09-01'
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key,outputs').eq('status', 'active')
  const conImagen = nodos.filter(n => (n.outputs || []).some(o => o.image_gen))
  const porId = Object.fromEntries(conImagen.map(n => [n.id, n]))

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions')
      .select('id,node_id,output_key,created_at').in('node_id', conImagen.map(n => n.id)).range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }

  const silencio = console.log
  const nada = () => {}

  const tot = { conSeccion: 0, sinSeccion: 0, cero: 0, deck: 0 }
  const rec = { conSeccion: 0, sinSeccion: 0, cero: 0 }
  const perdidas = []

  for (const s of ses) {
    const n = porId[s.node_id]
    const claves = (n.outputs || []).map(o => o.key || o.name).filter(Boolean)
    const { data: ms } = await db().from('forge_messages')
      .select('content,role').eq('session_id', s.id).order('order_index')
    const texto = (ms || []).filter(m => m.role === 'agent').pop()?.content
    if (!texto) continue

    for (const o of (n.outputs || []).filter(x => x.image_gen)) {
      const k = o.key || o.name
      if (await esDeck(o)) { tot.deck++; continue }

      console.log = nada
      let items = []
      try { items = parseOutputItems(String(texto), o.format || 'png', k) || [] } catch { items = [] }
      console.log = silencio

      const reciente = s.created_at >= CORTE
      if (!items.length) { tot.cero++; if (reciente) rec.cero++; continue }

      const tieneSeccion = !!extractSection(String(texto), k, claves.filter(x => x !== k))
      if (tieneSeccion) { tot.conSeccion++; if (reciente) rec.conSeccion++; continue }

      tot.sinSeccion++
      if (reciente) rec.sinSeccion++
      perdidas.push({ nk: n.node_key, k, fecha: s.created_at.slice(0, 10), n: items.length, reciente })
    }
  }

  console.log('pares (sesión × output de imagen) que HOY producen imágenes:\n')
  console.log('                        toda la historia   desde ' + CORTE)
  console.log(`  con su sección  :${String(tot.conSeccion).padStart(12)}${String(rec.conSeccion).padStart(18)}`)
  console.log(`  SIN sección     :${String(tot.sinSeccion).padStart(12)}${String(rec.sinSeccion).padStart(18)}   ← lo que la regla apagaría`)
  console.log(`  ya dan cero     :${String(tot.cero).padStart(12)}${String(rec.cero).padStart(18)}`)
  console.log(`  decks           :${String(tot.deck).padStart(12)}\n`)

  const agrupa = filas => {
    const m = {}
    for (const r of filas) { const kk = `${r.nk} ${r.k}`; m[kk] = m[kk] || { n: 0, img: 0 }; m[kk].n++; m[kk].img += r.n }
    return Object.entries(m).sort((a, b) => b[1].n - a[1].n)
  }

  const recientes = perdidas.filter(p => p.reciente)
  console.log(recientes.length
    ? `qué se apagaría de lo reciente (${recientes.length} corridas):`
    : 'de lo reciente no se apagaría nada: todo lo que produce imágenes tiene su sección.')
  for (const [kk, v] of agrupa(recientes)) console.log(`  ${kk.padEnd(34)} ${String(v.n).padStart(3)} corrida(s), ${v.img} imagen(es)`)
})()
