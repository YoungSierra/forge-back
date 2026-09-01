// ¿Cuántas imágenes ya generadas NO se ven porque viven en otra sesión de la misma instancia?
//
// Un output se reparte entre sesiones: la corrida de nodo entero deja las suyas en la general y el
// despacho por plan abre una sesión propia del output. La mezcla vieja —`{...a, ...b}`— reemplaza
// la lista completa de la clave, así que la última en llegar borra a la otra. El chat enseña
// huecos vacíos teniendo las imágenes al lado, y quien aprieta ✦ paga un render que ya existe.
// Medido el 01-09 en el 2.2: tres en la enfocada, una en la general, se veía una.
//
// Uso:  node scripts/preflight-imagenes-repartidas.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const vieja = (a, b) => ({ ...a, ...b })
function nueva (base, extra) {
  const out = { ...(base || {}) }
  for (const [clave, lista] of Object.entries(extra || {})) {
    if (!Array.isArray(lista)) { out[clave] = lista; continue }
    const porIndice = new Map((out[clave] || []).map(it => [it.index, it]))
    for (const it of lista) {
      const previo = porIndice.get(it.index)
      if (!previo || (it.variations?.length ?? 0) > (previo.variations?.length ?? 0)) {
        porIndice.set(it.index, previo ? { ...previo, ...it } : it)
      }
    }
    out[clave] = [...porIndice.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  }
  return out
}
const contar = m => Object.values(m).flat().reduce((a, it) => a + (it.variations?.length ?? 0), 0)

;(async () => {
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key')
  const porId = Object.fromEntries((nodos || []).map(n => [n.id, n.node_key]))

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions')
      .select('id,project_id,node_id,project_node_id,output_key,output_images,created_at').range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }
  const conImg = ses.filter(s => s.output_images && Object.keys(s.output_images).length)

  // Agrupar por INSTANCIA: el mismo nodo del catálogo vive en varios lanes y no se mezclan entre sí.
  const grupos = {}
  for (const s of conImg) {
    const k = `${s.project_id}|${s.project_node_id || s.node_id}`
    ;(grupos[k] ||= []).push(s)
  }

  let instancias = 0, repartidas = 0, perdidasTotal = 0
  const casos = []
  for (const [k, lista] of Object.entries(grupos)) {
    instancias++
    if (lista.length < 2) continue
    repartidas++
    const orden = [...lista].sort((a, b) => a.created_at.localeCompare(b.created_at))
    let v = {}, n = {}
    for (const s of orden) { v = vieja(v, s.output_images); n = nueva(n, s.output_images) }
    const cv = contar(v), cn = contar(n)
    if (cn <= cv) continue
    perdidasTotal += cn - cv
    casos.push({ nk: porId[orden[0].node_id] ?? '?', sesiones: orden.length, v: cv, n: cn, proy: k.slice(0, 8) })
  }

  console.log(`instancias con imágenes: ${instancias}`)
  console.log(`  con imágenes repartidas en 2+ sesiones: ${repartidas}`)
  console.log(`  donde la mezcla vieja PERDÍA imágenes: ${casos.length}`)
  console.log(`  imágenes invisibles en total: ${perdidasTotal}\n`)
  for (const c of casos.sort((a, b) => (b.n - b.v) - (a.n - a.v))) {
    console.log(`  ${c.nk.padEnd(6)} proy ${c.proy}  ${c.sesiones} sesiones · se veían ${c.v} de ${c.n}  (+${c.n - c.v})`)
  }
})()
