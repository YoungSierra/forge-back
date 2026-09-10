// Registra un workflow de HERRAMIENTA: una imagen entra, una pieza sale.
//
// No es un deck. Un deck renderiza N páginas de una plantilla del estudio y cada una trae su
// prompt escrito; una herramienta opera sobre la pieza que el usuario tiene seleccionada —la
// segmenta, le cambia el ángulo, la refina— y su entrada es esa imagen, no una fuente declarada
// en el prompt. Por eso el `inject_config` tiene otra forma: `extra.image` en vez de `pages`.
//
// Igual que en el registrador de decks, el config se DERIVA del grafo:
//   entrada  → el único `LoadImage` del workflow (si hay más de uno, se aborta: no se adivina)
//   semilla  → el campo `seed` del nodo más cercano a la salida
//   salidas  → cada nodo `Save*`, por el nombre de su `filename_prefix`
//
// `--mask` marca la fila como `mask_capable`: la máscara viaja en el canal alfa de la imagen que
// se sube, que es lo que produce el pintor de máscara del front y lo que `LoadImage` publica en
// su salida MASK. Sin la bandera, el front no ofrece pintar.
//
// Uso:  node scripts/registrar-herramienta.js <workflow_api.json> <nombre> ["descripción"] [--mask] [--apply]
require('dotenv').config()
const fs = require('fs')
const { db } = require('../src/services/supabase.service')

const [, , RUTA, NOMBRE, DESCRIPCION] = process.argv
const APLICAR = process.argv.includes('--apply')
const MASK    = process.argv.includes('--mask')
if (!RUTA || !NOMBRE) {
  console.error('uso: node scripts/registrar-herramienta.js <workflow_api.json> <nombre> ["descripción"] [--mask] [--apply]')
  process.exit(1)
}

const esSave  = c => /^Save/i.test(c || '')
const enlaces = n => Object.entries(n?.inputs || {}).filter(([, v]) => Array.isArray(v) && typeof v[0] === 'string')

// Distancia hacia atrás desde un nodo, para elegir «el seed más cercano a la salida».
function aguasArriba (wf, raiz) {
  const dist = new Map(), cola = [[raiz, 0]]
  while (cola.length) {
    const [id, d] = cola.shift()
    if (!id || dist.has(id) || !wf[id]) continue
    dist.set(id, d)
    for (const [, v] of enlaces(wf[id])) cola.push([v[0], d + 1])
  }
  return dist
}

;(async () => {
  const wf = JSON.parse(fs.readFileSync(RUTA, 'utf8'))
  if (!Object.values(wf).some(n => n && n.class_type)) {
    console.error('*** ese archivo es el export del editor, no el de API (falta class_type) ***')
    process.exit(1)
  }

  const cargas = Object.entries(wf).filter(([, n]) => /^LoadImage/i.test(n.class_type || ''))
  const saves  = Object.entries(wf).filter(([, n]) => esSave(n.class_type))
  if (!saves.length)   { console.error('*** no hay ningún nodo Save* ***'); process.exit(1) }
  if (cargas.length !== 1) {
    console.error(`*** ${cargas.length} LoadImage: no se puede deducir cuál es la entrada del usuario ***`)
    for (const [id, n] of cargas) console.error(`      ${id} «${n._meta?.title || ''}»`)
    process.exit(1)
  }

  const [entradaId, entradaNodo] = cargas[0]
  const dist = aguasArriba(wf, saves[0][0])
  const conSeed = [...dist.entries()]
    .filter(([id]) => Object.prototype.hasOwnProperty.call(wf[id]?.inputs || {}, 'seed'))
    .sort((a, b) => a[1] - b[1])[0]

  const salidas = Object.fromEntries(saves.map(([id, n]) =>
    [id, String(n.inputs?.filename_prefix || `salida_${id}`).split('/').pop()]))

  const inject_config = {
    ...(conSeed ? { seed: { node: conSeed[0], field: 'seed' } } : {}),
    extra: { image: { node: entradaId, type: 'image', field: 'image' } },
    salidas,
  }

  console.log(`${NOMBRE}`)
  console.log(`  nodos: ${Object.keys(wf).length}`)
  console.log(`  entrada:  LoadImage ${entradaId} «${entradaNodo._meta?.title || ''}»`.slice(0, 110))
  console.log(`  semilla:  ${conSeed ? `nodo ${conSeed[0]} (${wf[conSeed[0]].class_type})` : '— ninguna'}`)
  console.log(`  salidas:  ${Object.entries(salidas).map(([id, n]) => `${n} (nodo ${id}, ${wf[id].class_type})`).join(' · ')}`)
  console.log(`  máscara:  ${MASK ? 'sí — el front ofrece pintarla' : 'no'}`)
  console.log(`\n  inject_config: ${JSON.stringify(inject_config)}`)

  const { data: ya } = await db().from('comfyui_workflows').select('id,name').eq('name', NOMBRE).maybeSingle()
  console.log(`\n${ya ? 'ya existe una fila con ese nombre: se actualiza' : 'no existe: se crea'}`)
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const fila = {
    name: NOMBRE,
    description: DESCRIPCION && !DESCRIPCION.startsWith('--') ? DESCRIPCION : `Herramienta de una imagen.`,
    workflow_json: wf,
    inject_config,
    is_active: true,
    mask_capable: MASK,
  }
  const { error } = ya
    ? await db().from('comfyui_workflows').update(fila).eq('id', ya.id)
    : await db().from('comfyui_workflows').insert(fila)
  if (error) { console.error(error.message); process.exit(1) }

  const { data: r } = await db().from('comfyui_workflows')
    .select('name,is_active,mask_capable,inject_config').eq('name', NOMBRE).single()
  const cfg = typeof r.inject_config === 'string' ? JSON.parse(r.inject_config) : r.inject_config
  console.log(`\n=== verificación ===\n  ${r.name} · activo=${r.is_active} · máscara=${r.mask_capable}`)
  console.log(`  entrada nodo ${cfg.extra?.image?.node} · salidas ${Object.values(cfg.salidas || {}).join(', ')}`)
})()
