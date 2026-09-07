// Registra un workflow de ComfyUI que renderiza un DECK: muchas páginas en un solo grafo, cada
// una con su prompt, su salida y —a veces— un hueco para una imagen de referencia del proyecto.
//
// El `inject_config` se DERIVA del grafo, nunca se escribe a mano. Una página es un nodo de
// modelo con su SaveImage colgando; si su entrada viene de un ImageBatch, la primera rama es la
// plantilla del estudio y la segunda el hueco del proyecto. Escribir esa tabla a mano es como se
// llegó a un config que apuntaba a nodos inexistentes y a láminas con el marcador sin reemplazar.
//
// Registra una fila NUEVA por nombre. Reemplazar el deck que un nodo ya usa lo deja pidiendo
// páginas que no existen: los outputs fijan `pages` por índice y `image_count` por número, así que
// el maestro nuevo convive con el viejo hasta que la DNA apunte a él.
//
// Uso:  node scripts/registrar-deck.js <workflow_api.json> <nombre> ["descripción"]
//       node scripts/registrar-deck.js <workflow_api.json> <nombre> ["descripción"] --apply
require('dotenv').config()
const fs = require('fs')
const { db } = require('../src/services/supabase.service')

const [, , RUTA, NOMBRE, DESCRIPCION] = process.argv
const APLICAR = process.argv.includes('--apply')
if (!RUTA || !NOMBRE) {
  console.error('uso: node scripts/registrar-deck.js <workflow_api.json> <nombre> ["descripción"] [--apply]')
  process.exit(1)
}

// De dónde saca su referencia una página que tiene hueco. El motor lo lee del propio prompt, así
// que una página con hueco y sin esta frase se renderiza solo con la plantilla, en silencio.
const RX_FUENTE = /IMAGE 2 = [^\n]*coming from ([^.]+)\./
// El Art Bible cita en cambio la página del ASG que le sirve de canon.
const RX_ASG = /Art Style Guide \(ASG\s*[·.\-]?\s*(\d{1,2})\s*([^)]*)\)/i

;(async () => {
  const wf = JSON.parse(fs.readFileSync(RUTA, 'utf8'))

  // Puerta 1 · el export de API. El del editor trae `nodes`/`links` y ComfyUI lo rechaza.
  if (!Object.values(wf).some(n => n && n.class_type)) {
    console.error('*** ese archivo es el export del editor, no el de API (falta class_type) ***')
    process.exit(1)
  }

  const entradaArreglo = n => Object.values(n?.inputs || {}).find(v => Array.isArray(v))
  const modelos = Object.entries(wf).filter(([, n]) => /GPTImage|KSampler/i.test(n.class_type || ''))

  const paginas = []
  for (const [gid, gpt] of modelos) {
    const save = Object.entries(wf).find(([, n]) => n.class_type === 'SaveImage' && entradaArreglo(n)?.[0] === gid)
    if (!save) { console.warn(`el nodo de prompt ${gid} no tiene SaveImage`); continue }
    const nombre = String(save[1].inputs?.filename_prefix || '').split('/').pop() || `pagina_${gid}`

    const origen = wf[entradaArreglo(gpt)?.[0]]
    let refNode = null
    if (origen?.class_type === 'ImageBatch') {
      const segunda = Object.values(origen.inputs || {}).map(v => v?.[0])[1]
      if (wf[segunda]?.class_type === 'LoadImage') refNode = String(segunda)
    }
    paginas.push({ nombre, gid: String(gid), save: String(save[0]), ref: refNode, prompt: String(gpt.inputs?.prompt || '') })
  }
  paginas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'en', { numeric: true }))

  console.log(`${NOMBRE}`)
  console.log(`  nodos: ${Object.keys(wf).length} · páginas: ${paginas.length} · con hueco de referencia: ${paginas.filter(p => p.ref).length}\n`)
  for (const p of paginas) {
    const fuente = RX_FUENTE.exec(p.prompt)?.[1]?.trim()
    const asg = RX_ASG.exec(p.prompt)
    console.log(`  ${p.nombre.padEnd(28)} prompt=${p.gid.padStart(3)} save=${p.save.padStart(3)}`
      + (p.ref ? `  ref=${p.ref.padStart(3)} ← ${fuente || '¡no dice de dónde!'}` : '')
      + (asg ? `  canon ← ASG ${asg[1]} ${(asg[2] || '').trim()}` : ''))
  }

  // Puerta 2 · una página con hueco tiene que declarar su fuente.
  const sinFuente = paginas.filter(p => p.ref && !RX_FUENTE.exec(p.prompt))
  if (sinFuente.length) {
    console.error(`\n*** ${sinFuente.length} página(s) con hueco pero sin declarar su fuente ***`)
    process.exit(1)
  }
  if (!paginas.length) { console.error('\n*** no encontré ninguna página ***'); process.exit(1) }

  const inject_config = {
    mode: 'per_page',
    note: 'Un prompt por página. NO usar inject.prompt: este workflow no tiene un prompt único.'
      + (paginas.some(p => p.ref)
        ? ` Solo ${paginas.filter(p => p.ref).length} página(s) admiten referencia del proyecto; en las demás el único LoadImage es la maqueta del estudio y no se inyecta.`
        : ''),
    seed: { field: 'seed' },
    pages: paginas.map(p => {
      const fila = { name: p.nombre, save_node: p.save, prompt_node: p.gid }
      if (p.ref) fila.image_input = p.ref
      return fila
    }),
  }

  const { data: ya } = await db().from('comfyui_workflows').select('id,name').eq('name', NOMBRE).maybeSingle()
  console.log(`\n${ya ? 'ya existe una fila con ese nombre: se actualiza' : 'no existe: se crea'}`)
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const fila = {
    name: NOMBRE,
    description: DESCRIPCION && !DESCRIPCION.startsWith('--') ? DESCRIPCION : `Deck de ${paginas.length} páginas.`,
    workflow_json: wf,
    inject_config,
    is_active: true,
  }
  const { error } = ya
    ? await db().from('comfyui_workflows').update(fila).eq('id', ya.id)
    : await db().from('comfyui_workflows').insert(fila)
  if (error) { console.error(error.message); process.exit(1) }

  const { data: r } = await db().from('comfyui_workflows').select('name,is_active,inject_config').eq('name', NOMBRE).single()
  const cfg = typeof r.inject_config === 'string' ? JSON.parse(r.inject_config) : r.inject_config
  console.log(`\n=== verificación ===\n  ${r.name} · activo=${r.is_active} · ${cfg.pages.length} páginas`
    + ` · ${cfg.pages.filter(p => p.image_input).length} con hueco de referencia`)
})()
