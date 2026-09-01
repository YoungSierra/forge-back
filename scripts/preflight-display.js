// Mide el `forDisplay` del front contra TODAS las respuestas vivas: qué cambia, qué se rompe.
//
// Se transpila el .ts del front con su propio compilador — una copia a mano mediría otra cosa que
// la que ve el usuario. Ya pasó: un simulacro escrito a mano dijo 57.416 chars donde el front
// mostraba 100.
//
// Uso:  node scripts/preflight-display.js
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const FRONT = path.resolve(__dirname, '../../forge-front')
const ts = require(path.join(FRONT, 'node_modules/typescript'))
function cargar (rutaRelativa) {
  const src = fs.readFileSync(path.join(FRONT, rutaRelativa), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require)
  return mod.exports
}
const { forDisplay } = cargar('lib/json-display.ts')

// Prosa = lo que una persona escribió para leerse. Todo lo que tenga forma de par clave:valor de
// json queda fuera, con o sin comillas y empiece como empiece: renderizarlo le cambia la forma
// pero no lo pierde, y contarlo como pérdida tapa las de verdad. Me pasó dos veces hoy.
const esJson = l =>
  /^[`{[\]}<]/.test(l) ||
  /^"?[A-Za-z_][A-Za-z0-9_ ]*"?\s*:\s*["[{]/.test(l)
const prosa = t => t.split('\n')
  .map(l => l.trim())
  .filter(l => l.length > 40 && !esJson(l) && !/^[-*|#]/.test(l))

;(async () => {
  let msgs = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_messages')
      .select('id,content').eq('role', 'agent').not('content', 'is', null).range(from, from + 499)
    if (!data?.length) break
    msgs = msgs.concat(data); if (data.length < 500) break; from += 500
  }
  console.log(`respuestas vivas: ${msgs.length}\n`)

  let iguales = 0, cambian = 0, perdidas = 0, crudoAntes = 0, crudoDespues = 0
  const ejemplos = []
  for (const m of msgs) {
    const c = m.content
    let out
    try { out = forDisplay(c) } catch (e) { console.log(`  ✗ ${m.id.slice(0, 8)}: forDisplay lanzó — ${e.message}`); continue }
    // ¿queda json crudo a la vista?
    const crudo = t => (t.match(/^\s*"[a-z_]+":/gm) || []).length
    if (crudo(c) > 0) crudoAntes++
    if (crudo(out) > 0) crudoDespues++

    if (out === c) { iguales++; continue }
    cambian++
    // Se compara el TEXTO, no la puntuación del json: una línea que era `"algo",` y ahora es
    // `- algo` no se perdió, se renderizó. Sin esto la medición reportaba 39 pérdidas que no lo
    // eran y habría tapado las de verdad.
    const nucleo = l => l.replace(/^[-*\s]+/, '').replace(/^"|",?$|,$/g, '').trim()
    const falta = prosa(c).map(nucleo).filter(l => l.length > 40 && !out.includes(l))
    if (falta.length) {
      perdidas++
      if (ejemplos.length < 5) ejemplos.push({ id: m.id.slice(0, 8), n: falta.length, muestra: falta[0].slice(0, 90) })
    }
  }

  console.log(`sin cambios:            ${iguales}`)
  console.log(`cambian (se renderizan): ${cambian}`)
  console.log(`con líneas de prosa PERDIDAS: ${perdidas}`)
  ejemplos.forEach(e => console.log(`   ${e.id}: ${e.n} línea(s) · «${e.muestra}…»`))
  console.log(`\nrespuestas con json crudo a la vista: antes ${crudoAntes} → después ${crudoDespues}`)
  process.exit(perdidas ? 1 : 0)
})()
