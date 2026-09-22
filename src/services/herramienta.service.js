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

const { submitWorkflow, pollUntilDone, downloadOutputsByNode, uploadImageToComfyUI, uploadBufferToComfyUI } = require('./providers/comfyui.provider')
const { PNG } = require('pngjs')
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

/**
 * La lámina con su canal alfa marcado donde el usuario pintó, compuesta ACÁ y no en el navegador.
 *
 * Por qué se movió al servidor. El front la componía en un `canvas`: copiaba la lámina y ponía
 * alfa 0 sobre lo pintado, que es lo que `LoadImage` publica como MASK. El problema es que un
 * canvas guarda el color PREMULTIPLICADO por su alfa — con alfa 0 el RGB se pierde al codificar —,
 * así que lo que llegaba a ComfyUI tenía un agujero negro justo en la parte que se quería aislar.
 * El workflow hacía su trabajo sin fallar: recortaba contra la máscara, rellenaba de blanco
 * alrededor, y le entregaba a GPT una silueta negra. Y GPT devolvía una silueta negra pulida,
 * que es exactamente lo que Miguel reportó (informe v5, puntos 3 y 4).
 *
 * `pngjs` escribe el PNG sin premultiplicar, así que el RGB sobrevive debajo del alfa. Se compone
 * una vez, acá, y deja de depender de cómo cada navegador maneje su canvas.
 */
async function componerMascara(urlOrigen, mascaraBase64) {
  const r = await fetch(urlOrigen)
  if (!r.ok) throw new Error(`no se pudo traer la lámina: HTTP ${r.status}`)
  const bufOrigen = Buffer.from(await r.arrayBuffer())

  let lamina, mascara
  try { lamina = PNG.sync.read(bufOrigen) } catch {
    throw new Error('la pieza de origen no es un PNG: la máscara solo se puede componer sobre PNG')
  }
  try { mascara = PNG.sync.read(Buffer.from(mascaraBase64, 'base64')) } catch {
    throw new Error('la máscara enviada no es un PNG válido')
  }
  if (mascara.width !== lamina.width || mascara.height !== lamina.height) {
    throw new Error(
      `la máscara mide ${mascara.width}×${mascara.height} y la lámina ${lamina.width}×${lamina.height}`)
  }

  // Pintado → alfa 0, que `LoadImage` publica como MASK = 1 y el workflow lee como «esto se
  // conserva». Sin pintar → opaco. El RGB no se toca: es justo lo que se perdía antes.
  let pintados = 0
  for (let i = 0; i < lamina.data.length; i += 4) {
    const dentro = mascara.data[i + 3] > 10
    lamina.data[i + 3] = dentro ? 0 : 255
    if (dentro) pintados++
  }
  if (!pintados) throw new Error('la máscara llegó vacía: no hay nada marcado para aislar')

  return { buffer: PNG.sync.write(lamina), pintados, total: lamina.data.length / 4 }
}

function herramientasDe(origen) {
  return Object.entries(HERRAMIENTAS)
    .filter(([, h]) => h.aplica(origen))
    .map(([clave, h]) => ({ clave, workflow: h.workflow, etiqueta: h.etiqueta, pide_mascara: h.pide_mascara }))
}

/**
 * Corre una herramienta sobre un activo y publica el resultado colgado de él.
 *
 * `mascara_base64` son SOLO los trazos: el front manda lo que se pintó y la lámina se compone
 * acá (ver `componerMascara`). El workflow no tiene un segundo puerto de entrada para la máscara,
 * así que viaja en el canal alfa de la propia imagen — pero quien escribe ese alfa es el servidor.
 */
