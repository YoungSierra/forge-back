// ─── El disparador del montaje ───────────────────────────────────────────────
//
// Dónde se pulsa para que un nivel se monte.
//
// La spec lo pone «en el Environment Sheet» (`FORGE_INTEGRATION_ANSWERS_v2` §4, ratificado sin
// cambios por `FORGE_MONTAJE_FINAL_v3` §7). El problema de bajar eso a la interfaz es que en Forge
// un Environment Sheet **no es un objeto**: el propio `FORGE_PROCESS` §2 lo define como un
// CONJUNTO —`world_visuals` del 3.4, más las páginas de entorno del Art Style Guide, más las
// `reference_images` del 3.9— y ese conjunto no está registrado en ninguna parte. No hay a qué
// colgarle un botón.
//
// Así que el disparador se cuelga de la única pieza que **nombra su entorno en su propio nombre**:
// la imagen de `world_visuals`, «World Design — The Coral Shallows». Las páginas del ASG y las
// `reference_images` entran después como fuente de escala, pero no sirven de disparador porque no
// dicen de qué entorno son: «Art Style Guide — 29_EnvironmentSheet» no distingue un entorno de
// otro, y «REF-03» menos todavía.
//
// Y el nivel no se adivina. El bundle se emite por NIVEL, la imagen es de un ENTORNO, y quien los
// relaciona es `level_map` (nodo 3.5): su tabla resumen trae una fila por nivel con su entorno al
// lado. Si un solo nivel usa este entorno se dispara directo; si son varios, se pregunta cuál; si
// no lo usa ninguno, se dice. Nunca se monta «el primero».
//
// Los guardas son de la spec, no invención: «si en algún nivel el Environment Sheet se aprueba
// antes que el `level_map`, el disparador debe fallar de forma explícita señalando qué falta —
// nunca generar con datos parciales». Por eso esto vive en el back y no en el front: si dependiera
// de la interfaz, cada visor tendría que repetir la regla y bastaría abrir el menú desde otro lado
// para saltársela.

const { BASE } = require('./mapas.service')

// El prefijo con el que el nodo 3.4 nombra sus imágenes de entorno. Verificado contra la base
// viva: las 6 que existen se llaman «World Design — <entorno>», sin excepción.
const PREFIJO_ENTORNO = /^\s*World Design\s*[—–-]\s*/i

// Encabezados con los que un level_map llama a su columna de nivel. Los dos que existen hoy usan
// palabras distintas —«Level» en uno, «Life» en otro, porque el juego cuenta vidas y no niveles—
// así que se reconoce por la columna de AL LADO, `Environment`, que sí es estable.
const COL_ENTORNO = /^\s*environments?\s*$/i

/** Para comparar nombres de entorno: sin acentos, sin el código «ENV-01», sin puntuación. */
const norm = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/^env[-_\s]?\d+\s*/, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

/** El entorno que retrata esta pieza, o `null` si no es una hoja de entorno. */
function entornoDe(asset) {
  const n = String(asset?.name || '')
  if (!PREFIJO_ENTORNO.test(n)) return null
  // El nombre puede seguir creciendo por la derecha si la pieza pasó por una cadena
  // («… — Concept art — 3D production»): el entorno es solo el primer tramo.
  const resto = n.replace(PREFIJO_ENTORNO, '').split(/\s+[—–]\s+/)[0].trim()
  return resto || null
}

/**
 * Los niveles que usan un entorno, leídos de la tabla resumen del `level_map`.
 *
 * Se lee la tabla y no la prosa a propósito: la prosa nombra el entorno en cada sección de nivel,
 * pero también lo nombra al hablar de otros niveles («a diferencia de ENV-01…»), y ahí empezaría a
 * hacer falta adivinar. La tabla es una relación declarada.
 */
