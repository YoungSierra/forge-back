// Registra el Art Style Guide de 25 páginas como workflow NUEVO.
//
// No pisa `V57_STUDIO_ArtStyleGuide_Template`, que es el de 34 páginas y es el que el 3.20 usa
// hoy: sus outputs declaran `pages` con índices 1..34, así que reemplazarlo dejaría al nodo
// pidiendo páginas que ya no existen. La fila nueva no la referencia nadie hasta que la DNA de
// 25 páginas apunte a ella, y mientras tanto no cambia nada.
//
// El `inject_config` se deriva del propio workflow, no se escribe a mano: cada grupo es una
// página, y dentro caen su OpenAIGPTImage1, su SaveImage y sus LoadImage. Ocho páginas llevan
// ImageBatch —plantilla en `image1`, referencia del proyecto en `image2`—, que es exactamente lo
// que dice el §1.1 de Miguel: solo 01, 02, 03, 04, 05, 06, 08 y 09 admiten referencia.
//
// El motor ya sabe alimentar ese hueco: lee del propio prompt la frase «IMAGE 2 = … coming from
// X.» y resuelve X contra los nodos del proyecto, tomando la aprobada más reciente. Comprobado:
// las 8 páginas traen la frase.
//
// Uso:  node scripts/registrar-asg25.js <ruta_al_workflow_api.json>            (simula)
//       node scripts/registrar-asg25.js <ruta_al_workflow_api.json> --apply
require('dotenv').config()
const fs = require('fs')
const { db } = require('../src/services/supabase.service')

const RUTA = process.argv[2]
const APLICAR = process.argv.includes('--apply')
const NOMBRE = process.env.ASG25_NOMBRE || 'V57_STUDIO_ArtStyleGuide_Template_25'
if (!RUTA) { console.error('uso: node scripts/registrar-asg25.js <workflow_api.json> [--apply]'); process.exit(1) }

;(async () => {
  const wf = JSON.parse(fs.readFileSync(RUTA, 'utf8'))

  // Puerta 1: tiene que ser el export de API. El del editor trae `nodes`/`links` y ComfyUI lo
  // rechaza en /prompt — es el error que costó un día de ida y vuelta.
  const esApi = Object.values(wf).some(n => n && n.class_type)
  if (!esApi) { console.error('*** ese archivo es el export del editor, no el de API (falta class_type) ***'); process.exit(1) }

  // Las páginas, leídas del grafo. Una página = un OpenAIGPTImage1 con su SaveImage colgando.
  const entradaArreglo = n => Object.values(n?.inputs || {}).find(v => Array.isArray(v))
  const gpts = Object.entries(wf).filter(([, n]) => n.class_type === 'OpenAIGPTImage1')
  const paginas = []
  for (const [gid, gpt] of gpts) {
    const save = Object.entries(wf).find(([, n]) => n.class_type === 'SaveImage' && entradaArreglo(n)?.[0] === gid)
    if (!save) { console.warn(`el nodo de prompt ${gid} no tiene SaveImage`); continue }
    const nombre = String(save[1].inputs?.filename_prefix || '').split('/').pop() || `pagina_${gid}`

    // El hueco de referencia: si la entrada del modelo viene de un ImageBatch, la SEGUNDA entrada
    // del batch es la referencia del proyecto y la primera la plantilla del estudio.
    const origen = wf[entradaArreglo(gpt)?.[0]]
    let refNode = null
    if (origen?.class_type === 'ImageBatch') {
      const segunda = Object.values(origen.inputs || {}).map(v => v?.[0])[1]
      if (wf[segunda]?.class_type === 'LoadImage') refNode = String(segunda)
    }
    paginas.push({ nombre, gid: String(gid), save: String(save[0]), ref: refNode, prompt: String(gpt.inputs?.prompt || '') })
  }
  paginas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'en', { numeric: true }))

  // Puerta 2: las páginas con hueco tienen que declarar de dónde sale su referencia, o el motor
  // no puede resolverla y la página sale solo con plantilla.
  const RX = /IMAGE 2 = [^\n]*coming from ([^.]+)\./
  const sinFuente = paginas.filter(p => p.ref && !RX.exec(p.prompt))

  console.log(`workflow: ${NOMBRE}`)
  console.log(`  nodos: ${Object.keys(wf).length} · páginas: ${paginas.length} · con hueco de referencia: ${paginas.filter(p => p.ref).length}\n`)
  for (const p of paginas) {
    const f = RX.exec(p.prompt)?.[1]?.trim()
    console.log(`  ${p.nombre.padEnd(26)} prompt=${p.gid.padStart(3)} save=${p.save.padStart(3)}`
      + (p.ref ? `  ref=${p.ref.padStart(3)} ← ${f || '¡no dice de dónde!'}` : ''))
  }
  if (sinFuente.length) {
    console.error(`\n*** ${sinFuente.length} página(s) con hueco pero sin declarar su fuente ***`)
    process.exit(1)
  }

  const inject_config = {
    mode: 'per_page',
    note: 'Un prompt por página. NO usar inject.prompt: este workflow no tiene un prompt único. '
      + 'Solo 8 páginas admiten referencia del proyecto (§1.1); en las otras 17 el único LoadImage '
      + 'es la maqueta del estudio y no se inyecta.',
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
    description: 'Art Style Guide — maestro de 25 páginas (restructura 36→25 de Miguel, 04-09-2026). '
      + '8 páginas admiten referencia del proyecto vía ImageBatch.',
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
