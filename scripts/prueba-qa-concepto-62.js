// Prueba en memoria del paquete del QA de concepto (v2.9.62–64, «runner infinite» del 21-10). Sin base, sin red y sin
// renders: `db()` es un doble en memoria y `generateOneImage` no llama a ningún proveedor. Ejercita el código real:
//   A · referenciaDelProyecto — `pick: suffix`, `ref_fallback: none` (estricto) y que el routing de hoy no cambie
//   B · POST generate-item-image (ruta real en un express pelado) — no se paga un render mientras el motor renderiza
//       ese output (doble despacho), y regenerar una desfasada la SUSTITUYE y archiva la vieja (T02)
//   C · POST generate-pdf — un nodo sin output de documento no arma PDF (T10)
// Uso (desde forge-back): node scripts/prueba-qa-concepto-62.js
'use strict'
const path = require('path')
const RAIZ = path.resolve(__dirname, '..')

const tablas = {}
let secuencia = 0
const leerRuta = (fila, ruta) => ruta.split('->').reduce((o, k) => (o == null ? o : o[k]), fila)
function consulta(tabla) {
  const filtros = []
  let orden = null, limite = null, modo = null, escritura = null
  const q = {
    select() { return q },
    eq(c, v) { filtros.push(f => leerRuta(f, c) === v); return q },
    neq(c, v) { filtros.push(f => leerRuta(f, c) !== v); return q },
    in(c, vs) { filtros.push(f => vs.includes(leerRuta(f, c))); return q },
    is(c, v) { filtros.push(f => (leerRuta(f, c) ?? null) === v); return q },
    gte(c, v) { filtros.push(f => String(leerRuta(f, c)) >= String(v)); return q },
    not(c, op, v) { filtros.push(f => leerRuta(f, c) != null); return q },
    order(c, { ascending = true } = {}) { orden = { c, ascending }; return q },
    limit(n) { limite = n; return q },
    maybeSingle() { modo = 'maybe'; return q },
    single() { modo = 'single'; return q },
    insert(filas) { escritura = { tipo: 'insert', filas: [].concat(filas) }; return q },
    update(parche) { escritura = { tipo: 'update', parche }; return q },
    then(ok, ko) {
      try {
        const T = tablas[tabla] ||= []
        let data
        if (escritura?.tipo === 'insert') {
          data = escritura.filas.map(f => ({ id: `${tabla}-${++secuencia}`, created_at: new Date().toISOString(), ...JSON.parse(JSON.stringify(f)) }))
          T.push(...data)
        } else if (escritura?.tipo === 'update') {
          data = T.filter(f => filtros.every(p => p(f)))
          data.forEach(f => Object.assign(f, JSON.parse(JSON.stringify(escritura.parche))))
        } else {
          data = T.filter(f => filtros.every(p => p(f))).map(f => JSON.parse(JSON.stringify(f)))
          if (orden) data.sort((a, b) => (a[orden.c] < b[orden.c] ? -1 : a[orden.c] > b[orden.c] ? 1 : 0) * (orden.ascending ? 1 : -1))
          if (limite != null) data = data.slice(0, limite)
        }
        if (modo) data = data[0] ?? null
        return Promise.resolve({ data, error: null }).then(ok, ko)
      } catch (e) { return Promise.reject(e).then(ok, ko) }
    },
  }
  return q
}
const db = () => ({ from: consulta })
const sup = require(path.join(RAIZ, 'src/services/supabase.service'))
sup.db = db

// Ningún render real: el doble cuenta las llamadas y devuelve una url inventada.
const IG = require(path.join(RAIZ, 'src/services/image-gen.service'))
let renders = 0
IG.generateOneImage = async ({ item_index }) => { renders++; return { url: `https://r2/nueva-${item_index}-${renders}.png` } }

let fallos = 0
const linea = (ok, t) => { if (!ok) fallos++; console.log(`${ok ? '✔' : '✖'} ${t}`) }
const P = 'proy-1'
const reset = () => { for (const k of Object.keys(tablas)) delete tablas[k]; renders = 0 }
const png = (id, node_id, output_key, name, created_at, extra = {}) =>
  ({ id, project_id: P, node_id, output_key, name, format: 'png', status: 'approved', storage_url: `https://r2/${id}.png`, created_at, ...extra })