function nivelesDelEntorno(md, entorno) {
  const objetivo = norm(entorno)
  if (objetivo.length < 4) return []            // un nombre de dos letras casa con cualquier cosa

  const lineas = String(md || '').split('\n')
  const filas = []
  let colNivel = -1, colEntorno = -1

  for (const linea of lineas) {
    if (!linea.includes('|')) { colEntorno = -1; continue }   // la tabla terminó
    const celdas = linea.split('|').map(c => c.trim())
    // Los bordes vacíos de «| a | b |» no son columnas.
    if (celdas[0] === '') celdas.shift()
    if (celdas[celdas.length - 1] === '') celdas.pop()
    if (!celdas.length) continue

    if (colEntorno < 0) {
      const i = celdas.findIndex(c => COL_ENTORNO.test(c))
      if (i > 0) { colEntorno = i; colNivel = 0 }             // el nivel es siempre la primera
      continue
    }
    if (/^[-: ]+$/.test(celdas[0])) continue                  // la línea de guiones del encabezado

    const celdaEntorno = celdas[colEntorno] || ''
    const celdaNivel   = celdas[colNivel] || ''
    if (!celdaEntorno || !celdaNivel) continue

    // Una celda de entorno puede nombrar varios («Ground Floor + Cellar»): casa si alguno casa.
    const partes = celdaEntorno.split(/\s*[+,/]\s*/).map(norm).filter(Boolean)
    const casa = partes.some(p => p === objetivo || p.includes(objetivo) || objetivo.includes(p))
    if (casa) filas.push({ nivel: celdaNivel, entorno: celdaEntorno })
  }
  return filas
}

/**
 * Qué puede hacer el radial sobre ESTA pieza, y qué falta si no puede.
 *
 * Devuelve siempre `aplica`, que es lo que decide si el sector existe, y `faltantes`, que es lo
 * que decide si responde. Un faltante no es un error: es el estado del proyecto, dicho con
 * nombre propio para que se pueda ir a resolverlo.
 */
async function estadoDeMontaje({ db, project_id, asset_id }) {
  const { data: asset } = await db().from('forge_assets')
    .select('id, name, format, storage_url, output_key')
    .eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!asset) return { aplica: false, motivo: 'Asset not found' }

  const entorno = entornoDe(asset)
  if (!entorno) return { aplica: false }

  // El nombre ya dijo que es una hoja de entorno; la clave de salida lo confirma contra el nodo
  // que la emitió. No al revés: buena parte de las imágenes se generaron en modo nodo entero y no
  // tienen clave, así que exigirla sola dejaría fuera piezas legítimas.
  //
  // La clave la lleva la propia pieza desde la migración 054. Antes había que saltar a su sesión
  // para averiguarla, que es el rodeo que daban los tres consumidores de este dato.
  if (asset.output_key && asset.output_key !== 'world_visuals') return { aplica: false }

  const faltantes = []

  // 1 · El level_map, que es quien dice qué nivel usa este entorno.
  const { data: sesLM } = await db().from('forge_sessions')
    .select('id').eq('project_id', project_id).eq('output_key', 'level_map')
  let niveles = []
  let hayLevelMap = false
  if ((sesLM || []).length) {
    const { data: docs } = await db().from('forge_assets')
      .select('content').in('session_id', sesLM.map(s => s.id)).not('content', 'is', null)
    const md = (docs || []).map(d => d.content).join('\n\n')
    hayLevelMap = Boolean(md.trim())
    if (hayLevelMap) niveles = nivelesDelEntorno(md, entorno)
  }
  if (!hayLevelMap) {
    faltantes.push({ que: 'level_map', dice: 'Level Design (node 3.5) has not produced its level map yet' })
  } else if (!niveles.length) {
    faltantes.push({ que: 'nivel', dice: `No level in the level map uses “${entorno}”` })
  }

  // 2 · Los modelos. El paquete los lleva tal cual: no se miden acá (ver comprobarKit).
  const { data: modelos } = await db().from('forge_assets')
    .select('id, name, metadata').eq('project_id', project_id).eq('format', 'glb')
    .not('storage_url', 'is', null)
  if (!(modelos || []).length) {
    faltantes.push({ que: 'kit', dice: 'This project has no 3D models to export' })
  }

  return {
    aplica: true,
    entorno,
    niveles,
    faltantes,
    listo: faltantes.length === 0,
    // Los modelos con los que se montaría, y el papel que tiene puesto cada uno. Viaja con el
    // estado porque quien abre el radial es justo quien va a marcarlos: pedirlo aparte obligaría
    // a una segunda vuelta para dibujar la misma ventana.
    modelos: (modelos || [])
      .map(m => ({
        id: m.id, nombre: m.name,
        papel: m.metadata?.montaje?.clase || null,
        cadena: m.metadata?.cadena?.nombre || null,
      }))
      .sort((a, b) => peso(a.cadena) - peso(b.cadena) || a.nombre.localeCompare(b.nombre)),
    papeles: catalogoDePapeles(),
  }
}

