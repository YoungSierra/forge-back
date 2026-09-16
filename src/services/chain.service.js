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
const progreso = require('./progreso.service')

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

  // La pista de audio del Vertical Slice. Un solo paso, y corre por el camino de DECK en vez del
  // de cadena: su prompt es el formulario del ADI —«CORE FANTASY (§1.2) →»— y rellenarlo es lo que
  // hace el compositor de láminas, no el inyector de cadenas. Registrarlo como paso normal habría
  // mandado el formulario en blanco, que es peor que no mandarlo.
  //
  // La referencia —la propia página Audio Sheet del ASG— la resuelve el deck por su nombre, así
  // que no hace falta cablearla acá.
  // Las dos piezas promocionales salen de la MISMA hoja y no una de la otra: son hermanas, no
  // pasos encadenados. Van como dos pasos igual porque así es como Run las entrega —de a una, con
  // su recuadro de confirmación cada una— y cada despacho es pago. Primero la lámina, después el
  // teaser, que es el orden en que se revisan.
  marketing: {
    etiqueta: 'Marketing',
    pasos: [
      {
        clave: 'key_art', workflow: 'V57_STUDIO_2D_marketing_image', etiqueta: 'Key Art',
        deck: 'marketing_image',
        que:    'One promotional key image to the right of this sheet.',
        porque: 'The slice needs a poster, and this sheet already holds the beats it has to sell.',
        entradas: {},
      },
      {
        clave: 'video', workflow: 'V57_STUDIO_2D_marketing_video', etiqueta: 'Teaser',
        deck: 'marketing_video',
        que:    'One promotional teaser with its own audio, to the right of this sheet.',
        porque: 'The six panels of this sheet are the storyboard the teaser follows.',
        entradas: {},
      },
    ],
  },

  // La hoja de poses de cada movimiento. Es la cadena más corta y la única que NO termina dentro
  // de Forge: entrega las láminas y de ahí el flujo sigue en Cascadeur, por script, fuera del
  // Moodboard. Eso no es un hueco a cerrar —no hay forma de correr Cascadeur desde ComfyUI
  // cloud—, es dónde termina este tramo, y el paquete que lo especifica lo dice así.
  //
  // El ancla no es la lámina que se pulsó sino el personaje; los clips salen del ADI. Los dos
  // detalles están explicados en `animacion.service`.
  animation_sheet: {
    etiqueta: 'Animation Sheet',
    pasos: [
      {
        clave: 'pose_sheet', workflow: 'V57_STUDIO_2D_Character_Pose_Sheet', etiqueta: 'Pose sheet',
        porCadaClip: true,
        que:    'One pose sheet per animation clip — three views across as many columns as the movement has key poses.',
        porque: 'Cascadeur builds the real keyframes from these sheets; without them the rig has nothing to pose against.',
        entradas: { image: 'ancla_personaje' },
      },
    ],
  },

  // Las pantallas del slice. Corre por el camino de DECK y no por el de workflow suelto: son ocho
  // prompts, uno por página, y el compositor es quien sabe repartirlos —mandarlo como un workflow
  // de prompt único dejaría siete páginas sin pedido.
  //
  // Su referencia es la Key Art del propio juego, que cada página cita en su `image_inputs`.
  // Medido el 15-09 contra la base viva: resuelve en 8 de 8 páginas en los cinco proyectos que
  // tienen ASG renderizado. Estaba anotado como que no resolvía, y ya no es verdad.
  ui_component_sheet: {
    etiqueta: 'UI Component Sheet',
    pasos: [
      {
        clave: 'ui', workflow: 'V57_STUDIO_2D_uiux', deck: 'uiux', etiqueta: 'UI screens',
        que:    'Eight pages to the right: the four screens — main menu, pause, HUD and defeat — and a sprite sheet for each.',
        porque: 'The slice ships with a screen the player reads and one for failing, and the engine needs the sheet, not the mockup.',
        entradas: {},
      },
    ],
  },

  // El flipbook de un efecto. Un solo paso y catorce salidas, porque el workflow encadena solo:
  // la lámina aprobada entra por su único `LoadImage`, de ahí sale el lookdev, del lookdev el
  // atlas de 12 celdas, y de ese atlas se recorta cada frame. Publicar solo el atlas dejaría al
  // motor de juego partiéndolo a mano; publicar solo los frames tiraría la hoja que el artista
  // revisa. Van los catorce.
  vfx_sheet: {
    etiqueta: 'VFX Sheet',
    pasos: [
      {
        clave: 'flipbook', workflow: 'V57_STUDIO_2D_vfx_flipbook', etiqueta: 'VFX flipbook',
        que:    'Fourteen pages to the right: the lookdev, the 12-cell atlas, and each frame from START through PEAK to DISSIPATE.',
        porque: 'The slice needs the effect of the main action and the one for taking damage, and an engine plays them frame by frame.',
        entradas: { image: 'origen' },
      },
    ],
  },

  audio_sheet: {
    etiqueta: 'Audio Sheet',
    pasos: [
      {
        clave: 'audio', workflow: 'V57_STUDIO_2D_audio_base', etiqueta: 'Audio',
        deck: 'audio_base',
        que:    'One audio track to the right of this sheet.',
        porque: 'The slice needs its sound, and this sheet is what tells the model how it should feel.',
        entradas: {},
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
      {
        // El montaje es el paso siguiente de ESTA cadena, no una acción aparte: si de la hoja
        // salieron las veinte partes y sus veinte modelos, lo que toca después es armar el nivel
        // con ellos. Estaba colgado del radial y se pedía en otro sitio que todo lo demás.
        //
        // No despacha a ComfyUI: junta el grafo del nivel, las medidas y los papeles, y devuelve
        // el paquete que abre Blender. Por eso va marcado y no lleva workflow.
        clave: 'montaje', etiqueta: 'Level assembly', montaje: true,
        que:    'One .zip: the level graph, the kit and the assembly order, ready for the LoopForge add-on.',
        porque: 'The parts are modelled; this is what turns them into a level somebody can walk.',
        entradas: {},
      },
    ],
  },
}

