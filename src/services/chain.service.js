// ─── Cadenas de producción: avanzar una pieza de etapa, un paso a la vez ─────
//
// Del documento de menús radiales (§8-§10, revisión del 26-08). Una página no se rehace: AVANZA.
// De la hoja de personaje salen las tres vistas, y de las tres vistas sale el modelo 3D. Cada paso
// produce activos NUEVOS conectados al anterior (`derived_from_id`) y publicados a su derecha.
//
// **Run avanza UN paso.** No hay encadenado automático: correr los dos seguidos es apretar Run dos
// veces. Editar la página en su sitio es otra cosa —Design Edits— y no pasa por acá.
//
// El último paso no devuelve una imagen sino un `.glb`. Por eso las salidas se leen por NODO y no
// «la primera que aparezca»: el concept art emite cuatro y el 3D pide tres de ellas POR ROL.

const { submitWorkflow, pollUntilDone, downloadOutputsByNode, uploadImageToComfyUI } = require('./providers/comfyui.provider')
const { getWorkflowByName } = require('./config.service')
const { logExecution } = require('./execution-log.service')

// `origen` = el activo sobre el que se apretó Run. `<paso>:<rol>` = una salida del paso anterior.
// La cadena es la de PRODUCCIÓN, y `Moodboard Iteration` NO está en ella.
//
// Miguel lo aclaró el 26-08, corrigiendo la contradicción entre §6 y §10 del documento: ese
// workflow es **Design Edits**, que edita la página EN SU SITIO y la reemplaza por una versión
// nueva conservando el layout; la anterior queda en la Asset Library. No publica a la derecha y no
// dispara nada detrás. Los pasos de producción son ejecuciones de Run, una por una — no un
// encadenado automático.
//
// Por eso Run arranca en el concept art y toma la página tal como está: si el usuario la editó
// antes con Design Edits, lo que Run ve ya es la versión editada.
const CADENAS = {
  character_sheet: {
    etiqueta: 'Character Sheet',
    pasos: [
      {
        clave: 'concept_art', workflow: 'V57_STUDIO_ConceptArt_Characters', etiqueta: 'Concept art',
        que:    'Three pages to the right: the front, side and back views of this character.',
        porque: 'A mesh cannot be built from one picture — the three views are what make the body consistent.',
        entradas: { image: 'origen' },
        // El workflow emite además un maestro intermedio que alimenta a las tres vistas. No se
        // publica: el documento pide TRES páginas, y una cuarta casi idéntica al lado de las otras
        // se lee como una vista más y no como el intermedio que es.
        publica: ['front', 'left', 'back'],
      },
      {
        clave: '3d', workflow: 'V57_STUDIO_3D_Production_Characters', etiqueta: '3D production',
        que:    'One textured .glb model, to the right of the views.',
        porque: 'This is the asset the vertical slice actually ships.',
        entradas: { image: 'concept_art:front', image_left: 'concept_art:left', image_back: 'concept_art:back' },
      },
    ],
  },

  prop_sheet: {
    etiqueta: 'Prop Sheet',
    pasos: [
      {
        clave: 'concept_art', workflow: 'V57_STUDIO_ConceptArt_Props', etiqueta: 'Concept art',
        que:    'One page to the right: the concept art of this prop.',
        porque: 'Tripo builds the mesh from the concept, not from the sheet that describes it.',
        entradas: { image: 'origen' },
      },
      {
        clave: '3d', workflow: 'V57_STUDIO_3D_Production_Props', etiqueta: '3D production',
        que:    'One .glb model of the prop.',
        porque: 'This is the asset the vertical slice actually ships.',
        entradas: { image: 'concept_art:concept' },
      },
    ],
  },

  environment_sheet: {
    etiqueta: 'Environment Sheet',
    pasos: [
      {
        clave: 'concept_art', workflow: 'V57_STUDIO_ConceptArt_Environments', etiqueta: 'Concept art',
        que:    'Twenty pages to the right: the twenty parts this environment breaks into.',
        porque: 'A scene is built part by part — the sheet describes the whole, the parts are what gets modelled.',
        entradas: { image: 'origen' },
      },
      {
        clave: '3d', workflow: 'V57_STUDIO_3D_Production_Environment', etiqueta: '3D production',
        que:    'One .glb per part: twenty models, each to the right of its own part.',
        porque: 'These are the pieces the scene is assembled from.',
        // El workflow del 3D toma UNA imagen y devuelve UN modelo, así que corre una vez por
        // parte. Miguel preguntó si había que replicar el workflow veinte veces o correrlo en
        // lote: ninguna de las dos — es el mismo workflow, veinte despachos, que es lo que
        // `porCadaSalidaDe` expresa. Replicarlo daría veinte copias que mantener.
        porCadaSalidaDe: 'concept_art',
        entradas: { image: '<cada>' },
      },
    ],
  },
}