// ─── El papel que juega cada modelo ──────────────────────────────────────────
//
// Qué pieza es el muro exterior no sale de la geometría: nada en un bbox lo dice. Es la única
// decisión de arte que el montaje necesita y la que faltaba para que el sector respondiera.
//
// El vocabulario no lo inventamos: son las clases que declara el kit de Maps_App
// (`level_generator/assembly/kit.py`). Los papeles ESTRUCTURALES viajan en la gramática, donde
// `estructura.<papel>.asset` nombra UNA pieza concreta; los de PROP viajan como `clase` del
// asset y Maps_App los reparte por densidad, varias piezas por sala.
//
// Un modelo sin papel se queda fuera del montaje a propósito. El kit por defecto los mandaba a
// `piso_libre` —el pool de props—, así que un muro sin marcar se colocaba además como si fuera un
// mueble. Aquí nada se coloca por descarte: lo que no tiene papel, no entra.
const PAPELES = {
  piso:             { etiqueta: 'Floor',               donde: ['piso'] },
  muro_exterior:    { etiqueta: 'Exterior wall',       donde: ['arista_exterior'] },
  muro_interior:    { etiqueta: 'Interior wall',       donde: ['arista_interior'] },
  muro_con_puerta:  { etiqueta: 'Wall with a doorway', donde: ['arista_con_puerta', 'muro'] },
  marco_de_puerta:  { etiqueta: 'Door frame',          donde: ['arista_con_puerta', 'marco'] },
  hoja_de_puerta:   { etiqueta: 'Door leaf',           donde: ['arista_con_puerta', 'hojas'] },
  columna:          { etiqueta: 'Column',              donde: ['vertice', 'columna_de_arte'] },
  prop_contra_muro: { etiqueta: 'Prop against a wall', clase: 'piso_muro' },
  prop_libre:       { etiqueta: 'Free-standing prop',  clase: 'piso_libre' },
  accesorio_muro:   { etiqueta: 'Wall accessory',      clase: 'accesorio_muro' },
}

/** El catálogo, para que la interfaz no repita esta lista ni invente una clase que el kit ignora. */
const catalogoDePapeles = () => Object.entries(PAPELES).map(([clave, p]) => ({
  clave, etiqueta: p.etiqueta, estructural: Boolean(p.donde),
}))

/**
 * Marca —o borra, con `papel: null`— el papel de un modelo.
 *
 * Se guarda en el propio activo y no en una tabla aparte porque es una propiedad de la pieza: el
 * mismo muro juega el mismo papel en todos los niveles que lo usen.
 */
async function marcarPapel({ db, project_id, asset_id, papel, member_id = null }) {
  if (papel !== null && !PAPELES[papel]) {
    const err = new Error(`“${papel}” is not a structural role. Valid: ${Object.keys(PAPELES).join(', ')}`)
    err.code = 'PAPEL_DESCONOCIDO'
    throw err
  }
  const { data: asset } = await db().from('forge_assets')
    .select('id, name, format, metadata').eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!asset) { const e = new Error('Asset not found'); e.code = 'NO_ASSET'; throw e }
  if (asset.format !== 'glb') {
    const e = new Error(`“${asset.name}” is not a 3D model: only models take part in an assembly`)
    e.code = 'NO_ES_MODELO'
    throw e
  }

  const montaje = { ...(asset.metadata?.montaje || {}) }
  if (papel === null) delete montaje.clase
  else Object.assign(montaje, { clase: papel, marcado_en: new Date().toISOString(), marcado_por: member_id })

  const metadata = { ...(asset.metadata || {}), montaje }
  const { error } = await db().from('forge_assets').update({ metadata }).eq('id', asset_id)
  if (error) throw error
  return { id: asset.id, nombre: asset.name, papel: papel || null }
}

/**
 * De los papeles marcados a la gramática que consume Maps_App.
 *
 * Trabaja sobre el kit YA armado y no sobre las filas de la base porque la clave de la gramática
 * es la del kit —«muro_piedra_01.glb»—, y esa clave la decide `kitDesdeMedidas`, que desempata
 * dos nombres que colapsan al mismo slug. Deducirla otra vez acá sería deducirla distinto.
 *
 * Un papel estructural nombra UNA pieza. Si dos modelos piden el mismo, gana el primero por
 * nombre —para que dos corridas den la misma gramática— y el otro se reporta: callarlo dejaría al
 * montaje eligiendo en silencio cuál de los dos muros es el exterior.
 */
