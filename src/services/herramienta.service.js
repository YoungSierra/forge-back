// ─── Herramientas de una imagen ──────────────────────────────────────────────
//
// Segmentación y Nuevo Ángulo, del documento de integración del Moodboard (§3 y §4).
//
// No son pasos de cadena. Una cadena AVANZA una pieza por etapas fijas —hoja → concept art → 3D—
// y Run da un paso; una herramienta se aplica sobre la pieza que el usuario tiene delante, las
// veces que quiera y en el orden que quiera. Tampoco son Design Edits: eso edita la página EN SU
// SITIO. Estas dos **publican una pieza nueva conectada a la derecha** (§7 del documento), igual
// que Run, y no tocan el origen.
//
// Lo que sí comparten con la cadena es el despacho: subir la imagen a ComfyUI, correr el
// workflow, bajar las salidas declaradas, publicar el activo colgado de su origen. Eso se hace
// aquí una vez, en vez de repetirlo.

const { submitWorkflow, pollUntilDone, downloadOutputsByNode, uploadImageToComfyUI } = require('./providers/comfyui.provider')
const { getWorkflowByName } = require('./config.service')
const { logExecution } = require('./execution-log.service')

// Qué herramienta puede correr sobre qué pieza. Es la decisión de Miguel (§5 del documento):
// habilitar POR PROCEDENCIA, no detectando el fondo de la imagen. Las cadenas de concept art y la
// propia segmentación siempre entregan el asset aislado sobre blanco, así que de dónde vino la
// pieza es la señal fiable; mirar los píxeles no lo es.
const HERRAMIENTAS = {
  segmentation: {
    workflow: 'V57_STUDIO_2D_segmentation',
    etiqueta: 'Segmented',
    pide_mascara: true,
    // Cualquier pieza 2D con un asset o personaje que aislar: páginas Sheet del ASG y outputs 2D.
    aplica: () => true,
  },
  multiangle: {
    workflow: 'V57_STUDIO_2D_multiangle',
    etiqueta: 'New angle',
    pide_mascara: false,
    // Solo sobre lo que ya salió aislado sobre blanco. Una página compleja del ASG —Environment
    // Sheet, Character Sheet— da error de generación, y por eso ni se ofrece.
    aplica: origen => {
      const m = origen?.metadata || {}
      if (m.herramienta?.clave === 'segmentation') return true
      if (m.herramienta?.clave === 'multiangle') return true          // una vista de otra vista
      return m.cadena?.paso === 'concept_art'
    },
  },
}

function herramientasDe(origen) {
  return Object.entries(HERRAMIENTAS)
    .filter(([, h]) => h.aplica(origen))
    .map(([clave, h]) => ({ clave, workflow: h.workflow, etiqueta: h.etiqueta, pide_mascara: h.pide_mascara }))
}

/**
 * Corre una herramienta sobre un activo y publica el resultado colgado de él.
 *
 * `imagen_comfy` es el nombre de un archivo YA subido a ComfyUI: así viaja la máscara. El front la
 * compone sobre la propia lámina —alfa marcado donde se pintó, que es exactamente lo que
 * `LoadImage` publica en su salida MASK— y la sube por el mismo endpoint que ya usa el refinador.
 * Sin eso habría que inventar un segundo puerto de entrada que el workflow no tiene, o mandar la
 * imagen entera en el cuerpo de esta petición.
 */
async function correrHerramienta({ db, project_id, asset_id, clave, opciones = null, imagen_comfy = null, member_id = null }) {
  const h = HERRAMIENTAS[clave]
  if (!h) throw new Error(`Unknown tool "${clave}"`)

  const { data: origen, error: e0 } = await db().from('forge_assets')
    .select('id, project_id, node_id, name, storage_url, metadata')
    .eq('id', asset_id).single()
  if (e0 || !origen) throw new Error('Asset not found')
  if (!origen.storage_url) throw new Error('This piece has no image to work from')
  if (!h.aplica(origen)) {
    const err = new Error(`"${h.etiqueta}" does not apply to this piece`)
    err.code = 'NO_APLICA'
    throw err
  }
  if (h.pide_mascara && !imagen_comfy) {
    const err = new Error('This tool needs a painted mask: nothing was sent')
    err.code = 'SIN_MASCARA'
    throw err
  }

  const entry = await getWorkflowByName(h.workflow)
  if (!entry) throw new Error(`Workflow "${h.workflow}" is not registered`)
  const cfg   = entry.inject_config || {}
  const roles = cfg.salidas || null
  const campo = Object.keys(cfg.extra || {})[0] || 'image'

  // La imagen entra por el puerto que declaró el registro. Con máscara ya viene subida —el front
  // la compuso—; sin ella se sube la del propio activo.
  const extras = { [campo]: imagen_comfy || await uploadImageToComfyUI(origen.storage_url) }

  const t0 = Date.now()
  const jobId = await submitWorkflow(h.workflow, '', 1024, 1024, extras, opciones)
  await pollUntilDone(jobId, 300_000)
  const base = `projects/${project_id}/tool/${clave}/${jobId.slice(0, 8)}`
  const salidas = await downloadOutputsByNode(jobId, base)

  // Igual que en la cadena: con mapa declarado manda el mapa. Un workflow publica intermedios
  // —previsualizaciones, comparadores— que no son piezas del moodboard.
  const porRol = {}
  for (const [nodo, sal] of Object.entries(salidas)) {
    if (roles && !roles[nodo]) continue
    porRol[roles?.[nodo] || nodo] = sal
  }
  if (!Object.keys(porRol).length) {
    throw new Error(`"${h.etiqueta}" produced output, but none from the declared nodes (${Object.keys(roles || {}).join(', ')})`)
  }

  logExecution({
    project_id, node_id: origen.node_id, triggered_by: member_id,
    trigger_type: 'tool', executor_type: 'comfyui', provider: 'comfyui', model: h.workflow,
    is_estimated: true, duration_ms: Date.now() - t0, started_at: new Date(t0).toISOString(),
    metadata: { herramienta: clave, origen: origen.id, salidas: Object.keys(porRol).length },
  })

  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id: origen.node_id, output_key: null, status: 'auto_approved',
    iteration_count: 1, started_at: new Date(t0).toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id,
  }).select('id').single()

  const creados = []
  const varias = Object.keys(porRol).length > 1
  for (const [rol, sal] of Object.entries(porRol)) {
    const { data: a, error } = await db().from('forge_assets').insert({
      project_id, node_id: origen.node_id, session_id: ses.id,
      name: `${origen.name} — ${h.etiqueta}${varias ? ` — ${rol}` : ''}`,
      format: sal.kind === 'model' ? 'glb' : 'png',
      mime_type: sal.kind === 'model' ? 'model/gltf-binary' : 'image/png',
      status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
      storage_url: sal.url, file_size_bytes: sal.size_bytes,
      // De acá cuelga el cable: la pieza nueva se dibuja a la derecha de la que la originó.
      derived_from_id: origen.id,
      // Las opciones quedan pegadas a la pieza: es lo que se lee debajo de la imagen y lo que se
      // reusa al rehacerla. En Nuevo Ángulo son el ángulo y el zoom con que se generó.
      metadata: {
        herramienta: { clave, etiqueta: h.etiqueta, rol },
        job: jobId,
        ...(opciones && Object.keys(opciones).length ? { opciones } : {}),
      },
    }).select('id, name, storage_url, format, metadata').single()
    if (error) throw error
    creados.push(a)
  }

  return { herramienta: clave, creados }
}

module.exports = { HERRAMIENTAS, herramientasDe, correrHerramienta }
