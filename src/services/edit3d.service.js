// ─── Edit 3D: las herramientas de Tripo sobre un modelo ya generado ─────────
//
// Pedido de Miguel León (W43 #7, respuesta del 20-10): que Forge tenga las herramientas de la web
// de Tripo, en su orden —Segment → Retopo → Smart UV → Texture → Rig— y cada una con sus opciones.
// El resultado se publica a la derecha del modelo como pieza nueva colgada de él, igual que las
// herramientas 2D (`herramienta.service`); el modelo de origen no se toca.
//
// **Por qué el grafo se arma aquí y no se registra.** Las herramientas de Tripo no reciben un
// archivo: reciben el «task id» del modelo, y ese id solo existe DENTRO de la corrida que lo
// generó. Forge corre cada edición como un trabajo aparte, así que cada grafo empieza importando
// el .glb de origen (`Tripo: Import Model`) y aplica la herramienta sobre el id nuevo. Medido el
// 20-10: el .glb de la prueba P2 importado y pasado por Retopology volvió con sus tres texturas PBR
// y de 4.784 a 3.724 triángulos, en 109 s. Con el grafo en código, una opción que cambia la forma
// del grafo —la malla en quads sale por otra salida, la textura guiada por texto quita la imagen de
// referencia— se resuelve al armarlo, sin registrar una variante por combinación.
//
// Las opciones NO se escriben a mano en ninguna parte: se descubren del grafo armado contra
// `object_info` de ComfyUI (`workflow-options.service`), igual que las de generación. Cada
// herramienta declara solo QUÉ campos de su nodo se ofrecen.

const crypto = require('crypto')
const { pollUntilDone, downloadOutputsByNode, uploadImageToComfyUI } = require('./providers/comfyui.provider')
const { opcionesDe, aplicarOpciones } = require('./workflow-options.service')
const { logExecution, registrarDespacho } = require('./execution-log.service')
const paso = require('../utils/paso').crearPaso('edit3d')

const BASE = () => (process.env.COMFYUI_BASE_URL || 'https://cloud.comfy.org').replace(/\/$/, '')
const KEY  = () => process.env.COMFYUI_API_KEY

// Nodos fijos de todos los grafos. El 3 es la herramienta; lo demás es carga, importación y guardado.
const CARGA = '1', IMPORTA = '2', HERR = '3', CONVIERTE = '4', REFERENCIA = '5', GUARDA = '9', GUARDA_FBX = '10'

// Los campos de `Tripo: Convert model` con su valor por defecto en ComfyUI.
const CONVERSION = {
  quad: false, face_limit: -1, texture_size: 4096, texture_format: 'JPEG', force_symmetry: false,
  flatten_bottom: false, flatten_bottom_threshold: 0.01, pivot_to_center_bottom: false, scale_factor: 1,
  with_animation: true, pack_uv: false, bake: true, part_names: '', fbx_preset: 'blender',
  export_vertex_colors: false, export_orientation: 'default', animate_in_place: false,
}