function gramaticaDesdePapeles(assets, papelPorAssetId) {
  const estructura = {}
  const avisos = []
  const tomado = {}

  for (const clave of Object.keys(assets).sort()) {
    const entrada = assets[clave]
    const papel = papelPorAssetId[entrada.forge_asset_id] || null
    const def = papel ? PAPELES[papel] : null

    if (!def) { entrada.clase = 'sin_papel'; continue }
    if (def.clase) { entrada.clase = def.clase; continue }

    // Estructural: fuera del pool de props, o la misma pieza se coloca dos veces.
    entrada.clase = 'estructural'
    const ruta = def.donde.join('.')
    if (tomado[ruta]) {
      avisos.push(`“${entrada.forge_asset_nombre}” también pide ser ${def.etiqueta}; se usa “${tomado[ruta]}”.`)
      continue
    }
    tomado[ruta] = entrada.forge_asset_nombre

    if (papel === 'columna') {
      estructura.vertice = { ...(estructura.vertice || {}), columna_de_arte: { usar: true, asset: clave } }
    } else if (def.donde.length === 2) {
      const [seccion, sub] = def.donde
      estructura[seccion] = { ...(estructura[seccion] || {}), [sub]: { asset: clave } }
    } else {
      estructura[def.donde[0]] = { asset: clave }
    }
  }

  return { estructura, avisos }
}

/**
 * El mismo estado, preguntado desde la CADENA en vez de desde una pieza que nombra su entorno.
 *
 * Ofrece todos los niveles del `level_map` en vez de los de un entorno, y comparte con el
 * disparador las comprobaciones que no dependen del entorno.
 */
async function estadoDesdeLevelMap({ db, project_id }) {
  const faltantes = []
  const niveles = []

  const { data: ses } = await db().from('forge_sessions')
    .select('id').eq('project_id', project_id).eq('output_key', 'level_map')
  if ((ses || []).length) {
    const { data: docs } = await db().from('forge_assets')
      .select('content').in('session_id', ses.map(s => s.id)).not('content', 'is', null)
    const md = (docs || []).map(d => d.content).join('\n\n')
    // La tabla de niveles se reconoce por su columna `Environment`, igual que hace el disparador.
    // Leer cualquier fila con barras se tragaba las OTRAS tablas del documento: en el proyecto de
    // prueba salieron «Intent», «Teach», «Life range» y «1–4» ofrecidos como niveles.
    let colEntorno = -1
    for (const linea of md.split('\n')) {
      if (!linea.includes('|')) { colEntorno = -1; continue }
      const celdas = linea.split('|').map(c => c.trim())
      if (celdas[0] === '') celdas.shift()
      if (celdas[celdas.length - 1] === '') celdas.pop()
      if (!celdas.length) continue

      if (colEntorno < 0) {
        const i = celdas.findIndex(c => COL_ENTORNO.test(c))
        if (i > 0) colEntorno = i
        continue
      }
      if (/^[-: ]+$/.test(celdas[0])) continue
      const nivel = celdas[0], entorno = celdas[colEntorno] || ''
      if (!nivel || !entorno) continue
      if (!niveles.some(n => n.nivel === nivel)) niveles.push({ nivel, entorno })
    }
  }
  if (!niveles.length) {
    faltantes.push({ que: 'level_map', dice: 'Level Design (node 3.5) has not produced a level map with levels yet' })
  }

  const { modelos, faltantes: deKit } = await comprobarKit({ db, project_id })
  faltantes.push(...deKit)

  return {
    aplica: true, entorno: null, niveles, faltantes,
    listo: faltantes.length === 0,
    modelos, papeles: catalogoDePapeles(),
  }
}

/**
 * Lo que no depende del entorno: modelos medidos, papeles puestos y el generador configurado.
 *
 * Vive aparte porque lo preguntan los dos caminos —el sector del radial y el paso de la cadena— y
 * tenerlo dos veces era garantizar que un día dijeran cosas distintas.
 */