// Qué cadena le toca a un activo. Hoy solo la de Character Sheet está definida; el documento dice
// que las demás páginas «usan sus propios workflows, que están por definir más adelante», así que
// devolver null es la respuesta correcta y no un caso de error.
// Qué formato y mime guardar. La extensión del archivo manda: un `.mp3` etiquetado `image/png`
// se descarga y no suena en ningún lado.
const MIMES = {
  glb: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
}
function formatoDe(sal) {
  const ext = (/\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(String(sal.url || ''))?.[1] || '').toLowerCase()
  if (ext && MIMES[ext]) return { format: ext, mime_type: MIMES[ext] }
  // Sin extensión legible se cae a lo que declaró el productor, que es como funcionaba hasta hoy.
  return sal.kind === 'model'
    ? { format: 'glb', mime_type: 'model/gltf-binary' }
    : { format: 'png', mime_type: 'image/png' }
}

function cadenaDe(asset) {
  const n = String(asset?.name || '')
  if (/character\s*sheet/i.test(n))    return 'character_sheet'
  if (/prop\s*sheet/i.test(n))         return 'prop_sheet'
  if (/environment\s*sheet/i.test(n))  return 'environment_sheet'
  if (/audio\s*sheet/i.test(n))        return 'audio_sheet'
  if (/animation\s*sheet/i.test(n))    return 'animation_sheet'
  if (/vfx\s*sheet/i.test(n))          return 'vfx_sheet'
  if (/ui\s*component\s*sheet/i.test(n)) return 'ui_component_sheet'
  // Marketing sí es una cadena, y la hoja de Video Marketing es su origen: los dos workflows leen
  // ESA lámina —sus seis viñetas HOOK/WORLD/FANTASY/UNIQUE/CLIMAX/TITLE— más la de Visual DNA.
  // Antes devolvía null razonando que «produce una pieza del proyecto entero y no de una hoja»,
  // y por eso al pulsar Run sobre la hoja el aviso decía que no había nada que correr, con el
  // workflow registrado y funcionando.
  if (/video\s*marketing/i.test(n))    return 'marketing'
  return null
}

