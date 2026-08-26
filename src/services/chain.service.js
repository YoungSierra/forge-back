// ─── Cadenas de producción: avanzar una pieza de etapa, un paso a la vez ─────
//
// Del documento de menús radiales (§8 y §10). Una página no se rehace: AVANZA. La hoja de
// personaje se edita, de esa edición salen las tres vistas, y de las tres vistas sale el modelo 3D.
// Cada paso produce activos NUEVOS conectados al anterior (`derived_from_id`), nunca una versión
// del mismo — versionar en el sitio es otra cosa y ya existe.
//
// Run pide UN paso; Design Edits pide los tres seguidos. Es el mismo motor con distinto `pasos`:
// que fueran dos caminos separados es justamente lo que haría que se comportaran distinto.
//
// El paso 3 no devuelve una imagen sino un `.glb`. Por eso las salidas se leen por NODO y no «la
// primera que aparezca»: el paso 2 publica cuatro imágenes y el 3 pide tres de ellas POR ROL.

const { submitWorkflow, pollUntilDone, downloadOutputsByNode, uploadImageToComfyUI } = require('./providers/comfyui.provider')
const { getWorkflowByName } = require('./config.service')
const { logExecution } = require('./execution-log.service')

// `origen` = el activo sobre el que se apretó Run. `<paso>:<rol>` = una salida del paso anterior.
const CADENAS = {
  character_sheet: {
    etiqueta: 'Character Sheet',
    pasos: [
      {
        clave: 'design_edit', workflow: 'V57_STUDIO_Moodboard_Iteration', etiqueta: 'Design edit',
        que:    'One edited image: this page with the requested change applied.',
        porque: 'Everything downstream is built from this sheet, so the change has to land here first.',
        entradas: { image: 'origen' },
        pide_prompt: true,
      },
      {
        clave: 'concept_art', workflow: 'V57_STUDIO_ConceptArt_Characters', etiqueta: 'Concept art',
        que:    'Four images: the master sheet plus front, left and back views.',
        porque: 'A mesh cannot be built from one picture — the three views are what make the body consistent.',
        entradas: { image: 'design_edit:*' },
      },
      {
        clave: '3d', workflow: 'V57_STUDIO_3D_Production_Characters', etiqueta: '3D production',
        que:    'One textured .glb model.',
        porque: 'This is the asset the vertical slice actually ships.',
        entradas: { image: 'concept_art:front', image_left: 'concept_art:left', image_back: 'concept_art:back' },
      },
    ],
  },
}

// Qué cadena le toca a un activo. Hoy solo la de Character Sheet está definida; el documento dice
// que las demás páginas «usan sus propios workflows, que están por definir más adelante», así que
// devolver null es la respuesta correcta y no un caso de error.
function cadenaDe(asset) {
  const n = String(asset?.name || '')
  if (/character\s*sheet/i.test(n)) return 'character_sheet'
  return null
}

// En qué paso está parado el activo: los que produjo la cadena lo llevan anotado; cualquier otro
// es el punto de partida.
function pasoDe(asset) {
  const c = asset?.metadata?.cadena
  if (!c?.paso) return 0
  const def = CADENAS[c.nombre]
  const i = def ? def.pasos.findIndex(p => p.clave === c.paso) : -1
  return i === -1 ? 0 : i + 1
}

// Lo que el recuadro previo del §8 tiene que poder decir ANTES de gastar: qué se genera y por qué.
function proximoPaso(asset) {
  const nombre = cadenaDe(asset)
  if (!nombre) return null
  const def = CADENAS[nombre]
  const i   = pasoDe(asset)
  if (i >= def.pasos.length) return null
  const p = def.pasos[i]
  return {
    cadena: nombre, etiqueta_cadena: def.etiqueta,
    indice: i + 1, de: def.pasos.length,
    clave: p.clave, etiqueta: p.etiqueta, que: p.que, porque: p.porque,
    pide_prompt: !!p.pide_prompt, workflow: p.workflow,
  }
}