async function comprobarKit({ db, project_id }) {
  const faltantes = []
  const { data: todos } = await db().from('forge_assets')
    .select('id, name, metadata').eq('project_id', project_id).eq('format', 'glb')
    .not('storage_url', 'is', null)

  // Lo único que de verdad falta: no haber producido ningún modelo. El paquete lleva los `.glb`
  // tal cual salieron.
  //
  // Antes se exigían tres cosas más —modelos MEDIDOS, papeles puestos y el generador de mapas
  // configurado— porque Forge armaba el nivel. Con `forge_input_package/1.0` (JuanK, 16-09) ya
  // no lo arma: exporta, y el cálculo corre del lado de Claude+Blender. Exigirlas ahora sería
  // bloquear una exportación por cuentas que nadie va a hacer acá — de hecho el botón venía
  // contestando «The level generator is not configured on this server», que era exactamente eso.
  //
  // Los papeles siguen pudiéndose marcar y viajan en el manifiesto como bloque declarado: no
  // salen de la geometría y perderlos sería una regresión. Pero ya no bloquean.
  if (!(todos || []).length) {
    faltantes.push({ que: 'kit', dice: 'This project has no 3D models to export' })
  }

  return {
    faltantes,
    // De qué cadena salió cada modelo. Sin ese dato la ventana los ofrece todos por igual y en la
    // primera prueba una vista FRONTAL de personaje acabó marcada como muro exterior: un gato no
    // es una pared, pero la lista no daba forma de notarlo. Los del entorno van primero.
    // Se ofrecen TODOS, medidos o no: medir era para montar, y ya no se monta acá.
    modelos: (todos || [])
      .map(m => ({
        id: m.id, nombre: m.name,
        papel: m.metadata?.montaje?.clase || null,
        cadena: m.metadata?.cadena?.nombre || null,
      }))
      .sort((a, b) => peso(a.cadena) - peso(b.cadena) || a.nombre.localeCompare(b.nombre)),
  }
}

/** Qué cadena aporta piezas de nivel, y en qué orden se leen. */
const peso = cadena => (cadena === 'environment_sheet' ? 0 : cadena === 'prop_sheet' ? 1 : 2)

/**
 * El grafo del nivel: el que ya exista para ESE nivel, o uno nuevo.
 *
 * Se reusa a propósito. Generarlo otra vez cuesta una llamada al modelo —el que traduce el
 * documento de Level Design a parámetros— y devuelve OTRA planta, porque la semilla cambia: quien
 * solo quería rearmar el paquete se encontraría con un nivel distinto debajo.
 */
async function grafoDelNivel({ db, project_id, origen, nivel, member_id }) {
  const { data: previos } = await db().from('forge_assets')
    .select('id, name, storage_url, metadata')
    .eq('project_id', project_id).eq('format', 'json')
    .like('name', 'Mapa — % — level_graph')
    .order('created_at', { ascending: false })

  // Un arquetipo de edificio publica una planta por piso, y todas llevan el mismo nivel. Tomar la
  // más reciente dejaba el montaje en el piso 3 sin decirlo; se toma la PRIMERA, que es la planta
  // baja — por donde se entra.
  const delNivel = (previos || []).filter(g => String(g.metadata?.mapa?.nivel ?? '') === String(nivel))
  const mismo = delNivel.sort((a, b) => (a.metadata?.mapa?.piso ?? 1) - (b.metadata?.mapa?.piso ?? 1))[0]
  if (mismo?.storage_url) {
    const r = await fetch(mismo.storage_url)
    if (r.ok) return { level_graph: await r.json(), grafo: { id: mismo.id, generado: false } }
  }

  const { parametrosDesdeLevelDesign, generarYPublicar } = require('./mapas.service')
  const { data: n35 } = await db().from('forge_nodes').select('id').eq('node_key', '3.5').maybeSingle()
  const { data: docs } = await db().from('forge_assets').select('content')
    .eq('project_id', project_id).eq('node_id', n35?.id)
    .not('content', 'is', null).order('created_at', { ascending: false }).limit(1)
  const levelMap = docs?.[0]?.content
  if (!levelMap) {
    const e = new Error('Level Design (node 3.5) has not produced its level map yet')
    e.code = 'SIN_LEVEL_MAP'
    throw e
  }

  const { parametros } = await parametrosDesdeLevelDesign({ levelMap, nivel })
  const r = await generarYPublicar({
    db, project_id, origen_asset_id: origen.id, node_id: origen.node_id, parametros, member_id, nivel,
  })
  // Igual al reusar: de un edificio de tres plantas se monta la planta baja, no la última que se
  // publicó. Cuál se montó viaja en la respuesta, para que no haya que adivinarlo.
  const grafos = (r.creados || []).filter(a => /— level_graph$/.test(a.name))
  const creado = grafos.find(a => !/piso \d/.test(a.name) || /piso 1/.test(a.name)) || grafos[0]
  if (!creado?.storage_url) throw new Error('the map was generated but published no level graph')
  const resp = await fetch(creado.storage_url)
  if (!resp.ok) throw new Error(`could not read the level graph just published: HTTP ${resp.status}`)
  return { level_graph: await resp.json(), grafo: { id: creado.id, generado: true } }
}

