// Registra V57_STUDIO_2D_ui_preproduction, el workflow que piden los cinco outputs de imagen que
// trajo v2.9.22 (3.1/pillar_schematics, 3.3/item_catalog_sheet, 3.4/world_visuals,
// 3.7/hud_schematic, 3.7/ui_screen_mockups).
//
// Se le hacen DOS correcciones al .json tal como llegó:
//
//  1. La `LoadImage` viene CONECTADA al nodo del modelo y con una imagen de ejemplo cargada. Así
//     registrado, cualquier corrida sin arte del proyecto se condicionaría con una imagen ajena —
//     es decirle al modelo «así se ve este juego» con material de otro. Ya nos costó una corrida
//     del ASG. Se desconecta: `ref_proyecto` la enchufa SOLO cuando hay arte, que es el mismo
//     patrón probado del 2.5 (allí el hueco vive desconectado a propósito).
//
//  2. `size: "1536x1024"` con `custom_width/height: 1920x1088`. ComfyUI dice en el propio campo
//     que los custom SOLO se usan con `size: "Custom"`, así que como llegó produce 3:2 y no el
//     16:9 que declara el changelog. Se pone `Custom` para respetar su medida.
//
// Uso:  node scripts/registrar-workflow-2d-preprod.js            (simula)
//       node scripts/registrar-workflow-2d-preprod.js --apply
require('dotenv').config()
const fs = require('fs')
const { db } = require('../src/services/supabase.service')

const RUTA    = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2]
  : 'C:/Users/Admin/Documents/V57 Studio/Forge/P-31082026/V57_STUDIO_2D_ui_preproduction_2_7.json'
const APLICAR = process.argv.includes('--apply')
const NOMBRE  = 'V57_STUDIO_2D_ui_preproduction'

;(async () => {
  const grafo = JSON.parse(fs.readFileSync(RUTA, 'utf8'))

  const modelo = Object.entries(grafo).find(([, n]) => n.class_type === 'OpenAIGPTImage1')
  const load   = Object.entries(grafo).find(([, n]) => n.class_type === 'LoadImage')
  const save   = Object.entries(grafo).find(([, n]) => n.class_type === 'SaveImage')
  if (!modelo || !load || !save) { console.error('el .json no tiene los tres nodos esperados'); process.exit(1) }

  const [idModelo, nModelo] = modelo
  const [idLoad]            = load
  const [idSave]            = save
  console.log(`nodos: modelo ${idModelo} · LoadImage ${idLoad} · SaveImage ${idSave}\n`)

  // ── corrección 1 · soltar la referencia ──
  const antesImg = JSON.stringify(nModelo.inputs.image)
  if (Array.isArray(nModelo.inputs.image) && nModelo.inputs.image[0] === idLoad) {
    delete nModelo.inputs.image
    console.log(`1 · referencia desconectada: ${idModelo}.image era ${antesImg} → se enchufa solo cuando hay arte`)
  } else {
    console.log(`1 · ${idModelo}.image = ${antesImg} — no apunta al LoadImage, se deja como está`)
  }
  // La imagen de ejemplo que trae el LoadImage se deja: sin conexión no se usa, y borrarla haría
  // que el nodo quedara inválido si alguien abre el grafo en ComfyUI.

  // ── corrección 2 · el 16:9 que declara ──
  const size = nModelo.inputs.size
  const cw = nModelo.inputs.custom_width, ch = nModelo.inputs.custom_height
  if (cw && ch && size !== 'Custom') {
    nModelo.inputs.size = 'Custom'
    console.log(`2 · size "${size}" → "Custom" para que valgan sus ${cw}x${ch} (con "${size}" ComfyUI ignora los custom)`)
  } else {
    console.log(`2 · size "${size}" · custom ${cw}x${ch} — nada que corregir`)
  }

  // El prompt viaja al campo del modelo; la semilla también. `ref_proyecto` conecta el LoadImage
  // al modelo únicamente cuando el llamador manda arte del proyecto.
  const inject_config = {
    seed:         { node: idModelo, field: 'seed' },
    prompt:       { node: idModelo, field: 'prompt' },
    ref_proyecto: { load_node: idLoad, model_node: idModelo, field: 'image' },
    salidas:      { [idSave]: 'image' },
  }
  console.log(`\ninject_config: ${JSON.stringify(inject_config)}`)

  const { data: previo } = await db().from('comfyui_workflows').select('id,name').eq('name', NOMBRE).maybeSingle()
  console.log(`\n${previo ? 'YA EXISTE → se actualiza' : 'no existe → se crea'}`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const fila = {
    name: NOMBRE,
    description: 'Pre-producción 2D (v2.9.22 F-E): una imagen 16:9 por ítem, condicionada por texto y, cuando lo hay, por el arte del proyecto.',
    workflow_json: grafo,
    inject_config,
    is_active: true,
    updated_at: new Date().toISOString(),
  }
  const { error } = previo
    ? await db().from('comfyui_workflows').update(fila).eq('id', previo.id)
    : await db().from('comfyui_workflows').insert(fila)
  if (error) { console.error('✗', error.message); process.exit(1) }

  // Releer: registrarlo y que no quede es exactamente el fallo que deja cinco outputs mudos.
  const { data: rel } = await db().from('comfyui_workflows').select('workflow_json,inject_config,is_active').eq('name', NOMBRE).single()
  const g = typeof rel.workflow_json === 'string' ? JSON.parse(rel.workflow_json) : rel.workflow_json
  console.log('\n=== verificación ===')
  console.log(`  activo: ${rel.is_active}`)
  console.log(`  ${idModelo}.image conectado: ${g[idModelo]?.inputs?.image !== undefined ? '✗ SÍ' : '✓ no (se enchufa con ref_proyecto)'}`)
  console.log(`  ${idModelo}.size: ${g[idModelo]?.inputs?.size}`)
  // Comparar por VALOR y no por cadena: `jsonb` reordena las claves al guardar, y comparar el
  // texto daba «distinto» sobre un registro que estaba perfecto.
  const ordenar = o => Array.isArray(o) ? o.map(ordenar)
    : (o && typeof o === 'object') ? Object.fromEntries(Object.keys(o).sort().map(k => [k, ordenar(o[k])]))
    : o
  const igual = JSON.stringify(ordenar(rel.inject_config)) === JSON.stringify(ordenar(inject_config))
  console.log(`  inject_config guardado: ${igual ? '✓ idéntico' : '✗ distinto'}`)
})()