// ─── Qué paso falló ──────────────────────────────────────────────────────────
//
// Informe v8, punto 9 (y v7·3, v6·2, v4·14 antes): «Internal server error» otra vez al correr New
// Angle. La ruta ya reenvía lo que el proveedor explica, pero solo el propio despacho a ComfyUI se
// marcaba como explicable. Todo lo demás —subir la lámina, bajar las salidas, guardarlas en R2—
// caía al manejador genérico, y desde el navegador los cuatro fallos se leen igual.
//
// Correr una herramienta son cinco pasos y cada uno falla por su cuenta. Envolviéndolos, el
// mensaje nombra el paso: «New angle · uploading the source image to ComfyUI: fetch failed» dice a
// dónde mirar; «Internal server error» obliga a ir al log del servidor, que es lo que pasó tres
// informes seguidos.
//
// No se inventa diagnóstico: se conserva el mensaje original y se le antepone el paso.
// La implementación vive en ../utils/paso.js: la comparte con chain.service, que la necesitaba
// para el punto 4 del informe v11. Dos copias del mismo envoltorio serían dos verdades.
const paso = require('../utils/paso').crearPaso('herramienta')

/**
 * El sello de cadena que le corresponde a una pieza sacada de `origen`.
 *
 * Dos casos, y el segundo es el que faltaba:
 *
 *   · El origen es una pieza DE la cadena —ya lleva su sello—: se hereda tal cual. Una vista nueva
 *     de un concept art sigue siendo concept art del mismo paso.
 *   · El origen es una PÁGINA DEL ASG, que no lleva sello porque no la produjo la cadena: entonces
 *     la pieza es lo que produce el PRIMER paso de la cadena de esa hoja. Segmentar una Environment
 *     Sheet devuelve un asset aislado sobre blanco, que es exactamente lo que entrega su
 *     `concept_art`.
 *
 * Sin el segundo caso la pieza quedaba huérfana: la cadena la reconocía por el nombre pero no sabía
 * en qué paso estaba, así que la ventana de Run solo ofrecía rehacer el paso 1. Es el tiburón
 * segmentado del punto 5 del informe v12 de Miguel.
 *
 * El `rol` se toma del que la herramienta acaba de producir. No se inventa nada más: si el nombre
 * no resuelve a ninguna cadena, la pieza se queda sin sello, como antes.
 */