/**
 * RETIRADO el 16-09. Nadie lo llama: ni la ruta, ni el paso de la cadena.
 *
 * Montaba el nivel —grafo desde Maps_App, kit medido, orden de colocación— y entregaba el bundle
 * `montaje/1.0`. El contrato `forge_input_package/1.0` de JuanK invirtió el reparto: **Forge
 * exporta, no calcula**, y el montaje corre del lado de Claude+Blender, que sí puede medir las
 * mallas. Lo que se entrega ahora lo arma `paquete-forge.service`.
 *
 * Se conserva sin borrar por una razón concreta: la única duda abierta con JuanK es si su proceso
 * deduce solo el papel estructural de cada modelo. Si la respuesta fuera que no alcanza y hubiera
 * que volver a montar acá, esto es lo que se volvería a encender. En cuanto conteste, se borra
 * —junto con `grafoDelNivel`, `bundle-montaje` y la llamada a Maps_App— o se reactiva.
 *
 * Nunca montaba «el primero»: si el entorno lo usan varios niveles devuelve la lista para que se
 * elija, que es el guarda que pide la spec —fallar señalando qué falta antes que generar con datos
 * parciales.
 */
/**
 * Los insumos que el `.zip` lleva además de los modelos (documento de JuanK, 18-09).
 *
 * Todos existen ya en el proyecto: esto los junta, no los produce. Y ninguno es obligatorio — un
 * paquete al que le falta la foto de una silla se arma igual, uno que no sale no sirve de nada.
 * Lo que falte se devuelve en `avisos` para que se diga en vez de desaparecer.
 */
