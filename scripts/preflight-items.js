// ¿Qué ítems saca el motor de cada respuesta viva? Compara el parser de HEAD contra el del árbol.
//
// Cada ítem es una imagen que se despacha y se paga. Un parser que toma el array equivocado no
// falla: gasta. Medido el 01-09 en el 1.1 — diez ítems, los diez `gaps_for_downstream`, cero
// semillas, y arte generado para «genre: Action».
//
// Uso:  node scripts/preflight-items.js
require('dotenv').config()
const cp = require('child_process')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const RAIZ = path.resolve(__dirname, '..')
const actual = require('../src/services/image-gen.service').parseOutputItems

// El parser de HEAD, cargado desde git sin tocar el árbol.
function parserDeHEAD () {
  const src = cp.execSync('git show HEAD:src/services/image-gen.service.js', { cwd: RAIZ, encoding: 'utf8', maxBuffer: 20e6 })
  const mod = { exports: {} }
  // Sus `require` relativos se resuelven contra src/services, no contra scripts/.
  const req = m => require(m.startsWith('.') ? path.join(RAIZ, 'src/services', m) : m)
  new Function('module', 'exports', 'require', '__dirname', src)(mod, mod.exports, req, path.join(RAIZ, 'src/services'))
  return mod.exports.parseOutputItems
}

;(async () => {
  const antes = parserDeHEAD()
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key,outputs')
  const porId = Object.fromEntries(nodos.map(n => [n.id, n]))

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions').select('id,node_id,output_key').range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }

  let evaluadas = 0, iguales = 0, cambian = 0
  const casos = []
  for (const s of ses) {
    const n = porId[s.node_id]
    if (!n) continue
    const outs = (n.outputs || []).filter(o => o.image_gen)
    if (!outs.length) continue
    const { data: ms } = await db().from('forge_messages').select('role,content').eq('session_id', s.id).order('created_at')
    const c = [...(ms || [])].reverse().find(m => m.role === 'agent')?.content
    if (!c) continue

    for (const o of outs) {
      const clave = o.key || o.name
      if (s.output_key && s.output_key !== clave) continue
      evaluadas++
      let a = [], b = []
      try { a = antes(c, o.format, clave) || [] } catch {}
      try { b = actual(c, o.format, clave) || [] } catch {}
      if (JSON.stringify(a) === JSON.stringify(b)) { iguales++; continue }
      cambian++
      const eranGaps = a.length && a.every(t => /^gap:/i.test(t.trim()))
      casos.push({ nk: n.node_key, clave, a: a.length, b: b.length, gaps: eranGaps, m1: (b[0] || '').slice(0, 52) })
    }
  }

  console.log(`pares (sesión, output de imagen) evaluados: ${evaluadas}`)
  console.log(`  iguales: ${iguales}`)
  console.log(`  cambian: ${cambian}`)
  const arregla = casos.filter(c => c.gaps).length
  console.log(`     de esos, dejaban de tomar los gaps: ${arregla}`)
  console.log(`     otros cambios: ${cambian - arregla}\n`)
  for (const c of casos.slice(0, 14)) {
    console.log(`  ${c.nk.padEnd(6)} ${c.clave.padEnd(20)} ${String(c.a).padStart(3)} → ${String(c.b).padStart(3)} ítems ${c.gaps ? '· eran gaps' : ''}  «${c.m1}»`)
  }
})()