// En el orden de la web de Tripo (captura de Miguel). `expone` son las hojas de los campos que se
// ofrecen; `salida` es el índice de la salida GLB del nodo.
const HERRAMIENTAS_3D = [
  {
    clave: 'segment', etiqueta: 'Segment', nodo: 'TripoSmartSegmentNode', salida: 2,
    ayuda: 'Split the model into named parts. Retopo and Texture can then work on some parts only.',
    // `source` es un combo dinámico: «model» segmenta un modelo existente, que es el caso de Forge.
    inputs: () => ({ source: 'model', 'source.model_task_id': [IMPORTA, 0], 'source.granularity': 'medium', 'source.hint': '' }),
    expone: ['granularity', 'hint'],
  },
  {
    clave: 'retopo', etiqueta: 'Retopo', nodo: 'TripoRetopologyNode', salida: 2,
    ayuda: 'Rebuild the mesh with a clean, lighter topology. Source textures are baked onto it.',
    inputs: () => ({ model_task_id: [IMPORTA, 0], face_limit: -1, quad: false, bake: true, part_names: '' }),
    expone: ['face_limit', 'quad', 'bake', 'part_names'],
  },
  {
    clave: 'smart_uv', etiqueta: 'Smart UV', nodo: 'TripoConversionNode', salida: 0,
    ayuda: 'Repack the UV layout and re-bake the textures into it.',
    // No hay nodo «Smart UV» en ComfyUI: es la conversión de Tripo con `pack_uv`. El formato se
    // queda en GLTF porque es lo que el visor del moodboard dibuja.
    // El nodo exige TODOS sus campos aunque los declare opcionales (falló así el 20-10), así que van
    // con los valores por defecto que declara ComfyUI.
    inputs: () => ({ original_model_task_id: [IMPORTA, 0], format: 'GLTF', ...CONVERSION, pack_uv: true }),
    expone: ['texture_size', 'texture_format', 'bake'],
  },
  {
    clave: 'texture', etiqueta: 'Texture', nodo: 'TripoTextureNodeV2', salida: 1,
    ayuda: 'Re-texture the model from a text prompt. The concept art it came from goes along as the style image.',
    // Sobre un modelo importado Tripo NO acepta imagen de referencia —«only for models it generated
    // itself», medido el 20-10—: la guía es el prompt, y el concept art viaja como imagen de estilo,
    // que sí se admite junto al prompt.
    inputs: () => ({
      model_task_id: [IMPORTA, 0], pbr: true, texture_quality: 'standard', texture_alignment: 'original_image',
      texture_prompt: '', model_version: 'v3.0-20250812', part_names: '', texture_seed: 42,
      reference: 'none', style_image: [REFERENCIA, 0],
    }),
    expone: ['pbr', 'texture_quality', 'texture_alignment', 'texture_prompt', 'model_version', 'part_names'],
  },
  {
    clave: 'rig', etiqueta: 'Rig', nodo: 'TripoRigNode', salida: 2,
    ayuda: 'Add a skeleton. Auto checks the model first and picks the skeleton type.',
    inputs: () => ({ original_model_task_id: [IMPORTA, 0], model_version: 'v1.0-20240301', rig_type: 'auto', spec: 'tripo', out_format: 'glb' }),
    expone: ['model_version', 'rig_type', 'spec'],
  },
]
const porClave = Object.fromEntries(HERRAMIENTAS_3D.map(h => [h.clave, h]))

const esModelo = a => a?.format === 'glb' || /\.glb(\?|$)/i.test(String(a?.storage_url || ''))

/** El grafo base de una herramienta, con los valores por defecto. `modelo` es el nombre del .glb ya subido. */
function grafoDe(h, modelo = 'model.glb') {
  return {
    [CARGA]:   { class_type: 'Load3DAdvanced', inputs: { model_file: modelo, viewport_state: {}, width: 512, height: 512 } },
    [IMPORTA]: { class_type: 'TripoImportModelNode', inputs: { model_3d: [CARGA, 0] } },
    [HERR]:    { class_type: h.nodo, inputs: h.inputs() },
    [GUARDA]:  { class_type: 'SaveGLB', inputs: { mesh: [HERR, h.salida], filename_prefix: `3d/forge_${h.clave}` } },
    ...(h.clave === 'texture' ? { [REFERENCIA]: { class_type: 'LoadImage', inputs: { image: 'reference.png' } } } : {}),
  }
}

/** Las herramientas que aplican a esta pieza, con sus opciones. Solo sobre modelos. */
async function herramientas3DDe(asset) {
  if (!esModelo(asset)) return []
  return Promise.all(HERRAMIENTAS_3D.map(async h => ({
    clave: h.clave, etiqueta: h.etiqueta, ayuda: h.ayuda,
    opciones: await opcionesDe(grafoDe(h), { expone: h.expone }).catch(() => []),
  })))
}

