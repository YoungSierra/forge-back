// ¿Cuántas respuestas vivas empiezan CORTADAS por delante?
//
// Medido el 01-09 en el 2.2: el mensaje guardado empieza en «_document», o sea que se perdieron
// los diez caracteres de «## concept». El encabezado del PRIMER output es justo lo que se come, y
// es el que el SECTION CONTRACT necesita — la pestaña queda vacía y nadie sabe por qué.
//
// Señal: la respuesta abre con minúscula, guion bajo o cierre de etiqueta, en vez de con un
// encabezado, una viñeta o una mayúscula. Es heurística, así que se imprime el arranque para
// poder juzgar cada caso; el número solo dice dónde mirar.
//
// Uso:  node scripts/preflight-arranque-truncado.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const SOSPECHOSO = /^[a-z_>)\]}]/

;(async () => {
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key,executor')
  const porId = Object.fromEntries((nodos || []).map(n => [n.id, n]))

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions').select('id,node_id,created_at').range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }

  let total = 0
  const raros = []
  for (const s of ses) {
    const { data: ms } = await db().from('forge_messages').select('role,content').eq('session_id', s.id).order('created_at')
    const c = [...(ms || [])].reverse().find(m => m.role === 'agent')?.content
    if (!c || c.length < 200) continue
    total++
    const cab = c.trimStart()
    if (!SOSPECHOSO.test(cab)) continue
    const n = porId[s.node_id]
    raros.push({
      nk: n?.node_key ?? '?',
      modelo: (typeof n?.executor === 'string' ? JSON.parse(n.executor) : n?.executor)?.model ?? '?',
      fecha: s.created_at.slice(0, 10),
      ini: cab.slice(0, 60).replace(/\n/g, '\\n'),
    })
  }

  console.log(`respuestas evaluadas: ${total}`)
  console.log(`empiezan con minúscula/guion bajo/cierre: ${raros.length}\n`)
  for (const r of raros) console.log(`  ${r.nk.padEnd(6)} ${r.fecha} ${String(r.modelo).padEnd(22)} «${r.ini}»`)
})()
