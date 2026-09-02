// ¿Cuántas veces se ejecutó la misma herramienta dos veces en la misma corrida?
//
// El bucle de agente ejecutaba cada llamada que el modelo emitiera, sin memoria de lo ya hecho.
// Medido el 02-09 en el 2.5: trece `doc_gen_pptx` seguidos, uno cada dos o tres segundos, trece
// PPTX de doce diapositivas antes de que el modelo escribiera su respuesta. El texto que se le
// devuelve ya decía «no repitas el contenido»; la instrucción no bastó.
//
// Cada generación de documento cuesta tiempo de servidor y ocupa R2. Esto cuenta el desperdicio
// que ya ocurrió.
//
// Uso:  node scripts/preflight-herramientas-repetidas.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

;(async () => {
  let msgs = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_messages')
      .select('id,session_id,tool_calls,created_at').not('tool_calls', 'is', null).range(from, from + 999)
    if (!data?.length) break
    msgs = msgs.concat(data); if (data.length < 1000) break; from += 1000
  }

  const { data: ses } = await db().from('forge_sessions').select('id,node_id,project_id')
  const porSes = Object.fromEntries((ses || []).map(s => [s.id, s]))
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key')
  const nk = Object.fromEntries((nodos || []).map(n => [n.id, n.node_key]))

  let conLlamadas = 0, conRepetidas = 0, sobrantes = 0
  const casos = []
  for (const m of msgs) {
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
    if (!calls.length) continue
    conLlamadas++
    const cuenta = {}
    for (const c of calls) {
      const t = c.tool || c.name || '?'
      // Los generadores de documento: uno por corrida. Los demás, por argumentos.
      const firma = /^doc_gen_/.test(t) ? `doc:${t}` : `${t}:${JSON.stringify(c.args ?? c.input ?? {})}`
      cuenta[firma] = (cuenta[firma] || 0) + 1
    }
    const dobles = Object.entries(cuenta).filter(([, n]) => n > 1)
    if (!dobles.length) continue
    conRepetidas++
    const extra = dobles.reduce((a, [, n]) => a + (n - 1), 0)
    sobrantes += extra
    const s = porSes[m.session_id]
    casos.push({ nk: nk[s?.node_id] || '?', fecha: m.created_at.slice(0, 10), extra, det: dobles.map(([f, n]) => `${f.replace(/^doc:/, '')}×${n}`).join(', ') })
  }

  console.log(`mensajes con llamadas a herramienta: ${conLlamadas}`)
  console.log(`  con alguna repetida: ${conRepetidas}`)
  console.log(`  ejecuciones de más (lo que se habría ahorrado): ${sobrantes}\n`)
  for (const c of casos.sort((a, b) => b.extra - a.extra).slice(0, 15)) {
    console.log(`  ${c.nk.padEnd(6)} ${c.fecha}  +${String(c.extra).padStart(2)} de más · ${c.det.slice(0, 70)}`)
  }
})()