// ─── Corre N pasos desde donde esté el activo ────────────────────────────────
// Devuelve los activos creados, en orden. Si un paso falla se devuelve lo que sí se produjo: lo ya
// generado está pagado y publicado, y borrarlo para «dejar limpio» sería tirar plata.
async function avanzar({ db, project_id, asset_id, pasos = 1, prompt = null, member_id = null }) {
  const { data: origen, error: e0 } = await db().from('forge_assets')
    .select('id, project_id, node_id, session_id, name, storage_url, metadata')
    .eq('id', asset_id).single()
  if (e0 || !origen) throw new Error('Asset not found')
  if (!origen.storage_url) throw new Error('This page has no image to advance from')

  const nombreCadena = cadenaDe(origen)
  if (!nombreCadena) {
    const err = new Error(`"${origen.name}" has no production chain defined yet`)
    err.code = 'SIN_CADENA'
    throw err
  }
  const def = CADENAS[nombreCadena]

  // Las salidas de cada paso, para que el siguiente las pida por rol.
  const salidasPorPaso = {}
  const creados = []
  let anterior = origen

  // Arrancar a MITAD de cadena es el caso normal: Run avanza de a un paso, así que la segunda vez
  // el origen ya es la salida de un paso anterior. Sin sembrar esto, el paso siguiente busca su
  // entrada entre lo que corrió en ESTA llamada —nada— y aborta con «did not run».
  //
  // Se siembran todos los hermanos del mismo job, no solo el origen: el paso 3 pide `front`,
  // `left` y `back`, y el usuario aprieta Run parado sobre una sola de las tres.
  if (origen.metadata?.cadena?.paso) {
    const { paso: pasoOrigen } = origen.metadata.cadena
    const { data: hermanos } = await db().from('forge_assets')
      .select('storage_url, metadata')
      .eq('project_id', project_id)
      .eq('metadata->cadena->>paso', pasoOrigen)
      .not('storage_url', 'is', null)
      .order('created_at', { ascending: false })

    // Del mismo job: dos corridas del mismo paso conviven en el proyecto y mezclarlas armaría un
    // personaje con el frente de una y la espalda de otra.
    const job = origen.metadata?.job
    const delJob = (hermanos || []).filter(h => !job || h.metadata?.job === job)
    const sembrado = {}
    for (const h of delJob) {
      const rol = h.metadata?.cadena?.rol
      if (rol && !sembrado[rol]) sembrado[rol] = { url: h.storage_url }
    }
    if (Object.keys(sembrado).length) salidasPorPaso[pasoOrigen] = sembrado
  }

  for (let k = 0; k < pasos; k++) {
    const i = pasoDe(anterior)
    if (i >= def.pasos.length) break
    const paso = def.pasos[i]

    const entry = await getWorkflowByName(paso.workflow)
    if (!entry) throw new Error(`Workflow "${paso.workflow}" is not registered`)
    const roles = entry.inject_config?.salidas || null

    // Resolver las imágenes de entrada y subirlas a ComfyUI: el proveedor no acepta URLs ajenas.
    const extras = {}
    for (const [campo, ref] of Object.entries(paso.entradas)) {
      let url
      if (ref === 'origen') url = anterior.storage_url
      else {
        const [pasoRef, rol] = ref.split(':')
        const s = salidasPorPaso[pasoRef]
        if (!s) throw new Error(`Step "${paso.clave}" needs the output of "${pasoRef}", which did not run`)
        // `*` = la salida principal de un paso de una sola imagen.
        url = rol === '*' ? Object.values(s)[0]?.url : s[rol]?.url
        if (!url) throw new Error(`Step "${paso.clave}" needs "${rol}" from "${pasoRef}" and it is not there`)
      }
      extras[campo] = await uploadImageToComfyUI(url)
    }

    // Las semillas de las vistas van aparte: comparten workflow pero no nodo, y con la misma
    // semilla en las tres el modelo devuelve tres veces el mismo ángulo.
    for (const clave of Object.keys(entry.inject_config?.extra || {})) {
      if (clave.startsWith('seed_')) extras[clave] = Math.floor(Math.random() * 2147483647)
    }

    const t0 = Date.now()
    const jobId = await submitWorkflow(paso.workflow, paso.pide_prompt ? (prompt || '') : '', 1024, 1024, extras)
    await pollUntilDone(jobId, 300_000)   // Tripo y gpt-image-2 tardan bastante más que un render local
    const base = `projects/${project_id}/chain/${nombreCadena}/${paso.clave}/${jobId.slice(0, 8)}`
    const salidas = await downloadOutputsByNode(jobId, base)

    // Del nodo al rol. Con mapa declarado manda el mapa Y NADA MÁS: un workflow publica más de lo
    // que interesa guardar —el de 3D tiene un `Preview3D` que emite el MISMO .glb que el `SaveGLB`,
    // así que aceptar lo no declarado creaba dos activos idénticos del mismo archivo. Sin mapa, el
    // nodo hace de rol, que es mejor que inventar un orden.
    const porRol = {}
    for (const [nodo, s] of Object.entries(salidas)) {
      if (roles && !roles[nodo]) continue
      porRol[roles?.[nodo] || nodo] = s
    }
    if (!Object.keys(porRol).length) {
      throw new Error(`Step "${paso.clave}" produced output, but none from the declared nodes (${Object.keys(roles || {}).join(', ')})`)
    }
    salidasPorPaso[paso.clave] = porRol

    logExecution({
      project_id, node_id: origen.node_id, triggered_by: member_id,
      trigger_type: 'chain', executor_type: 'comfyui', provider: 'comfyui', model: paso.workflow,
      is_estimated: true, duration_ms: Date.now() - t0, started_at: new Date(t0).toISOString(),
      metadata: { cadena: nombreCadena, paso: paso.clave, salidas: Object.keys(porRol).length },
    })

    // Una sesión por paso: el asset la exige y además es lo que deja el paso trazado en el log.
    const { data: ses } = await db().from('forge_sessions').insert({
      project_id, node_id: origen.node_id, output_key: null, status: 'auto_approved',
      iteration_count: 1, started_at: new Date(t0).toISOString(), completed_at: new Date().toISOString(),
      triggered_by: member_id,
    }).select('id').single()

    // Un activo por salida. Nacen `approved`: son el resultado de un paso que el usuario pidió y
    // confirmó, y dejarlos pendientes los volvería invisibles para los nodos de aguas abajo.
    const nuevos = []
    for (const [rol, s] of Object.entries(porRol)) {
      const sufijo = Object.keys(porRol).length > 1 ? ` — ${rol}` : ''
      const { data: a, error } = await db().from('forge_assets').insert({
        project_id, node_id: origen.node_id, session_id: ses.id,
        name: `${origen.name} — ${paso.etiqueta}${sufijo}`,
        format: s.kind === 'model' ? 'glb' : 'png',
        mime_type: s.kind === 'model' ? 'model/gltf-binary' : 'image/png',
        status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
        storage_url: s.url, file_size_bytes: s.size_bytes,
        derived_from_id: anterior.id,
        metadata: { cadena: { nombre: nombreCadena, paso: paso.clave, rol }, job: jobId, prompt: paso.pide_prompt ? prompt : null },
      }).select('id, name, storage_url, format, metadata').single()
      if (error) throw error
      nuevos.push(a)
      creados.push(a)
    }

    // El siguiente paso arranca desde la salida principal de este.
    anterior = nuevos.find(a => a.metadata?.cadena?.rol === 'master') || nuevos[0]
  }

  return { cadena: nombreCadena, creados }
}

module.exports = { CADENAS, cadenaDe, pasoDe, proximoPaso, avanzar }