/** Las cadenas que hay, para que quien avise de que no hay ninguna pueda nombrarlas. */
const etiquetasDeCadenas = () => Object.values(CADENAS).map(c => c.etiqueta)

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
    // Qué paso alimenta a éste cuando corre una vez por cada salida. El recuadro necesita saberlo
    // para contar cuántos despachos son: apretar Run sobre una parte del escenario dispara las
    // veinte, y eso no puede quedar detrás de un botón que no lo dice.
    por_cada_salida_de: p.porCadaSalidaDe ?? null,

    // La cadena entera, para poder DIBUJARLA antes de correr (informe v6 #7, opción a de Miguel).
    // Solo los pasos de producción y con sus nombres llanos —«Concept art → 3D production»—; las
    // herramientas de edición no entran acá porque no son pasos de la cadena, son otra cosa que se
    // hace sobre una pieza ya hecha, y mezclarlas era justo lo que confundía.
    pasos: def.pasos.map((q, j) => ({
      clave: q.clave,
      etiqueta: q.etiqueta,
      estado: j < i ? 'hecho' : j === i ? 'siguiente' : 'despues',
    })),
  }
}

// ─── Corre N pasos desde donde esté el activo ────────────────────────────────
// Devuelve los activos creados, en orden. Si un paso falla se devuelve lo que sí se produjo: lo ya
// generado está pagado y publicado, y borrarlo para «dejar limpio» sería tirar plata.
// `opciones` son las de generación que eligió el usuario en el diálogo de Run (informe v3, punto
// 12). Valen para TODA la corrida —así lo confirmó Miguel—; regenerar una pieza suelta las pide
// aparte. Se guardan además en el metadata de cada activo producido: es lo que deja mostrarlas
// bajo la imagen y reusarlas al rehacerla.
async function avanzar({ db, project_id, asset_id, pasos = 1, prompt = null, member_id = null, limitePorCada = 0, opciones = null, clips = null }) {
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

  // De qué se llama lo que produce esta cadena. Heredar el nombre entero del origen le pegaba el
  // prefijo del DOCUMENTO —«Art Style Guide — 25_VideoMarketingSheet — Key Art»— y cualquier
  // resolvedor por nombre lo leía como una página del Art Style Guide llamada Key Art, tapando a
  // la de verdad. La pieza no es una página del documento: es lo que una cadena hizo A PARTIR de
  // una. Así que el nombre empieza por la cadena y conserva la hoja, que es la procedencia útil.
  //
  // El moodboard la sigue poniendo en el bloque de su hoja: la zona ya no se deduce del prefijo
  // sino de `derived_from`, que es quien sabe de dónde salió.
  const PREFIJO_DOC = /^\s*(Art Style Guide|GDD Art Style|Art Bible)\s*[—–-]\s*/i
  const sinDocumento = String(origen.name || '').replace(PREFIJO_DOC, '')
  // Si el origen ya es una pieza de esta cadena, su nombre YA empieza por la etiqueta: no se
  // vuelve a anteponer, o el segundo paso saldría «Marketing — Marketing — …».
  const raiz = sinDocumento.toLowerCase().startsWith(def.etiqueta.toLowerCase())
    ? sinDocumento
    : `${def.etiqueta} — ${sinDocumento}`

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
    let instancias = paso.porCadaSalidaDe
      ? Object.keys(salidasPorPaso[paso.porCadaSalidaDe] || {}).sort()
      : [null]
    if (paso.porCadaSalidaDe && !instancias.length) {
      throw new Error(`Step "${paso.clave}" runs once per output of "${paso.porCadaSalidaDe}", which produced none`)
    }

    // Y un paso `porCadaClip` despacha una vez por movimiento a animar. La diferencia con
    // `porCadaSalidaDe` es de dónde sale la lista: allí son las salidas del paso anterior, acá es
    // un documento —el ADI de animación— que enumera los movimientos con sus reglas. Cada clip es
    // una lámina distinta, y cada lámina se paga.
    let anim = null
    if (paso.porCadaClip) {
      anim = await require('./animacion.service').clipsDelProyecto({ db, project_id })
      instancias = anim.clips.map(c => c.nombre)
      // Elegir QUÉ animaciones correr, en vez de producir siempre el set entero. Es el punto 1 del
      // informe de JuanK: cada lámina es un despacho pago y el ADI nombra hasta ocho movimientos.
      // Lo que no se elige no se pierde — sigue disponible para otra corrida.
      if (Array.isArray(clips) && clips.length) {
        const pedidos = new Set(clips)
        const ajenos = clips.filter(c => !instancias.includes(c))
        if (ajenos.length) throw new Error(`These are not clips of this project: ${ajenos.join(', ')}`)
        instancias = instancias.filter(c => pedidos.has(c))
      }
      if (anim.descartados?.length) {
        console.log(`[cadena] ${paso.clave}: el ADI nombra más movimientos de los que se corren — quedan fuera ${anim.descartados.join(', ')}`)
      }
    }

    // Parado SOBRE una parte, se corre ESA parte y ninguna otra.
    //
    // La siembra de mitad de cadena reconstruye todos los hermanos del mismo job —hacen falta
    // para el personaje, donde el 3D necesita el frente, el costado y la espalda a la vez—, y en
    // el escenario eso son las veinte partes. Sin esta línea, apretar Run sobre la parte 18
    // reconstruía las veinte, las ordenaba y arrancaba por la primera: el modelo salía de la
    // parte 01, con el nombre de la 18 y la marca de la 01. Es el punto 3 del informe v4, y cada
    // despacho equivocado se paga.
    //
    // Solo aplica cuando el origen ES una de las salidas del paso anterior. Con Run sobre la hoja
    // madre —que no lleva marca de cadena— siguen corriendo las veinte, que es el lote que el
    // usuario pidió desde el principio.
    const rolOrigen = origen.metadata?.cadena?.rol
    if (paso.porCadaSalidaDe && rolOrigen && instancias.includes(rolOrigen)) {
      console.log(`[cadena] ${paso.clave}: Run sobre «${rolOrigen}» — se corre solo esa parte, no las ${instancias.length}`)
      instancias = [rolOrigen]
    }

    // `limitePorCada` corre solo las primeras N partes. Sirve para mirar una antes de
    // comprometer veinte: cada parte es un despacho pago y no reproducible, así que descubrir en
    // la número 3 que el encuadre no sirve cuesta las tres.
    //
    // Recorta SOLO este paso. Lo que ya produjo el anterior está pagado y sigue publicado; el
    // resto de las partes se pueden avanzar después, porque cada una arranca desde sí misma.
    if ((paso.porCadaSalidaDe || paso.porCadaClip) && limitePorCada > 0 && instancias.length > limitePorCada) {
      console.log(`[cadena] ${paso.clave}: ${instancias.length} partes, se corren ${limitePorCada} — el resto queda para otro Run`)
      instancias = instancias.slice(0, limitePorCada)
    }

    const acumulado = {}
    const nuevos = []

    // Lo que está pasando sale AFUERA mientras pasa (informe v6, punto 4): esta llamada puede
    // tardar minutos —veinte despachos a ComfyUI, uno detrás de otro— y desde el navegador era
    // un botón girando. Ver progreso.service.js.
    progreso.iniciar({
      project_id, asset_id: origen.id, cadena: nombreCadena,
      paso: paso.clave, etiqueta: paso.etiqueta, de: instancias.length,
    })

    for (const [nDespacho, cada] of instancias.entries()) {
      progreso.marcar(project_id, origen.id, {
        hecho: nDespacho, estado: 'preparando', que: cada || null,
      })
      // Resolver las imágenes de entrada y subirlas a ComfyUI: el proveedor no acepta URLs ajenas.
      const extras = {}
      for (const [campo, ref] of Object.entries(paso.entradas)) {
        let url
        if (ref === 'origen') url = anterior.storage_url
        // La hoja de poses no se ancla en la lámina que se pulsó —esa es una plantilla— sino en
        // el personaje: su vista frontal, que produjo la cadena de Character Sheet. Es el hueco
        // que el propio paquete marcaba: «nadie ató automáticamente la vista Frontal al nodo 17».
        else if (ref === 'ancla_personaje') {
          const ancla = await require('./animacion.service').anclaDelPersonaje({ db, project_id })
          url = ancla.url
          if (instancias.indexOf(cada) === 0) console.log(`[cadena] ${paso.clave}: ancla «${ancla.nombre}»`)
        }
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

      // Los beats de ESTE clip, y su nombre, que además nombra el archivo que devuelve ComfyUI.
      // Se componen justo antes de despachar y no todos de una: si uno falla, los anteriores ya
      // están rendidos y pagados, y componer los ocho para descubrirlo al final no ahorra nada.
      let promptDelDespacho = paso.pide_prompt ? (prompt || '') : ''
      if (paso.porCadaClip) {
        const clip = anim.clips.find(c => c.nombre === cada)
        const anm = require('./animacion.service')

        // Un beats escrito a mano manda sobre el que compone la skill. Es lo que pidió JuanK:
        // recibir Y crear. Si alguien subió `<clip>_beats.json` al proyecto, se usa ese — que es
        // además la única forma de corregir una trayectoria sin volver a pagar la lámina.
        // El más reciente con ese nombre. Solo cuenta como «puesto a mano» si NO lo escribimos
        // nosotros: lo que guarda la corrida lleva `origen: 'skill'`, y sin mirarlo la segunda
        // corrida reusaría sus propios beats creyéndolos de una persona.
        const { data: ultimo } = await db().from('forge_assets')
          .select('id, name, content, storage_url, metadata')
          .eq('project_id', project_id).eq('name', `${cada}_beats.json`)
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        const puesto = ultimo && ultimo.metadata?.beats?.origen !== 'skill' ? ultimo : null

        let beats
        if (puesto) {
          const crudo = puesto.content || await (await fetch(puesto.storage_url)).text()
          beats = anm.beatsDesdeJson(crudo, clip)
          console.log(`[cadena] ${paso.clave}: «${cada}» — beats puestos a mano (${beats.poses} poses)`)
        } else {
          beats = await anm.beatsDeClip({ clip, adi: anim.adi })
          // El archivo se guarda SIEMPRE, aunque el despacho falle después: componerlo cuesta una
          // llamada al modelo, y lo que Cascadeur necesita es este json, no la lámina.
          await anm.guardarBeats({ db, project_id, node_id: origen.node_id, clip: cada, json: beats.json, member_id, derivadoDe: origen.id })
          console.log(`[cadena] ${paso.clave}: «${cada}» — ${beats.poses} poses, beats guardados`)
        }

        promptDelDespacho = beats.texto
        extras.clip = cada
      }

      const t0 = Date.now()
      if (cada) console.log(`[cadena] ${paso.clave}: despachando ${cada} (${instancias.indexOf(cada) + 1}/${instancias.length})`)

      let jobId, porRol = {}

      if (paso.montaje) {
        // Sin workflow: lo arma el disparador de montaje, que ya sabe leer el nivel, componer la
        // gramática desde los papeles y subir el paquete. Acá solo se le dice de qué hoja viene.
        const { montarNivel } = require('./montaje-nivel.service')
        const r = await montarNivel({ db, project_id, asset_id: origen.id, member_id, desdeCadena: true })
        if (r.necesita_nivel) {
          const e = new Error(`This environment is used by ${r.niveles.length} levels: pick which one to assemble`)
          e.code = 'NECESITA_NIVEL'
          e.niveles = r.niveles
          throw e
        }
        creados.push({ id: r.asset?.id, name: r.asset?.name, storage_url: r.url, format: 'zip' })
        console.log(`[cadena] montaje: nivel ${r.nivel} · ${Math.round((r.bytes || 0) / 1024)} KB`)
        anterior = origen
        continue
      }

      if (paso.deck) {
        // Un paso de DECK: su prompt es un formulario del ADI y hay que rellenarlo antes de
        // mandarlo. Eso lo hace el compositor de láminas, no el inyector de cadenas, así que el
        // paso se despacha por ese camino y vuelve con las páginas ya subidas. La referencia —la
        // propia hoja del ASG— la resuelve el deck por su nombre.
        const { generateDeck } = require('./image-gen.service')
        const r = await generateDeck({
          db, project_id, node_id: origen.node_id, node_key: paso.deck,
          output_key: paso.clave, image_gen_model: `comfyui:${paso.workflow}`,
          deck: paso.deck, member_id,
        })
        jobId = r.jobId
        if (!r.paginas?.length) {
          throw new Error(`Step "${paso.clave}" produced nothing${r.avisos?.length ? `: ${r.avisos.join(' · ')}` : ''}`)
        }
        for (const pg of r.paginas) porRol[pg.name] = { url: pg.url, kind: pg.kind || 'image' }
      } else {
        jobId = await submitWorkflow(paso.workflow, promptDelDespacho, 1024, 1024, extras, opciones)
        progreso.marcar(project_id, origen.id, { estado: 'generando' })
        await pollUntilDone(jobId, 300_000)   // Tripo y gpt-image-2 tardan bastante más que un render local
        progreso.marcar(project_id, origen.id, { estado: 'publicando' })
        const base = `projects/${project_id}/chain/${nombreCadena}/${paso.clave}/${cada ? cada + '-' : ''}${jobId.slice(0, 8)}`
        const salidas = await downloadOutputsByNode(jobId, base)

        // Del nodo al rol. Con mapa declarado manda el mapa Y NADA MÁS: un workflow publica más de
        // lo que interesa guardar —el de 3D tiene un `Preview3D` que emite el MISMO .glb que el
        // `SaveGLB`, así que aceptar lo no declarado creaba dos activos idénticos del mismo archivo.
        for (const [nodo, sal] of Object.entries(salidas)) {
          if (roles && !roles[nodo]) continue
          porRol[roles?.[nodo] || nodo] = sal
        }
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
          name: `${raiz} — ${paso.etiqueta}${sufijo}`,
          // Una cadena ya no produce solo imágenes y modelos: la del Audio Sheet devuelve un mp3.
          // El formato sale de la extensión del archivo que se subió, no de una suposición.
          ...formatoDe(sal),
          status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
          storage_url: sal.url, file_size_bytes: sal.size_bytes,
          derived_from_id: padre,
          // Las opciones quedan pegadas a la pieza: es lo que se muestra debajo de la imagen y lo
          // que se reusa al rehacerla. Sin esto habría que adivinar con qué se generó, y el
          // workflow ya cambió de valores para entonces.
          metadata: {
            cadena: { nombre: nombreCadena, paso: paso.clave, rol, parte: cada ?? null },
            job: jobId, prompt: paso.pide_prompt ? prompt : null,
            ...(opciones && Object.keys(opciones).length ? { opciones } : {}),
          },
        }).select('id, name, storage_url, format, metadata').single()
        if (error) throw error

        // Un modelo se mide al nacer: leer su caja cuesta 200 ms contra el propio archivo y es lo
        // que después necesita el escalado del kit para calcular el factor. Si falla, se sigue —
        // la pieza ya está publicada y la medida se puede pedir después; perderla no vale tirar
        // una corrida que ya se pagó.
        if (sal.kind === 'model') {
          try {
            const { medirActivo } = require('./glb-medidas.service')
            await medirActivo(db, a)
          } catch (e) { console.warn(`[cadena] no se pudo medir "${a.name}": ${e.message}`) }
        }

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

module.exports = { CADENAS, cadenaDe, pasoDe, proximoPaso, avanzar, etiquetasDeCadenas }
