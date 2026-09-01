// ¿Qué haría el re-pedido de cierre sobre las corridas que YA existen? Sin llamar al modelo.
//
// Dos preguntas distintas, y las dos importan antes de soltar esto:
//   1. ¿A cuántos outputs les dispararía? Cada uno es una llamada al modelo que se paga.
//   2. ¿Dónde cosería la sección? Tiene que quedar ANTES del primer output de imagen — el
//      contrato dice que la respuesta cierra con el bloque de emisión y que no va nada después.
//      Pegándola al final, el parser de imágenes dejaría de encontrar el sobre como último bloque.
//
// Uso:  node scripts/preflight-repedido.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { extractSection } = require('../src/utils/extract-section')

const esTexto = o => typeof o === 'object' && !o.image_gen && o.production !== 'deferred'
  && o.assembly !== true && !['png', 'image'].includes(String(o.format || '').toLowerCase())
const esImagen = o => typeof o === 'object' && (o.image_gen || ['png', 'image'].includes(String(o.format || '').toLowerCase()))

;(async () => {
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key,title,outputs,status')
  const activos = (nodos || []).filter(n => n.status === 'active' && (n.outputs || []).filter(esTexto).length >= 2)
  const porId = Object.fromEntries(activos.map(n => [n.id, n]))

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions').select('id,node_id,output_key,created_at').range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }

  let corridas = 0, completas = 0, disparos = 0, alFinal = 0
  const porNodo = {}
  for (const s of ses.filter(x => porId[x.node_id] && !x.output_key)) {
    const n = porId[s.node_id]
    const { data: ms } = await db().from('forge_messages').select('role,content').eq('session_id', s.id).order('created_at')
    const c = [...(ms || [])].reverse().find(m => m.role === 'agent')?.content
    if (!c || c.trim().length < 400) continue
    corridas++

    const outs = n.outputs || []
    const claves = outs.map(o => o.key || o.name).filter(Boolean)
    const faltan = outs.filter(esTexto).map(o => o.key || o.name).filter(k => k && !extractSection(c, k, claves.filter(x => x !== k)))
    if (!faltan.length) { completas++; continue }
    disparos += faltan.length
    ;(porNodo[n.node_key] ||= { corridas: 0, faltan: {} }).corridas++
    for (const k of faltan) porNodo[n.node_key].faltan[k] = (porNodo[n.node_key].faltan[k] || 0) + 1

    // ¿Hay dónde coser antes del primer output de imagen?
    const imgKeys = outs.filter(esImagen).map(o => o.key || o.name).filter(Boolean)
    let corte = -1
    for (const ik of imgKeys) {
      const m = new RegExp(`^#{1,4}\\s*\\**\\s*${ik.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*$`, 'im').exec(c)
      if (m && (corte < 0 || m.index < corte)) corte = m.index
    }
    if (corte < 0 && imgKeys.length) alFinal++
  }

  console.log(`corridas de nodo entero evaluadas: ${corridas}`)
  console.log(`  ya completas (no dispara): ${completas}`)
  console.log(`  dispararía en: ${corridas - completas} corridas · ${disparos} llamadas al modelo\n`)
  console.log(`  de las que tienen output de imagen, sin sitio donde coser (iría al final): ${alFinal}`)
  console.log(`  — al final solo es seguro cuando el nodo NO tiene sobre de emisión que deba cerrar\n`)

  for (const nk of Object.keys(porNodo).sort()) {
    const g = porNodo[nk]
    console.log(`  ${nk.padEnd(6)} ${String(g.corridas).padStart(2)} corrida(s)`)
    for (const [k, v] of Object.entries(g.faltan).sort((a, b) => b[1] - a[1])) console.log(`         ${k.padEnd(26)} ×${v}`)
  }
})()