async function reunirInsumos({ db, project_id, origen, inventarioUsado, modelosBin }) {
  const avisos = []
  const bajar = async (url, que) => {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    } catch (e) { avisos.push(`${que} (${e.message})`); return null }
  }

  // 1 · La documentación de level design. Sale del 3.11, que es quien la escribe.
  const documentos = []
  try {
    const { data: n } = await db().from('forge_nodes').select('id').eq('node_key', '3.11').maybeSingle()
    if (n) {
      const { data: docs } = await db().from('forge_assets')
        .select('name, content, output_key').eq('project_id', project_id).eq('node_id', n.id)
        .in('status', ['approved', 'auto_approved']).not('content', 'is', null)
      for (const d of docs || []) {
        documentos.push({ nombre: `${(d.output_key || d.name).replace(/[^\w.-]+/g, '_')}.md`, contenido: d.content })
      }
    }
    if (!documentos.length) avisos.push('la documentación de level design (el 3.11 no publicó ninguna)')
  } catch (e) { avisos.push(`la documentación de level design (${e.message})`) }

  // 2 · La lámina del Environment Sheet: es la hoja desde la que se disparó el montaje.
  let laminaSheet = null
  if (origen?.storage_url) {
    const buf = await bajar(origen.storage_url, 'la lámina del Environment Sheet')
    if (buf) laminaSheet = { nombre: `${String(origen.name || 'environment_sheet').split(/\s+[—–]\s+/).pop().replace(/[^\w.-]+/g, '_')}.png`, buffer: buf }
  }

  // 3 · Una imagen de diseño por asset: la pieza DE LA QUE SALIÓ cada modelo. El `.glb` cuelga de
  //     su concept art por `derived_from_id`, así que el vínculo ya está escrito y no hay que
  //     adivinarlo por el nombre.
  const imagenes = []
  const ids = inventarioUsado.map(i => i.asset_id)
  if (ids.length) {
    const { data: modelos } = await db().from('forge_assets')
      .select('id, derived_from_id').in('id', ids)
    const padres = [...new Set((modelos || []).map(m => m.derived_from_id).filter(Boolean))]
    const { data: fuentes } = padres.length
      ? await db().from('forge_assets').select('id, name, storage_url, format').in('id', padres)
      : { data: [] }
    const porId = new Map((fuentes || []).map(f => [f.id, f]))
    for (const m of modelos || []) {
      const f = porId.get(m.derived_from_id)
      if (!f?.storage_url || !['png', 'jpg', 'jpeg', 'image', 'webp'].includes(String(f.format))) continue
      const buf = await bajar(f.storage_url, `la imagen de «${f.name}»`)
      if (!buf) continue
      const ext = /\.(jpe?g|webp)(?:[?#]|$)/i.exec(f.storage_url) ? `.${RegExp.$1.toLowerCase()}` : '.png'
      imagenes.push({ asset_id: m.id, buffer: buf, ext })
      const mb = modelosBin.find(x => x.asset_id === m.id)
      if (mb) mb.imagen_ext = ext
    }
    if (!imagenes.length) avisos.push('las imágenes de diseño (ningún modelo cuelga de una lámina)')
  }

  return { documentos, laminaSheet, imagenes, avisos }
}

async function montarNivel({ db, project_id, asset_id, nivel = null, member_id = null, incluir_referencia = false, desdeCadena = false, estrategia = null }) {
  // Llamado desde la CADENA, el origen es la hoja del ASG —«Art Style Guide — 29_EnvironmentSheet»—
  // y esa no nombra su entorno: el nombre vive en la imagen de `world_visuals`. Hasta que el
  // instanciado dé una hoja por entorno, los niveles salen de la tabla entera del level_map y
  // elige una persona, que es mejor que montar el primero.
  const estado = desdeCadena
    ? await estadoDesdeLevelMap({ db, project_id })
    : await estadoDeMontaje({ db, project_id, asset_id })
  if (!estado.aplica) {
    const e = new Error('This piece does not trigger a level assembly')
    e.code = 'NO_APLICA'
    throw e
  }
  if (estado.faltantes.length) {
    const e = new Error(estado.faltantes.map(f => f.dice).join(' · '))
    e.code = 'FALTA'
    e.faltantes = estado.faltantes
    throw e
  }

  const elegido = nivel || (estado.niveles.length === 1 ? estado.niveles[0].nivel : null)
  if (!elegido) return { necesita_nivel: true, niveles: estado.niveles }
  if (!estado.niveles.some(n => String(n.nivel) === String(elegido))) {
    const e = new Error(`“${elegido}” is not one of the levels that use “${estado.entorno}”`)
    e.code = 'NIVEL_AJENO'
    throw e
  }

  const { data: origen } = await db().from('forge_assets')
    .select('id, node_id, name').eq('id', asset_id).eq('project_id', project_id).single()

  const { level_graph, grafo } = await grafoDelNivel({ db, project_id, origen, nivel: elegido, member_id })

  // El kit: lo que Forge ya midió de cada modelo, en la convención que consume el montaje.
  const { data: modelos } = await db().from('forge_assets')
    .select('id, name, storage_url, metadata, format')
    .eq('project_id', project_id).eq('format', 'glb').not('storage_url', 'is', null)
  const medidos = (modelos || []).filter(m => m.metadata?.medidas?.dim)

  const bm = require('./bundle-montaje.service')
  const { assets, inventario } = bm.kitDesdeMedidas(medidos, null)
  const papeles = Object.fromEntries(medidos.map(m => [m.id, m.metadata?.montaje?.clase || null]))
  const { estructura, avisos } = gramaticaDesdePapeles(assets, papeles)

  if (!estructura.arista_exterior) {
    const e = new Error('No model is marked as the exterior wall, and every wall of the level is built from that one')
    e.code = 'SIN_MURO_EXTERIOR'
    throw e
  }

  // Lo que no tiene papel no viaja. Sin esto el `.zip` carga los modelos de todo el proyecto —cada
  // uno son megas— para que el montaje no los coloque en ningún sitio.
  for (const [clave, entrada] of Object.entries(assets)) {
    if (entrada.clase === 'sin_papel') delete assets[clave]
  }
  const inventarioUsado = inventario.filter(i => assets[`${i.asset_id}.glb`])

  const { ordenDeMontaje, ALTURA_POR_DEFECTO } = require('./mapas.service')
  // `freeform` y no `modular_hex`. La retícula modular embebe el grafo en celdas de seis vecinos y
  // falla en cuanto una sala tiene más conexiones que eso: medido el 15-09 con un edificio de tres
  // plantas, Maps_App devolvió «no se pudo embeber el grafo en la reticula». Lo que genera Maps_App
  // es una PLANTA REAL, y para eso su propia estrategia libre construye cada sala sobre su
  // polígono, sin retícula. La modular es para niveles hechos de módulos, que no es este caso.
  const orden = await ordenDeMontaje({
    level_graph, kit_catalog: { assets }, grammar: { estructura },
    strategy: estrategia || 'freeform',
  })

  const modelosBin = await bm.traerModelos(inventarioUsado)

  // ── Lo que pide el documento de JuanK del 18-09 ───────────────────────────
  // Documentación del nivel, la lámina del Environment Sheet, una imagen por asset y las medidas
  // del GDD. Todo existe ya dentro de Forge: exportar es juntarlo, no producirlo.
  //
  // Nada de esto puede tumbar el paquete: si una imagen no se deja bajar, el `.zip` sale sin ella
  // y se dice. Un montaje sin la foto de una silla se arma; un montaje que no sale no sirve.
  const extras = await reunirInsumos({ db, project_id, origen, inventarioUsado, modelosBin })

  const { medidasDelGDD } = require('./medidas-gdd.service')
  let medidas = null
  try { medidas = await medidasDelGDD({ db, project_id }) } catch (e) {
    console.warn('[montaje] no se pudieron leer las medidas del GDD:', e.message)
  }
  // La altura del personaje, si el GDD la declara. Es la que manda para la escala, y hasta hoy
  // siempre viajaba el valor por defecto con la nota «el 3.6 no publica una medida real» — que ya
  // no es cierto: medido el 18-09, los GDD sí traen dimensiones con su cita.
  const alturaGDD = medidas?.medidas?.altura_personaje?.valor_m
    || medidas?.medidas?.altura_camara_personaje?.valor_m
    || null

  const manifiesto = bm.manifiesto({
    level_id: level_graph.level_id || String(elegido),
    modelos: modelosBin,
    alturaJugador: alturaGDD || ALTURA_POR_DEFECTO,
    fuenteAltura: alturaGDD
      ? (medidas.medidas.altura_personaje?.fuente || medidas.medidas.altura_camara_personaje?.fuente)
      : 'valor por defecto — el GDD de este proyecto no declara la altura del personaje',
    escalaSpec: null,
  })
  const zip = await bm.armarZip({
    bundle: manifiesto, orden: orden.order, kit: { assets },
    validacion: orden.validation || {}, modelos: modelosBin,
    shell: incluir_referencia ? orden.shell : null,
    documentos: extras.documentos,
    laminaSheet: extras.laminaSheet,
    imagenes: extras.imagenes,
    medidas: medidas ? { medidas: medidas.medidas, de_respaldo: medidas.de_respaldo, fuente: medidas.fuente } : null,
  })
  if (extras.avisos.length) console.warn(`[montaje] el paquete sale sin: ${extras.avisos.join(' · ')}`)

  const { uploadToStorage } = require('./storage.service')
  const url = await uploadToStorage(zip, `projects/${project_id}/bundles/${manifiesto.bundle_id}.zip`, 'application/zip')

  // Queda como pieza del proyecto, colgada de la hoja de entorno: el paquete es el resultado de
  // este tramo y buscarlo en un enlace que alguien copió es perderlo.
  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id: origen.node_id, output_key: null, status: 'auto_approved',
    iteration_count: 1, started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id,
  }).select('id').single()

  const { data: pieza } = await db().from('forge_assets').insert({
    project_id, node_id: origen.node_id, session_id: ses?.id || null,
    name: `Level assembly — ${elegido}`,
    format: 'zip', mime_type: 'application/zip', storage_url: url,
    status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
    derived_from_id: origen.id,
    metadata: {
      montaje: {
        nivel: elegido, entorno: estado.entorno, bundle_id: manifiesto.bundle_id,
        contrato: manifiesto.contrato || 'montaje/1.0', level_graph_asset_id: grafo.id,
        piezas: Object.keys(assets).length,
      },
      resumen: orden.resumen || null,
    },
  }).select('id, name, storage_url').single()

  return {
    url, bundle_id: manifiesto.bundle_id, bytes: zip.length,
    nivel: elegido, entorno: estado.entorno, grafo, asset: pieza || null,
    resumen: orden.resumen || null,
    avisos: [...avisos, ...(orden.warnings || [])],
  }
}

module.exports = {
  estadoDeMontaje, estadoDesdeLevelMap, comprobarKit, entornoDe, nivelesDelEntorno, PREFIJO_ENTORNO,
  PAPELES, catalogoDePapeles, marcarPapel, gramaticaDesdePapeles,
  grafoDelNivel, montarNivel,
}
