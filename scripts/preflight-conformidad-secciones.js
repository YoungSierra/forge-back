// ¿El SECTION CONTRACT se está cumpliendo de verdad? No en el prompt — en las respuestas vivas.
//
// Para cada corrida de nodo entero de un nodo con contrato, cuenta cuántos de sus outputs de
// texto salieron bajo su propia clave. Un output fundido en la sección de un hermano no es un
// problema de pantalla: el output NO EXISTE. Medido el 01-09 en el 2.2 — concept_data, que
// alimenta nueve nodos, no aparecía en ninguna parte de la respuesta.
//
// Uso:  node scripts/preflight-conformidad-secciones.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const TEXTO = o => !o.image_gen && o.production !== 'deferred'

// Mismo criterio de match que el front: clave con `_` o espacio, sin distinguir mayúsculas, y se
// tolera una cola («— subtítulo», «(TDD §B)») como en extractSection.
function tieneSeccion (texto, clave) {
  const esc = clave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[_\\s]')
  return new RegExp(`^(#{1,4}\\s+)?\\**\\s*${esc}\\s*\\**(?:\\s*[—\\-–:(\\[].*)?\\s*$`, 'im').test(texto)
}

;(async () => {
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key,title,status,default_prompt,outputs')
  const conContrato = (nodos || []).filter(n =>
    n.status === 'active' &&
    /SECTION CONTRACT/.test(n.default_prompt || '') &&
    (n.outputs || []).filter(TEXTO).length >= 2)
  const porId = Object.fromEntries(conContrato.map(n => [n.id, n]))

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions').select('id,node_id,project_id,output_key,status,created_at').range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }
  // Solo corridas de nodo entero: una sesión enfocada en un output no debe traer a los hermanos.
  const enteras = ses.filter(s => porId[s.node_id] && !s.output_key)

  const CORTE = '2026-08-31'
  const nuevas = { completas: 0, fallan: 0 }
  let evaluadas = 0, completas = 0
  const fallos = []
  for (const s of enteras) {
    const n = porId[s.node_id]
    const { data: ms } = await db().from('forge_messages').select('role,content').eq('session_id', s.id).order('created_at')
    const c = [...(ms || [])].reverse().find(m => m.role === 'agent')?.content
    if (!c || c.length < 400) continue
    evaluadas++
    const textos = (n.outputs || []).filter(TEXTO).map(o => o.key || o.name)
    const faltan = textos.filter(k => !tieneSeccion(c, k))
    if (!faltan.length) { completas++; nuevas.completas += s.created_at >= CORTE ? 1 : 0; continue }
    if (s.created_at >= CORTE) nuevas.fallan++
    fallos.push({ nk: n.node_key, t: n.title, sid: s.id.slice(0, 8), de: textos.length, faltan, nueva: s.created_at >= CORTE })
  }

  console.log(`nodos con SECTION CONTRACT y 2+ outputs de texto: ${conContrato.length}`)
  console.log(`corridas de nodo entero evaluadas: ${evaluadas}`)
  console.log(`  cumplen el contrato entero: ${completas}`)
  console.log(`  les falta al menos un output: ${fallos.length}`)
  // El contrato se aplicó a la BD el 31-08 (v2.9.22 F-C / v2.9.23 F-D). Una corrida anterior no
  // podía cumplirlo: mezclarlas infla el fallo y hace ver como roto lo que nunca se pidió.
  const nTot = nuevas.completas + nuevas.fallan
  console.log(`\ncorridas POSTERIORES al contrato (${CORTE.slice(0, 10)}): ${nTot}`)
  console.log(`  cumplen: ${nuevas.completas}   ·   fallan: ${nuevas.fallan}\n`)

  const porNodo = {}
  for (const f of fallos) (porNodo[f.nk] ||= []).push(f)
  for (const nk of Object.keys(porNodo).sort()) {
    const g = porNodo[nk]
    const n2 = g.filter(f => f.nueva).length
    console.log(`  ${nk.padEnd(6)} ${g[0].t.slice(0, 30).padEnd(32)} ${String(g.length).padStart(2)} corrida(s)  ${n2 ? `· ${n2} POSTERIOR(ES) al contrato` : ''}`)
    const cuenta = {}
    for (const f of g) for (const k of f.faltan) cuenta[k] = (cuenta[k] || 0) + 1
    for (const [k, v] of Object.entries(cuenta).sort((a, b) => b[1] - a[1]))
      console.log(`         falta ${k.padEnd(28)} en ${v}`)
  }
})()
