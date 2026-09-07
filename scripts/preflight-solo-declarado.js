// «Sin sobre y sin plan, no hay llamada» — el pedido de Pedro, medido antes de aplicarlo.
//
// Su versión literal era «sin sección»; ésta es la corregida: un output cuyos prompts vienen de un
// plan hermano no emite sección y no debe emitirla, así que la regla mira si hay algo DECLARADO
// (sobre, arreglo con nombre, bloque json) o un plan, y solo apaga cuando no hay ninguno de los
// dos y el motor estaría adivinando a partir de la prosa.
//
// Se compara, por cada par (sesión × output de imagen) vivo, lo que el parser devuelve hoy contra
// lo que devolvería con la regla puesta. Lo que importa es la columna del medio: las corridas que
// hoy producen imágenes SOLO porque alguien leyó la prosa.
//
// Uso:  node scripts/preflight-solo-declarado.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { parseOutputItems, esDeck } = require('../src/services/image-gen.service')
const { planHermano } = require('../src/services/plan-hermano')

const CORTE = process.env.CORTE_SOBRE || '2026-09-01'

;(async () => {
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

  const silencio = console.log, silencioW = console.warn
  const nada = () => {}

  const tot = { declarado: 0, prosa: 0, cero: 0, deck: 0, conPlan: 0 }
  const rec = { declarado: 0, prosa: 0, cero: 0, conPlan: 0 }
  const apagadas = []

  for (const s of ses) {
    const n = porId[s.node_id]
    const { data: ms } = await db().from('forge_messages')
      .select('content,role').eq('session_id', s.id).order('order_index')
    const texto = (ms || []).filter(m => m.role === 'agent').pop()?.content
    if (!texto) continue
    const reciente = s.created_at >= CORTE

    for (const o of (n.outputs || []).filter(x => x.image_gen)) {
      const k = o.key || o.name
      if (await esDeck(o)) { tot.deck++; continue }

      console.log = nada; console.warn = nada
      let hoy = [], conRegla = []
      try { hoy = parseOutputItems(String(texto), o.format || 'png', k) || [] } catch {}
      try { conRegla = parseOutputItems(String(texto), o.format || 'png', k, true) || [] } catch {}
      console.log = silencio; console.warn = silencioW

      if (!hoy.length) { tot.cero++; if (reciente) rec.cero++; continue }
      if (conRegla.length) { tot.declarado++; if (reciente) rec.declarado++; continue }

      // Sale de la prosa. ¿Tiene un plan que lo respalde? Entonces la regla no lo apaga: el
      // despacho lee el plan antes de llegar al parser.
      const plan = planHermano(o)
      if (plan) { tot.conPlan++; if (reciente) rec.conPlan++; continue }

      tot.prosa++
      if (reciente) rec.prosa++
      apagadas.push({ nk: n.node_key, k, fecha: s.created_at.slice(0, 10), n: hoy.length, reciente })
    }
  }

  console.log('pares (sesión × output de imagen) que HOY producen imágenes:\n')
  console.log('                              toda la historia   desde ' + CORTE)
  console.log(`  de algo DECLARADO     :${String(tot.declarado).padStart(14)}${String(rec.declarado).padStart(18)}`)
  console.log(`  de prosa, pero con plan:${String(tot.conPlan).padStart(13)}${String(rec.conPlan).padStart(18)}   (la regla NO los toca)`)
  console.log(`  de prosa y sin plan   :${String(tot.prosa).padStart(14)}${String(rec.prosa).padStart(18)}   ← lo que se apaga`)
  console.log(`  ya dan cero           :${String(tot.cero).padStart(14)}${String(rec.cero).padStart(18)}`)
  console.log(`  decks                 :${String(tot.deck).padStart(14)}\n`)

  const agrupa = filas => {
    const m = {}
    for (const r of filas) { const kk = `${r.nk} ${r.k}`; m[kk] = m[kk] || { n: 0, img: 0 }; m[kk].n++; m[kk].img += r.n }
    return Object.entries(m).sort((a, b) => b[1].n - a[1].n)
  }
  const recientes = apagadas.filter(a => a.reciente)
  console.log(recientes.length
    ? `qué se apagaría de lo reciente (${recientes.length} corridas):`
    : 'de lo reciente no se apaga nada.')
  for (const [kk, v] of agrupa(recientes)) console.log(`  ${kk.padEnd(32)} ${String(v.n).padStart(3)} corrida(s), ${v.img} imagen(es)`)

  console.log('\ntoda la historia, por output:')
  for (const [kk, v] of agrupa(apagadas)) console.log(`  ${kk.padEnd(32)} ${String(v.n).padStart(3)} corrida(s), ${v.img} imagen(es)`)
})()