/** Sube el .glb de origen a ComfyUI. El endpoint es el de imágenes, pero acepta el archivo tal cual. */
async function subirModelo(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`could not fetch the source model: HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const form = new FormData()
  form.append('image', new Blob([buf], { type: 'model/gltf-binary' }), `forge_${crypto.randomBytes(6).toString('hex')}.glb`)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const up = await fetch(`${BASE()}/api/upload/image`, { method: 'POST', headers: { 'X-API-Key': KEY() }, body: form, signal: AbortSignal.timeout(120_000) })
  if (!up.ok) throw new Error(`ComfyUI upload failed: ${up.status} ${await up.text()}`)
  const j = await up.json()
  return (j.subfolder ? `${j.subfolder}/` : '') + (j.name || j.filename)
}

/**
 * La imagen que guía la textura cuando no hay prompt: el concept art del que salió el modelo.
 * Se sube por `derived_from_id` hasta la primera imagen; un modelo editado cuelga de otro modelo.
 */
async function conceptDelModelo(db, asset) {
  let actual = asset
  for (let i = 0; i < 8 && actual?.derived_from_id; i++) {
    const { data } = await db().from('forge_assets')
      .select('id, format, storage_url, derived_from_id, metadata').eq('id', actual.derived_from_id).maybeSingle()
    if (!data) return null
    if (!esModelo(data) && data.storage_url && /^(png|jpg|jpeg|webp)$/i.test(data.format || 'png')) return data.storage_url
    actual = data
  }
  return null
}

/** Los nombres de las partes de un .glb segmentado: los nodos con malla, que Tripo nombra por parte. */
async function partesDelGlb(url) {
  const r = await fetch(url)
  if (!r.ok) return []
  const b = Buffer.from(await r.arrayBuffer())
  if (b.readUInt32LE(0) !== 0x46546c67) return []
  const j = JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString('utf8'))
  return [...new Set((j.nodes || []).filter(n => n.mesh != null && n.name).map(n => n.name))]
}

async function despachar(grafo) {
  const res = await fetch(`${BASE()}/api/prompt`, {
    method: 'POST', headers: { 'X-API-Key': KEY(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: grafo, extra_data: { api_key_comfy_org: KEY() } }),
  })
  if (!res.ok) {
    const e = new Error(res.status === 402
      ? 'The ComfyUI account has no credit left. Top it up and run this again — nothing was charged.'
      : `ComfyUI submit failed: ${res.status} ${(await res.text()).slice(0, 400)}`)
    if (res.status === 402) { e.publico = true; e.status = 402; e.code = 'COMFYUI_CREDITS' }
    throw e
  }
  const { prompt_id } = await res.json()
  if (!prompt_id) throw new Error('ComfyUI: no prompt_id in response')
  return prompt_id
}

/**
 * Corre una herramienta 3D sobre un modelo y publica el resultado colgado de él.
 * `opciones` son solo las que el usuario cambió, con las claves que devuelve `herramientas3DDe`.
 */
async function correrEdit3D({ db, project_id, asset_id, clave, opciones = null, member_id = null }) {
  const h = porClave[clave]
  if (!h) { const e = new Error(`Unknown 3D tool "${clave}"`); e.code = 'NO_APLICA'; throw e }

  const { data: origen } = await db().from('forge_assets')
    .select('id, project_id, node_id, name, format, storage_url, derived_from_id, metadata').eq('id', asset_id).single()
  if (!origen || origen.project_id !== project_id) throw new Error('Asset not found')
  if (!esModelo(origen)) { const e = new Error(`"${h.etiqueta}" only runs on a 3D model`); e.code = 'NO_APLICA'; throw e }

  const etq = h.etiqueta
  const elegidas = { ...(opciones || {}) }
  const modelo = await paso(`${etq} · uploading the model to ComfyUI`, () => subirModelo(origen.storage_url))
  const grafo = grafoDe(h, modelo)
  const catalogo = await opcionesDe(grafo, { expone: h.expone })
  const { avisos } = aplicarOpciones(grafo, elegidas, catalogo)
  avisos.forEach(a => console.warn(`[edit3d] opción ignorada: ${a}`))
  const nodo = grafo[HERR].inputs

  if (h.clave === 'texture') {
    if (!String(nodo.texture_prompt || '').trim()) {
      const e = new Error('Texture needs a prompt: describe the look you want (materials, colors, wear).')
      e.code = 'SIN_GUIA'; e.publico = true; e.status = 400
      throw e
    }
    const concept = await conceptDelModelo(db, origen)
    if (concept) grafo[REFERENCIA].inputs.image = await paso(`${etq} · uploading the concept art`, () => uploadImageToComfyUI(concept))
    else { delete nodo.style_image; delete grafo[REFERENCIA] }
    nodo.texture_seed = Math.floor(Math.random() * 2147483647)
  }

  // La malla en quads la entrega Tripo SOLO como FBX, y su salida GLB queda vacía (ComfyUI aborta si
  // sigue conectada). Se guarda el FBX y se convierte a GLTF para que el moodboard lo pueda mirar.
  const quad = h.clave === 'retopo' && nodo.quad === true
  if (quad) {
    grafo[GUARDA_FBX] = { class_type: 'SaveGLB', inputs: { mesh: [HERR, 3], filename_prefix: '3d/forge_retopo_quad' } }
    grafo[CONVIERTE]  = { class_type: 'TripoConversionNode', inputs: { original_model_task_id: [HERR, 1], ...CONVERSION, format: 'GLTF' } }
    grafo[GUARDA].inputs.mesh = [CONVIERTE, 0]
  }

  const t0 = Date.now()
  const jobId = await paso(`${etq} · dispatching to Tripo`, () => despachar(grafo))
  registrarDespacho({ project_id, node_id: origen.node_id, member_id, jobId, workflow: `edit3d:${h.clave}`, herramienta: `edit3d:${h.clave}`, origen: origen.id, origen_nombre: origen.name })
  await paso(`${etq} · waiting for Tripo (job ${jobId.slice(0, 8)})`, () => pollUntilDone(jobId, 600_000))
  const salidas = await paso(`${etq} · downloading the result`,
    () => downloadOutputsByNode(jobId, `projects/${project_id}/edit3d/${h.clave}/${jobId.slice(0, 8)}`))
  const glb = salidas[GUARDA]
  if (!glb) throw new Error(`"${etq}" finished without a model (outputs: ${Object.keys(salidas).join(', ') || 'none'})`)
  const fbx = quad ? salidas[GUARDA_FBX] : null

  logExecution({
    project_id, node_id: origen.node_id, triggered_by: member_id,
    trigger_type: 'tool', executor_type: 'comfyui', provider: 'comfyui', model: `edit3d:${h.clave}`,
    is_estimated: true, duration_ms: Date.now() - t0, started_at: new Date(t0).toISOString(),
    metadata: { herramienta: `edit3d:${h.clave}`, origen: origen.id, salidas: fbx ? 2 : 1 },
  })

  const partes = h.clave === 'segment' ? await partesDelGlb(glb.url).catch(() => []) : (origen.metadata?.partes || null)

  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id: origen.node_id, output_key: null, status: 'auto_approved',
    iteration_count: 1, started_at: new Date(t0).toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id,
  }).select('id').single()

  const { data: a, error } = await db().from('forge_assets').insert({
    project_id, node_id: origen.node_id, session_id: ses?.id ?? null,
    name: `${origen.name} — ${etq}`,
    format: 'glb', mime_type: 'model/gltf-binary',
    status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
    storage_url: glb.url, file_size_bytes: glb.size_bytes,
    derived_from_id: origen.id,
    metadata: {
      // El sello de cadena se hereda: un modelo editado sigue siendo el 3D de su cadena, y Run
      // sobre él no debe ofrecer volver a generarlo.
      ...(origen.metadata?.cadena ? { cadena: origen.metadata.cadena } : {}),
      ...(origen.metadata?.pose ? { pose: origen.metadata.pose } : {}),
      herramienta: { clave: `edit3d:${h.clave}`, etiqueta: etq, rol: 'model' },
      job: jobId,
      ...(Object.keys(elegidas).length ? { opciones: elegidas } : {}),
      ...(partes?.length ? { partes } : {}),
      ...(fbx ? { fbx_url: fbx.url } : {}),
    },
  }).select('id, name, storage_url, format, metadata').single()
  if (error) await paso(`${etq} · publishing (the model is already at ${glb.url})`, () => { throw error })

  try { await require('./glb-medidas.service').medirActivo(db, a) }
  catch (e) { console.warn(`[edit3d] no se pudo medir "${a.name}": ${e.message}`) }

  return { herramienta: h.clave, creados: [a] }
}

// ─── Export FBX ─────────────────────────────────────────────────────────────
//
// Miguel León (20-10): cada modelo se baja en GLB —su archivo de siempre— y en FBX, con los tres
// presets de Tripo. El FBX no es una pieza nueva del lienzo: es otro formato del MISMO modelo, así
// que se guarda en su metadata (`fbx.<preset>`) y la segunda descarga del mismo preset no se paga.
// `with_animation` (por defecto en la conversión) conserva el esqueleto de un modelo con Rig.
const PRESETS_FBX = ['blender', 'mixamo', '3dsmax']

async function exportarFBX({ db, project_id, asset_id, preset = 'blender', member_id = null }) {
  if (!PRESETS_FBX.includes(preset)) { const e = new Error(`Unknown FBX preset "${preset}"`); e.code = 'NO_APLICA'; throw e }
  const { data: origen } = await db().from('forge_assets')
    .select('id, project_id, node_id, name, format, storage_url, metadata').eq('id', asset_id).single()
  if (!origen || origen.project_id !== project_id) throw new Error('Asset not found')
  if (!esModelo(origen)) { const e = new Error('Export FBX only runs on a 3D model'); e.code = 'NO_APLICA'; throw e }
  const hecho = origen.metadata?.fbx?.[preset]
  if (hecho) return { preset, url: hecho, reusado: true }

  const etq = `Export FBX (${preset})`
  const modelo = await paso(`${etq} · uploading the model to ComfyUI`, () => subirModelo(origen.storage_url))
  const grafo = {
    [CARGA]:   { class_type: 'Load3DAdvanced', inputs: { model_file: modelo, viewport_state: {}, width: 512, height: 512 } },
    [IMPORTA]: { class_type: 'TripoImportModelNode', inputs: { model_3d: [CARGA, 0] } },
    [CONVIERTE]: { class_type: 'TripoConversionNode', inputs: { original_model_task_id: [IMPORTA, 0], ...CONVERSION, format: 'FBX', fbx_preset: preset } },
    [GUARDA_FBX]: { class_type: 'SaveGLB', inputs: { mesh: [CONVIERTE, 0], filename_prefix: `3d/forge_fbx_${preset}` } },
  }
  const t0 = Date.now()
  const jobId = await paso(`${etq} · dispatching to Tripo`, () => despachar(grafo))
  registrarDespacho({ project_id, node_id: origen.node_id, member_id, jobId, workflow: 'edit3d:fbx', herramienta: 'edit3d:fbx', origen: origen.id, origen_nombre: origen.name })
  await paso(`${etq} · waiting for Tripo (job ${jobId.slice(0, 8)})`, () => pollUntilDone(jobId, 600_000))
  const salidas = await paso(`${etq} · downloading the result`,
    () => downloadOutputsByNode(jobId, `projects/${project_id}/edit3d/fbx/${jobId.slice(0, 8)}`))
  const fbx = salidas[GUARDA_FBX]
  if (!fbx) throw new Error(`"${etq}" finished without a file (outputs: ${Object.keys(salidas).join(', ') || 'none'})`)

  logExecution({
    project_id, node_id: origen.node_id, triggered_by: member_id,
    trigger_type: 'tool', executor_type: 'comfyui', provider: 'comfyui', model: 'edit3d:fbx',
    is_estimated: true, duration_ms: Date.now() - t0, started_at: new Date(t0).toISOString(),
    metadata: { herramienta: 'edit3d:fbx', origen: origen.id, preset },
  })

  // Se relee el metadata justo antes de escribir: otra exportación del mismo modelo pudo terminar mientras tanto.
  const { data: fresco } = await db().from('forge_assets').select('metadata').eq('id', origen.id).single()
  const metadata = { ...(fresco?.metadata || {}), fbx: { ...(fresco?.metadata?.fbx || {}), [preset]: fbx.url } }
  const { error } = await db().from('forge_assets').update({ metadata }).eq('id', origen.id)
  if (error) console.warn(`[edit3d] FBX ${preset} de "${origen.name}" sin guardar en la ficha (${error.message}); el archivo está en ${fbx.url}`)
  return { preset, url: fbx.url, reusado: false }
}

module.exports = { HERRAMIENTAS_3D, herramientas3DDe, correrEdit3D, grafoDe, CONVERSION, PRESETS_FBX, exportarFBX }