function nodos({ ruta21, ruta24 }) {
  tablas.forge_nodes = [
    { id: 'n11', node_key: '1.1', title: 'Concept Exploration', outputs: [{ key: 'concept_seeds', format: 'png', image_gen: true }] },
    { id: 'n21', node_key: '2.1', title: 'Pitch Document', outputs: [{ key: 'pitch_document', format: 'docx', type: 'asset', image_gen: true, image_routing: ruta21 }] },
    { id: 'n22', node_key: '2.2', title: 'Concept Development', outputs: [{ key: 'development_images', format: 'png', image_gen: true }, { key: 'concept_document', format: 'docx', type: 'asset' }] },
    { id: 'n24', node_key: '2.4', title: 'Visual Convergence', outputs: [{ key: 'orientation_images', format: 'png', type: 'asset', audience: 'internal', image_gen: true, image_routing: ruta24 }] },
  ]
}
const RUTA21_HOY = { ref_source: [{ node: '1.1', output: 'concept_seeds', pick: 'selected_seed' }], ref_fallback: 'library' }
const RUTA24_HOY = { ref_source: [{ node: '2.2', output: 'development_images' }, { node: '2.1', output: 'pitch_document' }], ref_fallback: 'library' }
const RUTA21_64 = { ref_source: [{ node: '1.1', output: 'concept_seeds', pick: 'selected_seed' }], ref_fallback: 'none' }
const RUTA24_64 = { ref_source: [{ node: '2.2', output: 'development_images', pick: 'suffix', suffix: '_core_loop' }], ref_fallback: 'none' }

// Lo que hay en el proyecto: dos semillas, imágenes del 2.2 (la core loop NO es la más reciente), un pitch, y una png
// cableada al 2.4 — que es lo que el camino «de siempre» tomaría.
function proyecto({ conCoreLoop = true, conSeleccion = true } = {}) {
  tablas.forge_assets = [
    png('s1', 'n11', 'concept_seeds', 'Concept Exploration — seed_01', '2026-10-21T21:41:01Z'),
    png('s2', 'n11', 'concept_seeds', 'Concept Exploration — seed_02', '2026-10-21T21:41:02Z'),
    png('px', 'n11', 'concept_seeds', 'Concept Exploration — Concept Seeds 5', '2026-10-21T21:42:36Z'),
    ...(conCoreLoop ? [png('d1', 'n22', 'development_images', 'Concept Development — dev_01_core_loop', '2026-10-21T22:34:12Z')] : []),
    png('d2', 'n22', 'development_images', 'Concept Development — dev_02_signature_mechanics', '2026-10-21T22:34:13Z'),
    png('p1', 'n21', 'pitch_document', 'Pitch Document — pitch_01_hook', '2026-10-21T22:11:01Z'),
  ]
  tablas.forge_project_nodes = [
    { id: 'pn14', project_id: P, node_id: 'n14', removed: false, bound_item_ref: conSeleccion ? { id: 'seed_02' } : null },
    { id: 'pn24', project_id: P, node_id: 'n24', removed: false, bound_item_ref: null },
    { id: 'pn22', project_id: P, node_id: 'n22', removed: false, bound_item_ref: null },
  ]
  tablas.forge_project_edges = [{ project_id: P, source_node_id: 'pn22', target_node_id: 'pn24', created_at: '2026-10-21T22:00:00Z' }]
}
const ref = (nodeId, outputKey) => IG.referenciaDelProyecto({ projectId: P, nodeId, outputKey })