// Qué cadena le toca a un activo. Hoy solo la de Character Sheet está definida; el documento dice
// que las demás páginas «usan sus propios workflows, que están por definir más adelante», así que
// devolver null es la respuesta correcta y no un caso de error.
function cadenaDe(asset) {
  const n = String(asset?.name || '')
  if (/character\s*sheet/i.test(n))    return 'character_sheet'
  if (/prop\s*sheet/i.test(n))         return 'prop_sheet'
  if (/environment\s*sheet/i.test(n))  return 'environment_sheet'
  // UI Component Sheet (ASG_31) y VFX Sheet (ASG_32) existen en el ASG pero todavía no tienen
  // workflow; Audio Sheet tiene workflow pero no tiene página. Marketing necesita rellenar el ADI
  // en su prompt, que es ensamblado y no cableado. Los tres casos devuelven null a propósito.
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

    // Un paso normal despacha UNA vez. Uno marcado `porCadaSalidaDe` despacha una vez por cada
    // salida de ese paso: el 3D del escenario toma una parte y devuelve un modelo, así que veinte
    // partes son veinte despachos del MISMO workflow.
    //
    // Miguel preguntó si había que replicar el workflow veinte veces o correrlo en lote: ninguna
    // de las dos. Replicarlo daría veinte copias del mismo JSON que mantener; el lote no existe
    // porque el workflow recibe una imagen y devuelve un modelo.
    const instancias = paso.porCadaSalidaDe
      ? Object.keys(salidasPorPaso[paso.porCadaSalidaDe] || {})
      : [null]
    if (paso.porCadaSalidaDe && !instancias.length) {
      throw new Error(`Step "${paso.clave}" runs once per output of "${paso.porCadaSalidaDe}", which produced none`)
    }

    const acumulado = {}
    const nuevos = []

    for (const cada of instancias) {
      // Resolver las imágenes de entrada y subirlas a ComfyUI: el proveedor no acepta URLs ajenas.
      const extras = {}
      for (const [campo, ref] of Object.entries(paso.entradas)) {
        let url
        if (ref === 'origen') url = anterior.storage_url
        else if (ref === '<cada>') url = salidasPorPaso[paso.porCadaSalidaDe]?.[cada]?.url
        else {
          const [pasoRef, rol] = ref.split(':')
          const sal = salidasPorPaso[pasoRef]
          if (!sal) throw new Error(`Step "${paso.clave}" needs the output of "${pasoRef}", which did not run`)
          // `*` = la salida principal de un paso de una sola imagen.
          url = rol === '*' ? Object.values(sal)[0]?.url : sal[rol]?.url
          if (!url) throw new Error(`Step "${paso.clave}" needs "${rol}" from "${pasoRef}" and it is not there`)
        }
        if (!url) throw new Error(`Step "${paso.clave}" has no image for "${campo}"`)
        extras[campo] = await uploadImageToComfyUI(url)
      }

      // Las semillas de las vistas van aparte: comparten workflow pero no nodo, y con la misma
      // semilla en las tres el modelo devuelve tres veces el mismo ángulo.
      for (const clave of Object.keys(entry.inject_config?.extra || {})) {
        if (clave.startsWith('seed_')) extras[clave] = Math.floor(Math.random() * 2147483647)
      }

      const t0 = Date.now()
      if (cada) console.log(`[cadena] ${paso.clave}: despachando ${cada} (${instancias.indexOf(cada) + 1}/${instancias.length})`)
      const jobId = await submitWorkflow(paso.workflow, paso.pide_prompt ? (prompt || '') : '', 1024, 1024, extras)
      await pollUntilDone(jobId, 300_000)   // Tripo y gpt-image-2 tardan bastante más que un render local
      const base = `projects/${project_id}/chain/${nombreCadena}/${paso.clave}/${cada ? cada + '-' : ''}${jobId.slice(0, 8)}`
      const salidas = await downloadOutputsByNode(jobId, base)

      // Del nodo al rol. Con mapa declarado manda el mapa Y NADA MÁS: un workflow publica más de
      // lo que interesa guardar —el de 3D tiene un `Preview3D` que emite el MISMO .glb que el
      // `SaveGLB`, así que aceptar lo no declarado creaba dos activos idénticos del mismo archivo.
      const porRol = {}
      for (const [nodo, sal] of Object.entries(salidas)) {
        if (roles && !roles[nodo]) continue
        porRol[roles?.[nodo] || nodo] = sal
      }
      if (!Object.keys(porRol).length) {
        throw new Error(`Step "${paso.clave}" produced output, but none from the declared nodes (${Object.keys(roles || {}).join(', ')})`)
      }

      logExecution({
        project_id, node_id: origen.node_id, triggered_by: member_id,
        trigger_type: 'chain', executor_type: 'comfyui', provider: 'comfyui', model: paso.workflow,
        is_estimated: true, duration_ms: Date.now() - t0, started_at: new Date(t0).toISOString(),
        metadata: { cadena: nombreCadena, paso: paso.clave, parte: cada, salidas: Object.keys(porRol).length },
      })

      // Una sesión por despacho: el asset la exige y además deja el paso trazado en el log.
      const { data: ses } = await db().from('forge_sessions').insert({
        project_id, node_id: origen.node_id, output_key: null, status: 'auto_approved',
        iteration_count: 1, started_at: new Date(t0).toISOString(), completed_at: new Date().toISOString(),
        triggered_by: member_id,
      }).select('id').single()

      // `paso.publica` acota cuáles se publican. Lo que no se publica igual queda en
      // `salidasPorPaso` y sirve de entrada al paso siguiente: un intermedio del workflow no es una
      // página del moodboard, pero sí es material.
      const publicables = paso.publica
        ? Object.entries(porRol).filter(([rol]) => paso.publica.includes(rol))
        : Object.entries(porRol)

      // Cada pieza cuelga de LO SUYO: en un paso por-cada-parte, el modelo de la parte 07 cuelga
      // de la parte 07, no del origen. Si no, veinte cables salen todos de la misma hoja y el
      // grafo deja de contar de dónde vino cada cosa.
      const padre = cada
        ? (salidasPorPaso[paso.porCadaSalidaDe]?.[cada]?.assetId ?? anterior.id)
        : anterior.id

      for (const [rol, sal] of publicables) {
        // Con instancias, el nombre lleva la parte; sin ellas, el rol solo si hay más de uno.
        const sufijo = cada ? ` — ${cada}` : (publicables.length > 1 ? ` — ${rol}` : '')
        const { data: a, error } = await db().from('forge_assets').insert({
          project_id, node_id: origen.node_id, session_id: ses.id,
          name: `${origen.name} — ${paso.etiqueta}${sufijo}`,
          format: sal.kind === 'model' ? 'glb' : 'png',
          mime_type: sal.kind === 'model' ? 'model/gltf-binary' : 'image/png',
          status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
          storage_url: sal.url, file_size_bytes: sal.size_bytes,
          derived_from_id: padre,
          metadata: { cadena: { nombre: nombreCadena, paso: paso.clave, rol, parte: cada ?? null }, job: jobId, prompt: paso.pide_prompt ? prompt : null },
        }).select('id, name, storage_url, format, metadata').single()
        if (error) throw error
        // El id del activo viaja junto a la url: el paso siguiente lo necesita para colgar de él.
        acumulado[cada ? cada : rol] = { ...sal, assetId: a.id }
        nuevos.push(a)
        creados.push(a)
      }
    }

    salidasPorPaso[paso.clave] = acumulado

    // El paso siguiente cuelga del primero que se publicó. Un intermedio no publicado no es
    // activo, así que colgar de él dejaría `derived_from` apuntando a algo que el moodboard no
    // muestra y el cable saldría de la nada.
    anterior = nuevos[0] ?? anterior
  }

  return { cadena: nombreCadena, creados }
}

module.exports = { CADENAS, cadenaDe, pasoDe, proximoPaso, avanzar }
