// Comprueba la segmentación del modal de output ejecutando el extractSection REAL del front,
// extraído del archivo, no una copia a mano.
//
// La copia a mano ya mintió una vez: la versión del script capturaba el nivel del encabezado y la
// publicada no, así que el simulacro daba 57.416 chars donde el front enseñaba 100. Cualquier
// medición de esto tiene que correr el código que se despliega.
//
// Uso:  node scripts/preflight-secciones.js                 (todos los proyectos, solo problemas)
//       node scripts/preflight-secciones.js <project_id>    (uno, con el detalle de cada output)
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const FRONT = path.resolve(__dirname, '../../forge-front/components/pipeline/ForgeCanvas.tsx')
const PROY  = process.argv[2] || null

function cargarExtractSection () {
  const src = fs.readFileSync(FRONT, 'utf8')
  const ini = src.indexOf('function extractSection(')
  if (ini < 0) throw new Error('no encontré extractSection en ' + FRONT)
  // Hasta la llave de cierre en columna 0
  const fin = src.indexOf('\n}', ini)
  const cuerpo = src.slice(ini, fin + 2)
    .replace(/: string\[\] = \[\]/g, ' = []')
    .replace(/: string(?=[,)])/g, '')
    .replace(/\): string \| null \{/, ') {')
    .replace(/let next: RegExpExecArray \| null/, 'let next')
  // eslint-disable-next-line no-new-func
  return new Function(`${cuerpo}; return extractSection`)()
}

;(async () => {
  const extractSection = cargarExtractSection()
  console.log(`extractSection cargado de ${path.basename(FRONT)}\n`)

  const { data: ns } = await db().from('forge_nodes').select('id,node_key,title,outputs')
  const nodos = Object.fromEntries(ns.map(n => [n.id, n]))

  let q = db().from('forge_assets').select('id,project_id,node_id,name,content,session_id').not('content', 'is', null)
  if (PROY) q = q.eq('project_id', PROY)
  let assets = [], from = 0
  for (;;) {
    const { data } = await q.range(from, from + 499)
    if (!data?.length) break
    assets = assets.concat(data); if (data.length < 500) break; from += 500
  }

  // Solo los runs de NODO ENTERO. El asset de un run enfocado contiene un único output, así que
  // las otras claves faltan con razón y contarlas como fallo infla la cifra hasta lo inservible.
  const sesIds = [...new Set(assets.map(a => a.session_id).filter(Boolean))]
  const generales = new Set()
  for (let i = 0; i < sesIds.length; i += 300) {
    const { data } = await db().from('forge_sessions').select('id,output_key').in('id', sesIds.slice(i, i + 300))
    ;(data || []).forEach(s => { if (!s.output_key) generales.add(s.id) })
  }
  assets = assets.filter(a => a.session_id && generales.has(a.session_id))

  let pares = 0, ok = 0, sin = 0, tragones = 0
  for (const a of assets) {
    const n = nodos[a.node_id]; if (!n) continue
    const keys = (n.outputs || []).map(o => o.key || o.name).filter(Boolean)
    if (keys.length < 2) continue
    const filas = []
    for (const k of keys) {
      pares++
      const sec = extractSection(a.content, k, keys.filter(x => x !== k))
      // Se queda con casi todo el documento sin ser su título: no se puede afirmar que esté mal
      // —puede ser la última sección y llevarse el resto con razón— pero es donde mirar primero
      // cuando una pestaña enseña de más.
      const esTitulo = new RegExp(`^#{1,4}[ \\t]+\\**\\s*${k.replace(/_/g, '[_ ]')}`, 'i').test(a.content.trimStart())
      const tragon = !!sec && sec.length > a.content.length * 0.9 && !esTitulo && keys.length > 2
      if (!sec) sin++; else if (tragon) tragones++; else ok++
      filas.push({ k, len: sec ? sec.length : 0, sec: !!sec, tragon })
    }
    const malas = filas.filter(f => !f.sec || f.tragon)
    if (PROY || malas.length) {
      console.log(`${n.node_key} · ${a.name} · ${a.content.length} chars`)
      for (const f of filas) {
        const marca = !f.sec ? 'SIN SECCIÓN' : f.tragon ? `${f.len} chars ⚠ llega hasta el final` : `${f.len} chars`
        console.log(`   ${f.k.padEnd(26)} ${marca}`)
      }
      console.log()
    }
  }
  console.log(`── ${pares} pares (asset,output): ${ok} con su sección · ${sin} sin sección · ${tragones} que llegan hasta el final`)
})()