;(async () => {
  console.log('── A · referenciaDelProyecto')
  reset(); nodos({ ruta21: RUTA21_HOY, ruta24: RUTA24_HOY }); proyecto()
  linea(await ref('n24', 'orientation_images') === 'https://r2/d2.png', 'routing de HOY (sin ref_fallback none): el 2.4 sigue tomando la más reciente del 2.2 — nada cambia hasta el v2.9.64')
  linea(await ref('n21', 'pitch_document') === 'https://r2/s2.png', 'routing de HOY: el 2.1 toma la semilla elegida (seed_02)')
  reset(); nodos({ ruta21: RUTA21_HOY, ruta24: RUTA24_HOY }); proyecto({ conSeleccion: false })
  linea(await ref('n21', 'pitch_document') === 'https://r2/px.png', 'routing de HOY sin selección: el 2.1 cae a la más reciente (el pixel-art del QA)')

  reset(); nodos({ ruta21: RUTA21_64, ruta24: RUTA24_64 }); proyecto()
  linea(await ref('n24', 'orientation_images') === 'https://r2/d1.png', 'v2.9.64: el 2.4 toma dev_01_core_loop aunque haya otra más reciente del 2.2')
  linea(await ref('n21', 'pitch_document') === 'https://r2/s2.png', 'v2.9.64: el 2.1 toma la semilla elegida en el 1.4 (seed_02)')
  reset(); nodos({ ruta21: RUTA21_64, ruta24: RUTA24_64 }); proyecto({ conCoreLoop: false, conSeleccion: false })
  linea(await ref('n24', 'orientation_images') === null, 'v2.9.64 sin imagen _core_loop: el 2.4 va SIN referencia (ni la más reciente, ni el pitch, ni la cableada)')
  linea(await ref('n21', 'pitch_document') === null, 'v2.9.64 sin semilla elegida: el 2.1 va SIN referencia — nunca «la más reciente»')
  reset(); nodos({ ruta21: RUTA21_64, ruta24: RUTA24_64 }); proyecto()
  tablas.forge_project_nodes[0].bound_item_ref = { id: 'seed_09' }
  linea(await ref('n21', 'pitch_document') === null, 'v2.9.64 con una semilla elegida que no tiene imagen: sin referencia')

  console.log('── B · generate-item-image')
  const express = require('express')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.auth = { memberId: null, token: null }; next() })
  app.use('/api/projects/:id/canvas', require(path.join(RAIZ, 'src/routes/forge-canvas.routes')))
  const srv = await new Promise(ok => { const s = app.listen(0, () => ok(s)) })
  const base = `http://127.0.0.1:${srv.address().port}/api/projects/${P}/canvas`
  const pedir = (ruta, body) => fetch(base + ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }))
  try {
    const hace = min => new Date(Date.now() - min * 60_000).toISOString()
    // El 1.1 del QA: la sesión general (chat) y la del despacho del motor, todavía `active`, sin imágenes escritas.
    reset(); nodos({ ruta21: RUTA21_HOY, ruta24: RUTA24_HOY })
    tablas.forge_sessions = [
      { id: 'gen', project_id: P, node_id: 'n11', project_node_id: 'pn11', output_key: null, status: 'active', output_images: null, started_at: hace(1) },
      { id: 'mot', project_id: P, node_id: 'n11', project_node_id: 'pn11', output_key: 'concept_seeds', status: 'active', output_images: null, started_at: hace(1) },
    ]
    tablas.forge_messages = [{ id: 'm1', session_id: 'gen', role: 'agent', order_index: 1, content: '## concept_seeds\n1. a\n2. b\n3. c' }]
    let r = await pedir('/nodes/n11/sessions/gen/generate-item-image', { output_key: 'concept_seeds', item_index: 0, item_text: 'seed one prompt' })
    linea(r.status === 409 && r.body.error === 'images_rendering' && renders === 0, `con el motor renderizando, el clic en el hueco vacío NO paga (409 images_rendering, ${renders} renders)`)
    r = await pedir('/nodes/n11/sessions/gen/generate-item-image', { output_key: 'concept_seeds', item_index: 0, item_text: 'seed one prompt', condition: 'hazlo de dia' })
    linea(r.status === 200 && renders === 1, 'iterar con condición sigue pasando (es una variación pedida, no un hueco vacío)')
    tablas.forge_sessions[1].started_at = hace(30)
    renders = 0
    r = await pedir('/nodes/n11/sessions/gen/generate-item-image', { output_key: 'concept_seeds', item_index: 2, item_text: 'seed three prompt' })
    linea(r.status === 200 && renders === 1, 'una sesión `active` de hace 30 min (proceso muerto) no bloquea para siempre')

    // T02: la semilla 0 quedó desfasada en la sesión general Y en la del motor; se regenera desde la general.
    reset(); nodos({ ruta21: RUTA21_HOY, ruta24: RUTA24_HOY })
    tablas.forge_sessions = [
      { id: 'gen', project_id: P, node_id: 'n11', project_node_id: 'pn11', output_key: null, status: 'approved', started_at: hace(60),
        output_images: { concept_seeds: [{ index: 0, id: 'seed_01', outdated: true, variations: [{ url: 'https://r2/g-old.png', condition: null }] }, { index: 1, id: 'seed_02', variations: [{ url: 'https://r2/g1.png', condition: null }] }] } },
      { id: 'mot', project_id: P, node_id: 'n11', project_node_id: 'pn11', output_key: 'concept_seeds', status: 'auto_approved', started_at: hace(60),
        output_images: { concept_seeds: [{ index: 0, id: 'seed_01', outdated: true, variations: [{ url: 'https://r2/m-old.png', condition: null }] }, { index: 1, id: 'seed_02', variations: [{ url: 'https://r2/m1.png', condition: null }] }] } },
    ]
    tablas.forge_assets = [png('a-old', 'n11', 'concept_seeds', 'Concept Exploration — seed_01', hace(60), { storage_url: 'https://r2/m-old.png', session_id: 'mot' })]
    tablas.forge_messages = []
    r = await pedir('/nodes/n11/sessions/gen/generate-item-image', { output_key: 'concept_seeds', item_index: 0, item_text: 'seed one NEW prompt', item_id: 'seed_01' })
    const g0 = tablas.forge_sessions[0].output_images.concept_seeds.find(i => i.id === 'seed_01')
    const m0 = tablas.forge_sessions[1].output_images.concept_seeds.find(i => i.id === 'seed_01')
    linea(r.status === 200 && g0.variations.length === 1 && g0.variations[0].url.startsWith('https://r2/nueva-') && !g0.outdated,
      'regenerar la desfasada la SUSTITUYE: una sola variación, la nueva, sin marca outdated')
    linea(g0.historial?.[0]?.url === 'https://r2/g-old.png', 'la vieja pasa al historial de esa entrada')
    linea(m0.variations.length === 0 && m0.historial?.[0]?.url === 'https://r2/m-old.png' && m0.reemplazada_en === 'gen',
      'la desfasada de la sesión del motor también se archiva (sin variaciones vigentes)')
    linea(tablas.forge_assets.find(a => a.id === 'a-old').status === 'superseded', 'su png deja de estar aprobado (superseded): no llega a los nodos de abajo')
    const m1 = tablas.forge_sessions[1].output_images.concept_seeds.find(i => i.id === 'seed_02')
    linea(m1.variations.length === 1 && !m1.historial, 'la semilla vecina, que no estaba desfasada, no se toca')

    // Iterar una que NO está desfasada sigue versionando (se suma, no sustituye).
    r = await pedir('/nodes/n11/sessions/gen/generate-item-image', { output_key: 'concept_seeds', item_index: 1, item_text: 'seed two', item_id: 'seed_02', condition: 'más oscuro' })
    const g1 = tablas.forge_sessions[0].output_images.concept_seeds.find(i => i.id === 'seed_02')
    linea(r.status === 200 && g1.variations.length === 2 && !g1.historial, 'iterar una vigente sigue sumando variaciones (el radial Iterate no cambia)')

    console.log('── C · generate-pdf')
    reset(); nodos({ ruta21: RUTA21_HOY, ruta24: RUTA24_HOY })
    r = await pedir('/nodes/n24/generate-pdf', {})
    linea(r.status === 422 && r.body.error_code === 'no_document_output', 'el 2.4 (solo un output interno de imágenes) no arma PDF: 422 no_document_output')
    r = await pedir('/nodes/n22/generate-pdf', {})
    linea(r.status !== 422, `el 2.2 (con concept_document) sigue pasando la guarda (aquí ${r.status}: no hay sesión aprobada en la base en memoria)`)
  } finally { srv.close() }

  console.log(fallos ? `\n${fallos} ✖ — revisar` : '\ntodas las comprobaciones como deben')
  process.exit(fallos ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