function selloDeCadena(origen, rol) {
  if (origen?.metadata?.cadena) return { cadena: origen.metadata.cadena }
  const { CADENAS, cadenaDe } = require('./chain.service')
  const nombre = cadenaDe(origen)
  const primero = nombre && CADENAS[nombre]?.pasos?.[0]
  if (!primero) return {}
  return { cadena: { nombre, paso: primero.clave, ...(rol ? { rol } : {}) } }
}
async function correrHerramienta({ db, project_id, asset_id, clave, opciones = null, imagen_comfy = null, mascara_base64 = null, member_id = null }) {
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
  if (h.pide_mascara && !mascara_base64 && !imagen_comfy) {
    const err = new Error('This tool needs a painted mask: nothing was sent')
    err.code = 'SIN_MASCARA'
    throw err
  }

  const entry = await getWorkflowByName(h.workflow)
  if (!entry) throw new Error(`Workflow "${h.workflow}" is not registered`)
  const cfg   = entry.inject_config || {}
  const roles = cfg.salidas || null
  const campo = Object.keys(cfg.extra || {})[0] || 'image'

  // La imagen entra por el puerto que declaró el registro. Con trazos se compone acá y se sube el
  // resultado; `imagen_comfy` queda como camino viejo
  // —una imagen ya subida por el llamador— para no romper a quien todavía lo use.
  const etq = h.etiqueta
  let extras
  if (mascara_base64) {
    const m = await paso(`${etq} · composing the mask over the source image`,
      () => componerMascara(origen.storage_url, mascara_base64))
    console.log(`[herramienta] máscara compuesta en el servidor: ${m.pintados}/${m.total} píxeles marcados`)
    extras = { [campo]: await paso(`${etq} · uploading the mask to ComfyUI`, () => uploadBufferToComfyUI(m.buffer)) }
  } else {
    extras = {
      [campo]: imagen_comfy || await paso(`${etq} · uploading the source image to ComfyUI`,
        () => uploadImageToComfyUI(origen.storage_url)),
    }
  }

  const t0 = Date.now()
  const jobId = await paso(`${etq} · dispatching the workflow`,
    () => submitWorkflow(h.workflow, '', 1024, 1024, extras, opciones))
  await paso(`${etq} · waiting for ComfyUI`, () => pollUntilDone(jobId, 300_000))
  const base = `projects/${project_id}/tool/${clave}/${jobId.slice(0, 8)}`
  const salidas = await paso(`${etq} · downloading the results and storing them`,
    () => downloadOutputsByNode(jobId, base))

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

  // De qué versión del origen sale esta pieza. ESTA LÍNEA FALTABA, y es la causa del punto 9 del
  // informe v8 —el «Internal server error» que Miguel reportó por cuarta vez—.
  //
  // `versionDelOrigen` se usaba abajo, en la metadata del activo, y no estaba declarada en ninguna
  // parte: quedó suelta al aplicar el §2.1 de la v2.3. En JavaScript eso no lo ve nadie hasta que
  // la línea se ejecuta, y esa línea es la ÚLTIMA del recorrido: para entonces ComfyUI ya generó
  // la imagen, ya se bajó, ya se guardó en R2 y ya se anotó el gasto. El `ReferenceError` caía al
  // manejador genérico y llegaba como «Internal server error».
  //
  // Medido en la base el 17-09: cinco corridas de New Angle ese día, las cinco anotadas con
  // `salidas: 1` —el registro se escribe DESPUÉS de guardar la imagen—, y cero activos publicados.
  // Se pagaron cinco imágenes que existen en R2 y que nadie llegó a ver.
  //
  // Un fallo leyendo la versión no puede tirar una imagen ya pagada: si no se sabe, va sin marca.
  let versionDelOrigen = null
  try {
    const { versionVigente } = require('./actualizacion.service')
    versionDelOrigen = await versionVigente(db, origen.id)
  } catch (e) {
    console.warn('[herramienta] no se pudo leer la versión del origen:', e.message)
  }

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
        // ── El sello de cadena se HEREDA ────────────────────────────────────
        //
        // Una pieza sacada de un concept art sigue siendo concept art: pertenece a la misma
        // cadena y está en el mismo paso. Sin este sello la cadena no la reconoce, y la ventana
        // de Run —que pregunta `proximoPaso(asset)`— la trata como si estuviera fuera: solo
        // puede ofrecer rehacer el paso 1, o saltar al último paso ya producido.
        //
        // Eso es el punto 6 del informe v11 de Miguel: «al lanzar un nuevo output de concept art
        // no deja avanzar al workflow de generación 3D». Medido en test_smack_migue_v.09: de 20
        // piezas derivadas de una pieza sellada, 6 habían perdido el sello — y las 6 eran New
        // angle. El dato estaba a mano: `origen.metadata` ya se lee más arriba.
        //
        // Se copia TAL CUAL, `rol` incluido: cambiarlo haría que el paso siguiente —que despacha
        // uno por cada rol distinto— creyera que hay un rol más y despachara un trabajo de más,
        // que es pago y no se repite.
        ...selloDeCadena(origen, rol),
        herramienta: { clave, etiqueta: h.etiqueta, rol },
        job: jobId,
        // De qué versión del origen salió (v2.3 §2.1): una pieza segmentada de la v1 no es la
        // misma que una de la v4, y la marca tiene que poder decirlo.
        ...(versionDelOrigen !== null ? { derivado_de_version: versionDelOrigen } : {}),
        ...(opciones && Object.keys(opciones).length ? { opciones } : {}),
      },
    }).select('id, name, storage_url, format, metadata').single()
    // La imagen YA está generada y pagada: si el registro falla, lo que hay que decir es eso, no
    // «Internal server error». Se nombra el paso y se conserva la dirección de lo producido.
    if (error) await paso(`${etq} · publishing "${rol}" (the image is already at ${sal.url})`, () => { throw error })
    creados.push(a)
  }

  return { herramienta: clave, creados }
}

module.exports = { HERRAMIENTAS, herramientasDe, correrHerramienta }
