// ¿Cuántas corridas vivas copiaron el playbook del skill en vez de seguirlo?
//
// La huella son los encabezados propios del skill apareciendo COMO encabezados en la respuesta,
// descontando los genéricos y las claves de output —esas sí van—. El umbral es tres: uno puede
// ser coincidencia de vocabulario, tres es el playbook.
//
// Sirve para dos cosas: ver el tamaño del problema hoy, y volver a correrlo después de que
// v2.9.31 haya circulado, para saber si la cláusula «SKILLS ARE METHOD, NOT CONTENT» funcionó.
//
// Uso:  node scripts/preflight-regurgitacion.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { getSkill } = require('../src/services/prompt.service')
const { huellaDeSkills, detectarRegurgitacion } = require('../src/services/regurgitacion')

;(async () => {
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key,skills,outputs').eq('status', 'active')
  const conSkills = nodos.filter(n => Array.isArray(n.skills) && n.skills.length)
  const porId = {}
  for (const n of conSkills) {
    const textos = await Promise.all(n.skills.map(s => getSkill(s).catch(() => null)))
    porId[n.id] = {
      nk: n.node_key,
      huella: huellaDeSkills(textos.filter(Boolean), (n.outputs || []).map(o => o.key || o.name)),
      skills: n.skills.length,
      cargados: textos.filter(Boolean).length,
    }
  }
  console.log('nodos con skills:', conSkills.length)
  for (const v of Object.values(porId)) {
    if (!v.cargados) console.log(`  ⚠ ${v.nk}: ${v.skills} skill(s) declarados, 0 cargados`)
  }
  console.log()

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions')
      .select('id,node_id,created_at').in('node_id', conSkills.map(n => n.id)).range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }

  let miradas = 0
  const casos = []
  for (const s of ses) {
    const info = porId[s.node_id]
    if (!info?.huella.length) continue
    const { data: ms } = await db().from('forge_messages')
      .select('content,role').eq('session_id', s.id).order('order_index')
    const t = (ms || []).filter(m => m.role === 'agent').pop()?.content
    if (!t) continue
    miradas++
    const r = detectarRegurgitacion(String(t), info.huella)
    if (r) casos.push({ nk: info.nk, fecha: s.created_at.slice(0, 10), chars: String(t).length, n: r.repetidos.length, ej: r.repetidos.slice(0, 4) })
  }

  console.log(`respuestas revisadas: ${miradas}`)
  console.log(`con el playbook copiado: ${casos.length} (${(100 * casos.length / Math.max(1, miradas)).toFixed(0)}%)\n`)

  const porNodo = {}
  for (const c of casos) { porNodo[c.nk] = porNodo[c.nk] || { n: 0, max: 0 }; porNodo[c.nk].n++; porNodo[c.nk].max = Math.max(porNodo[c.nk].max, c.chars) }
  for (const [nk, v] of Object.entries(porNodo).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${nk.padEnd(5)} ${String(v.n).padStart(3)} corrida(s) · la más larga: ${v.max.toLocaleString('es')} caracteres`)
  }
  console.log('\nlas más recientes:')
  for (const c of casos.sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 8)) {
    console.log(`  ${c.fecha} ${c.nk.padEnd(5)} ${String(c.chars).padStart(7)} ch · ${c.n} encabezados: ${c.ej.join(', ')}`)
  }
})()
