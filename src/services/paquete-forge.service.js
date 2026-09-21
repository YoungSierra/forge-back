// ─── El paquete que Forge le entrega a Claude+Blender ────────────────────────
//
// Contrato `forge_input_package/1.0` (FORGE_INPUT_PACKAGE_v1.md, 16-09). Reemplaza a `montaje/1.0`
// en este tramo, y el cambio es de fondo: **Forge exporta, no calcula**.
//
// Lo que sale de acá es una carpeta autocontenida con lo que Forge YA tiene generado y aprobado —
// documentos, imágenes, los `.glb`— y el fragmento del level_map con el que el usuario corre su
// Maps_App LOCAL. Lo que NO sale, por prohibición expresa del §4 del contrato:
//
//   orden_de_montaje.json   lo calcula el ensamble del lado de Claude
//   kit.json medido         lo genera Blender leyendo los `.glb` del paquete
//   validacion.json         corre sobre el montaje ya armado, no antes
//   nada de Maps_App        es una herramienta local del usuario; Forge no la hospeda ni la invoca
//
// «Si alguno de estos archivos aparece dentro de un paquete real, es una señal de que algo está
// calculando del lado de Forge otra vez.» Por eso este servicio no importa ni `bundle-montaje` ni
// `mapas.service`: no es que no los llame, es que no los tiene a mano.
//
// La otra regla que manda sobre todo lo demás: **lo que entra, entra completo o no entra**. Un
// documento que no cubre este entorno se declara `disponible: false` con su motivo. Nunca se
// rellena con un valor inventado y nunca se omite en silencio — que es exactamente el fallo que
// este contrato existe para prevenir.

const crypto = require('crypto')
const archiver = require('archiver')
const { entornoDe, nivelesDelEntorno } = require('./montaje-nivel.service')

const CONTRATO = 'forge_input_package/1.0'

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** El id de nivel tal como viaja en las rutas: sin espacios ni acentos, y estable.
 *
 *  En este level_map los niveles se llaman «1», «2», «3». Un paquete llamado `1__forge_package` no
 *  dice nada y encima choca con el de otro proyecto en la carpeta de descargas, así que un nombre
 *  que es solo un número se prefija. */
const idDeNivel = n => {
  const limpio = String(n || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\*+/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
  if (!limpio) return 'nivel'
  return /^\d+$/.test(limpio) ? `lvl_${limpio.padStart(2, '0')}` : limpio
}

/**
 * Los términos con los que se recorta un documento para este nivel.
 *
 * La celda de entorno del level_map viene como «Ground Floor (Entrance Hall, Parlour, Dining
 * Room)»: buscar esa cadena entera no encuentra nada, porque ningún documento la escribe así. Se
 * parte en sus nombres —el del entorno y el de cada espacio— y cada uno busca por su lado. Un
 * término de menos de cuatro letras se descarta después: «1» casa con todo.
 */
function terminosDeBusqueda(nivel, entorno) {
  const partes = []
  for (const t of [nivel, entorno]) {
    if (!t) continue
    for (const p of String(t).split(/[(),/+]|\s+y\s+|\s+and\s+/)) {
      const limpio = p.replace(/\*+/g, '').trim()
      if (limpio && !partes.includes(limpio)) partes.push(limpio)
    }
  }
  return partes
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

// ── Recortes de documento ────────────────────────────────────────────────────
//
// Un excerpt es un RECORTE, no un resumen: se copian los tramos que nombran este nivel o este
// entorno, tal cual están, con su encabezado. Resumir sería calcular, y además pondría a un
// modelo a decidir qué medida importa — que es justo lo que el contrato saca de nuestro lado.

/** Los tramos de un markdown cuyo encabezado o cuerpo nombra alguno de los términos. */
function tramosQueNombran(md, terminos) {
  const texto = String(md || '')
  if (!texto.trim()) return []
  const buscados = terminos.map(norm).filter(t => t.length >= 4)
  if (!buscados.length) return []

  // Se parte por encabezado de cualquier nivel: el tramo es el encabezado y todo lo que cuelga
  // hasta el siguiente del MISMO nivel o uno mayor.
  const lineas = texto.split('\n')
  const cortes = []
  lineas.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l)
    if (m) cortes.push({ i, nivel: m[1].length, titulo: m[2].trim() })
  })
  if (!cortes.length) return []

  const tramos = []
  for (let k = 0; k < cortes.length; k++) {
    const desde = cortes[k]
    let hasta = lineas.length
    for (let j = k + 1; j < cortes.length; j++) {
      if (cortes[j].nivel <= desde.nivel) { hasta = cortes[j].i; break }
    }
    const cuerpo = lineas.slice(desde.i, hasta).join('\n')
    const enTexto = norm(cuerpo)
    if (buscados.some(t => enTexto.includes(t))) tramos.push({ titulo: desde.titulo, cuerpo })
  }
  return tramos
}

/**
 * Un excerpt en el formato que el paquete espera, o la ausencia declarada.
 *
 * `motivo` cuenta por qué no hay nada, porque «no disponible» sin razón manda a alguien a buscar
 * en el sitio equivocado — es lo que pasó con el Vertical Slice Specification.
 */
function excerptDe({ md, terminos, documento }) {
  if (!String(md || '').trim()) {
    return { disponible: false, motivo: `${documento} has no text in this project`, texto: null }
  }
  const tramos = tramosQueNombran(md, terminos)
  if (!tramos.length) {
    return {
      disponible: false,
      motivo: `${documento} does not cover “${terminos.filter(Boolean).join('” / “')}”`,
      texto: null,
    }
  }
  const cabecera = [
    `# Excerpt of ${documento}`,
    '',
    `Copied verbatim from the Forge document. Only the sections naming ${terminos.filter(Boolean).map(t => `“${t}”`).join(' or ')}.`,
    `Sections: ${tramos.length}.`,
    '',
    '---',
    '',
  ].join('\n')
  return { disponible: true, motivo: null, texto: cabecera + tramos.map(t => t.cuerpo).join('\n\n---\n\n') + '\n' }
}

/**
 * Todos los niveles declarados en la tabla del level_map.
 *
 * La tabla se reconoce por su columna `Environment`, igual que en el montaje. Leer cualquier
 * fila con barras se tragaba las otras tablas del documento y ofrecía «Intent» o «1–4» como si
 * fueran niveles — pasó, y son 22 filas de basura contra 13 niveles de verdad.
 */
function nivelesDeLaTabla(md) {
  const niveles = []
  let colEntorno = -1
  for (const linea of String(md || '').split('\n')) {
    if (!linea.includes('|')) { colEntorno = -1; continue }
    const celdas = linea.split('|').map(c => c.trim())
    if (celdas[0] === '') celdas.shift()
    if (celdas[celdas.length - 1] === '') celdas.pop()
    if (!celdas.length) continue
    if (colEntorno < 0) {
      // El encabezado se compara ENTERO. Con un `includes` entraban las otras tablas del documento
      // y ofrecían «**Test**», «5–9» o «Reveal» como si fueran niveles: 18 filas contra 13 niveles
      // de verdad. Es la misma comprobación que hace el montaje, y por el mismo susto.
      const i = celdas.findIndex(c => /^\s*environments?\s*$/i.test(c))
      if (i > 0) colEntorno = i
      continue
    }
    if (/^[-: ]+$/.test(celdas[0])) continue
    const nivel = celdas[0], entorno = celdas[colEntorno] || ''
    if (!nivel || !entorno) continue
    if (!niveles.some(n => n.nivel === nivel)) niveles.push({ nivel, entorno })
  }
  return niveles
}

/** Las filas del level_map que hablan de este nivel, con la tabla que las encabeza. */
function recorteDelLevelMap(md, nivel, entorno) {
  const lineas = String(md || '').split('\n')
  const filas = []
  let encabezado = null, separador = null

  for (const linea of lineas) {
    if (!linea.includes('|')) continue
    const celdas = linea.split('|').map(c => c.trim())
    if (celdas[0] === '') celdas.shift()
    if (celdas[celdas.length - 1] === '') celdas.pop()
    if (!celdas.length) continue
    if (/^[-: ]+$/.test(celdas[0])) { separador = linea; continue }
    if (!encabezado && celdas.some(c => /^\s*environments?\s*$/i.test(c))) { encabezado = { linea, celdas }; continue }
    if (!encabezado) continue
    if (norm(celdas[0]) === norm(nivel)) {
      filas.push(Object.fromEntries(encabezado.celdas.map((c, i) => [c || `col_${i}`, celdas[i] ?? null])))
    }
  }

  return {
    nivel,
    entorno,
    columnas: encabezado ? encabezado.celdas : [],
    filas,
    // La prosa del nivel viaja aparte, en el LDD. Acá va la relación declarada, que es lo que
    // Maps_App necesita para correr.
    _nota: 'Rows copied from the summary table of the Level Design level map. Run your local Maps_App with this.',
    _separador_original: separador ? true : false,
  }
}

/**
 * Los nombres de página del ASG con los que una hoja tiene que cumplir.
 *
 * Se saca invirtiendo la matriz del sistema de actualización: si tocar `08_ColorSystem` marca la
 * Environment Sheet, es porque la Environment Sheet depende de ella. Es el mismo dato, leído al
 * revés, y por eso no hay una segunda lista que mantener.
 */
function aliasQueAlimentan(hojas) {
  const { MATRIZ, PAGINAS } = require('./actualizacion.service')
  const fuentes = new Set()
  for (const [clave, fila] of Object.entries(MATRIZ)) {
    const destinos = [...(fila.destinos || []), ...(fila.condicional || [])]
    if (destinos.some(d => hojas.includes(d.pagina))) fuentes.add(clave)
  }
  for (const h of hojas) fuentes.add(h)   // la propia hoja también se manda
  const alias = []
  for (const f of fuentes) for (const a of (PAGINAS[f]?.alias || [])) alias.push(a)
  return alias
}

// ── El paquete ───────────────────────────────────────────────────────────────

/** Baja un archivo de R2 y devuelve su buffer con su huella. */
async function bajar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`could not download (${r.status})`)
  const buf = Buffer.from(await r.arrayBuffer())
  return { buffer: buf, bytes: buf.length, sha256: sha256(buf) }
}

/** Nombre de archivo seguro y legible a partir del nombre de una pieza. */
const archivoDe = (nombre, ext) => String(nombre || 'pieza')
  .split(/\s+[—–]\s+/).slice(-2).join('_')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  .slice(0, 70) + ext

/**
 * Arma el paquete de un nivel y lo deja como pieza del proyecto.
 *
 * Devuelve `necesita_nivel` —igual que el montaje— cuando el entorno lo usan varios niveles: es el
 * mismo gesto que ya conoce la interfaz, y elegir por ella sería inventar.
 */
async function armarPaquete({ db, project_id, asset_id, nivel = null, member_id = null }) {
  const { data: origen } = await db().from('forge_assets')
    .select('id, name, node_id, format, storage_url, output_key')
    .eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!origen) throw new Error('Asset not found')

  // El entorno CON NOMBRE solo existe si el nodo 3.4 produjo sus `world_visuals` («World Design —
  // <entorno>»). Medido el 16-09: los dos proyectos vivos no los tienen, y por eso el montaje ya
  // tenía un segundo camino — el del level_map, que ofrece todos los niveles y deja elegir.
  //
  // Se usan los dos aquí por la misma razón: exigir el entorno nombrado dejaría el exportador sin
  // poder correr en ningún proyecto real, y elegir un entorno «parecido» sería inventarlo.
  const entorno = entornoDe(origen)

  // Todo el proyecto de una vez: el paquete toca ocho carpetas y consultarlas por separado son
  // ocho viajes a la base para armar un archivo que ya tarda por las descargas.
  const { data: piezas } = await db().from('forge_assets')
    .select('id, name, format, output_key, storage_url, content, metadata, created_at, forge_sessions!session_id(output_key)')
    .eq('project_id', project_id)
  const todas = piezas || []

  // La clave de salida vive en DOS sitios: en la pieza (desde la migración 054) y en su sesión
  // (las filas anteriores). Mirar solo la de la pieza dejaba al exportador ciego ante proyectos
  // enteros: medido el 21-09 en test_smack_migue_v.09, siete claves —level_map, encounter_design,
  // gdd_complete, gdd_ref, visual_targets, scene_manifest, asset_briefs— estaban declaradas en la
  // sesión y ninguna en la pieza.
  //
  // Eso es lo que JuanK reportó como «Level Design has not produced its level map yet»: el mapa
  // existe, son 17.173 caracteres aprobados, y el exportador no lo veía. No era un prerrequisito
  // que faltara, era una lectura que miraba un solo sitio. El resolvedor de entradas de un nodo
  // ya consultaba los dos desde hace tiempo; acá no se había aplicado.
  const claveDe = a => a?.output_key ?? a?.forge_sessions?.output_key ?? null
  const texto = clave => (todas.find(a => claveDe(a) === clave && a.content)?.content) || ''

  // 1 · El nivel. Sale de la tabla del level_map, que es quien declara qué nivel usa qué entorno.
  const levelMap = texto('level_map')
  if (!levelMap) {
    const e = new Error('Level Design has not produced its level map yet')
    e.code = 'SIN_NIVEL'
    throw e
  }
  const niveles = entorno ? nivelesDelEntorno(levelMap, entorno) : nivelesDeLaTabla(levelMap)
  if (!niveles.length) {
    const e = new Error(entorno
      ? `No level in the level map uses “${entorno}”`
      : 'The level map has no level table yet')
    e.code = 'SIN_NIVEL'
    throw e
  }
  const elegido = nivel || (niveles.length === 1 ? niveles[0].nivel : null)
  if (!elegido) return { necesita_nivel: true, entorno, niveles }

  // Sin entorno nombrado, el de este nivel es el que declara su propia fila.
  const entornoDelNivel = entorno || niveles.find(n => n.nivel === elegido)?.entorno || null
  const level_id = idDeNivel(elegido)
  const terminos = terminosDeBusqueda(elegido, entornoDelNivel)
  const ausentes = []
  // Lo que está pero conviene mirar. Distinto de una ausencia: acá hay dato, y es dudoso.
  const avisos = []

  // 2 · Level design.
  const ldd = excerptDe({ md: texto('level_design_doc'), terminos, documento: 'Level Design Document' })
  if (!ldd.disponible) ausentes.push(`LDD: ${ldd.motivo}`)
  const mapExcerpt = recorteDelLevelMap(levelMap, elegido, entornoDelNivel)

  // 3 · Referencia visual. Por carpeta, y cada una con su regla declarada.
  const esImagen = a => /^(png|jpg|jpeg|image)$/i.test(a.format || '') && a.storage_url
  const nombra = (a, t) => norm(a.name).includes(norm(t))

  // Qué páginas del Art Style Guide van. El contrato pide «las páginas CITADAS (composición,
  // distribución)», no el deck entero: con las 45 el paquete pesaba 139 MB, que nadie sube a
  // una conversación.
  //
  // Cuáles son no se decide acá: ya está declarado en la matriz de actualización — las páginas
  // de lenguaje que disparan la Environment Sheet son exactamente aquellas con las que la hoja
  // tiene que cumplir. Se lee de ahí para que no haya dos listas que un día digan cosas
  // distintas.
  const paginasCitadas = aliasQueAlimentan(['environment_sheet', 'prop_sheet'])

  const carpetas = {
    // Las del entorno nombrado primero; si no hay nombre —el caso real hoy, sin `world_visuals`—
    // van todas las páginas de Environment Sheet. Elegir un subconjunto «parecido» sería adivinar
    // cuál retrata este nivel, y el contrato prohíbe exactamente eso.
    'environment_sheet': todas.filter(a => esImagen(a) && (
      claveDe(a) === 'world_visuals'
        || (entorno ? nombra(a, entorno) : false)
        || /environmentsheet/i.test(norm(a.name)))),
    'character_sheet': todas.filter(a => esImagen(a) &&
      (claveDe(a) === 'visual_targets' || /charactersheet/i.test(norm(a.name)))),
    'art_bible_level_design': todas.filter(a => esImagen(a) &&
      /artbible/i.test(norm(a.name)) && /leveldesign/i.test(norm(a.name))),
    'art_style_guide': todas.filter(a => esImagen(a) && /artstyleguide/i.test(norm(a.name))
      && paginasCitadas.some(alias => nombra(a, alias))),
  }

  // Una sola versión de cada página. Una hoja iterada tres veces deja tres imágenes con el mismo
  // nombre, y las tres entraban al paquete: mandar la 08_ColorSystem de anteayer junto a la de hoy
  // no es dar más contexto, es pedirle a quien lee que adivine cuál manda.
  for (const [k, lista] of Object.entries(carpetas)) {
    const porNombre = new Map()
    for (const a of [...lista].sort((x, y) => new Date(y.created_at) - new Date(x.created_at))) {
      if (!porNombre.has(a.name)) porNombre.set(a.name, a)
    }
    carpetas[k] = [...porNombre.values()]
  }
  // `world_visuals` es su propia fuente y su ausencia importa: el contrato la nombra explícitamente
  // como parte de environment_sheet.
  if (!todas.some(a => claveDe(a) === 'world_visuals')) {
    ausentes.push('world_visuals: no node produced them in this project')
  }
  if (!carpetas.art_bible_level_design.length) {
    ausentes.push('art_bible_level_design: the Art Bible has no rendered Level Design page in this project')
  }

  // 4 · Documentos de medida.
  const tdd = excerptDe({ md: texto('tdd_complete'), terminos, documento: 'Technical Design Document' })
  if (!tdd.disponible) ausentes.push(`TDD: ${tdd.motivo}`)
  const gddAssembly = excerptDe({
    md: todas.filter(a => /gdd/i.test(a.name) && a.content).map(a => a.content).join('\n\n'),
    terminos, documento: 'GDD — Assembly',
  })
  if (!gddAssembly.disponible) ausentes.push(`GDD Assembly: ${gddAssembly.motivo}`)

  // 5 · Los modelos. TODOS los del proyecto, igual que el montaje: un prop pertenece a su entorno
  // por decisión de arte, no por su nombre, y dejar uno fuera es peor que mandar uno de más.
  const modelos = todas.filter(a => /^(glb|model_3d)$/i.test(a.format || '') && a.storage_url)
  const inventario = []
  const binarios = []
  const fallos = []
  for (const m of modelos) {
    try {
      const b = await bajar(m.storage_url)
      const archivo = `modelos/${archivoDe(m.name, '.glb')}`
      inventario.push({ asset_id: archivoDe(m.name, ''), archivo, sha256: b.sha256, bytes: b.bytes })
      binarios.push({ archivo, buffer: b.buffer })
    } catch (e) { fallos.push(`${m.name}: ${e.message}`) }
  }
  if (!inventario.length) ausentes.push('modelos: this project has no downloadable .glb yet')
  for (const f of fallos) ausentes.push(`modelo no incluido — ${f}`)

  // 6 · meta. La altura del jugador se declara SIEMPRE, con su fuente: la consumen tanto Maps_App
  // como el protocolo de anclaje, y un default silencioso es una medida inventada con otro nombre.
  const perfiles = texto('char_profiles')
  const alto = /(?:height|altura)\D{0,20}?(\d(?:[.,]\d+)?)\s*m\b/i.exec(perfiles)
  const meta = {
    level_id,
    nivel: elegido,
    entorno: entornoDelNivel,
    player_height_m: alto ? Number(String(alto[1]).replace(',', '.')) : 1.8,
    player_height_fuente: alto ? 'char_profiles' : 'default',
    generation_mode: null,
  }

  // Los papeles estructurales. NO es un cálculo: es una decisión de arte que una persona marcó en
  // Forge, y nada en la geometría la puede reponer —ningún bbox dice cuál muro es el exterior—.
  // El contrato no los pide; JuanK los pidió el 16-09 («si está con la definición para marcar
  // mucho mejor»), así que van, como bloque declarado fuera de `contenido`.
  //
  // Con su VOCABULARIO al lado. Mandar `muro_exterior` a secas obliga a adivinar qué significa y
  // qué otros valores existen; el catálogo es el mismo que dibuja la pantalla de marcar, leído de
  // una sola fuente para que no haya dos listas.
  //
  // Y con la CADENA de la que salió cada modelo, que es el dato que deja ver un marcado erróneo:
  // en este proyecto hay una vista frontal de personaje marcada como «piso», y sin saber que viene
  // de `character_sheet` no hay forma de notarlo del otro lado.
  const { catalogoDePapeles } = require('./montaje-nivel.service')
  const conPapel = modelos.filter(m => m.metadata?.montaje?.clase)
  const catalogo = catalogoDePapeles()
  const porClave = new Map(catalogo.map(p => [p.clave, p]))
  const papeles = {
    catalogo,
    modelos: conPapel.map(m => ({
      asset_id: archivoDe(m.name, ''),
      archivo: `modelos/${archivoDe(m.name, '.glb')}`,
      papel: m.metadata.montaje.clase,
      etiqueta: porClave.get(m.metadata.montaje.clase)?.etiqueta || null,
      estructural: Boolean(porClave.get(m.metadata.montaje.clase)?.estructural),
      cadena: m.metadata?.cadena?.nombre || null,
    })),
  }
  const sinPapel = modelos.length - conPapel.length
  if (sinPapel) {
    ausentes.push(`papeles: ${sinPapel} of ${modelos.length} models have no structural role marked in Forge`)
  }

  // Un papel ESTRUCTURAL sobre un modelo que no salió del entorno casi siempre es un error de
  // marcado: en este proyecto una vista frontal de personaje está marcada como «piso». La lista de
  // la pantalla los ofrece a todos por igual y un gato no se distingue de una losa en una fila de
  // texto. No se corrige acá —marcar es una decisión de arte, y adivinar la intención sería peor—,
  // se señala: quien exporta lo ve antes de mandarlo, y quien lo recibe lo ve en el manifiesto.
  const sospechosos = papeles.modelos.filter(m => m.estructural && m.cadena && m.cadena !== 'environment_sheet')
  for (const m of sospechosos) {
    avisos.push(`${m.asset_id}: marked as “${m.etiqueta}” but it comes from the ${m.cadena.replace(/_/g, ' ')} chain — check the role`)
  }

  const package_id = `${level_id}__${new Date().toISOString().replace(/[:.]/g, '-')}`
  const manifest = {
    contrato: CONTRATO,
    package_id,
    level_id,
    generado_por: 'Forge — exportador de paquete',
    generado_en: new Date().toISOString(),
    nodos_de_origen: {
      level_design: 'Level Design',
      world_design: 'World Design',
      art_direction: 'Art Direction Document',
      art_style_guide: 'Art Style Guide',
      _nota: 'Citados por título, nunca por número — FORGE_PROCESS.md §1.',
    },
    contenido: {
      level_design: {
        ldd: ldd.disponible ? `level_design/LDD_${level_id}.md` : { disponible: false, motivo: ldd.motivo },
        level_map_excerpt: 'level_design/level_map_excerpt.json',
      },
      maps_app_local: {
        _nota: 'Maps_App NO es parte de este paquete — corre localmente, del lado del usuario, alimentada por level_design/level_map_excerpt.json. Forge no la hospeda ni la invoca.',
      },
      // Declarado, porque no son los originales: ver el comentario del zip.
      _resolucion_referencia: '600 px de ancho; el original queda en Forge',
      referencia_visual: Object.fromEntries(Object.entries(carpetas).map(([k, l]) => [
        k, l.length ? l.map(a => `referencia_visual/${k}/${archivoDe(a.name, '.png')}`)
                    : { disponible: false, motivo: `no images of this kind in this project` },
      ])),
      documentos_de_medida: {
        tdd: tdd.disponible ? 'documentos_de_medida/tdd_excerpt.md' : { disponible: false, motivo: tdd.motivo },
        gdd_assembly: gddAssembly.disponible
          ? 'documentos_de_medida/gdd_assembly_excerpt.md'
          : { disponible: false, motivo: gddAssembly.motivo },
      },
      modelos: { carpeta: 'modelos', formato: 'glb', inventario },
    },
    meta,
    // Ver el comentario de arriba. Fuera de `contenido` para que se lea como lo que es: un extra
    // declarado, no una pieza del contrato.
    papeles_declarados: papeles.modelos.length
      ? papeles
      : { disponible: false, motivo: 'no model has been given its structural role in Forge yet', catalogo: papeles.catalogo },
    // Lo que está y conviene revisar antes de usarlo.
    avisos,
    // Todo lo que falta, junto y en un solo sitio. El contrato exige declararlo; tenerlo también
    // aquí evita abrir ocho nodos del manifiesto para saber qué le falta al paquete.
    ausencias: ausentes,
  }

  // ── El zip ─────────────────────────────────────────────────────────────────
  const zip = archiver('zip', { zlib: { level: 9 } })
  const trozos = []
  zip.on('data', t => trozos.push(t))
  const listo = new Promise((res, rej) => { zip.on('end', res); zip.on('error', rej) })
  const raiz = `${level_id}__forge_package`

  zip.append(JSON.stringify(manifest, null, 2), { name: `${raiz}/manifest.json` })
  zip.append(JSON.stringify(mapExcerpt, null, 2), { name: `${raiz}/level_design/level_map_excerpt.json` })
  if (ldd.disponible) zip.append(ldd.texto, { name: `${raiz}/level_design/LDD_${level_id}.md` })
  if (tdd.disponible) zip.append(tdd.texto, { name: `${raiz}/documentos_de_medida/tdd_excerpt.md` })
  if (gddAssembly.disponible) zip.append(gddAssembly.texto, { name: `${raiz}/documentos_de_medida/gdd_assembly_excerpt.md` })
  zip.append(JSON.stringify(meta, null, 2), { name: `${raiz}/meta.json` })

  let imagenes = 0
  // Las imágenes van REDUCIDAS a 600 px de ancho, y está declarado en el manifiesto.
  //
  // Son referencia: se miran para reconocer el sitio y el estilo, no para producir con ellas. A
  // tamaño original el paquete de este proyecto pesaba 99 MB y no entra en una conversación, que
  // es justo el transporte que el contrato define («se sube directo a la conversación con
  // Claude»). El original no se pierde: vive en Forge y el manifiesto dice de qué pieza salió.
  //
  // Los `.glb` NO se tocan: de esos se leen medidas.
  const { miniaturaDe } = require('./miniatura.service')
  for (const [carpeta, lista] of Object.entries(carpetas)) {
    for (const a of lista) {
      try {
        let url = a.storage_url
        try { url = await miniaturaDe(a.storage_url, 600) } catch { /* se manda el original */ }
        const b = await bajar(url)
        zip.append(b.buffer, { name: `${raiz}/referencia_visual/${carpeta}/${archivoDe(a.name, '.png')}` })
        imagenes++
      } catch (e) { manifest.ausencias.push(`imagen no incluida — ${a.name}: ${e.message}`) }
    }
  }
  for (const m of binarios) zip.append(m.buffer, { name: `${raiz}/${m.archivo}` })

  zip.finalize()
  await listo
  const buffer = Buffer.concat(trozos)

  // ── Queda como pieza del proyecto ──────────────────────────────────────────
  const { uploadToStorage } = require('./storage.service')
  const url = await uploadToStorage(buffer, `projects/${project_id}/paquetes/${package_id}.zip`, 'application/zip')

  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id: origen.node_id, output_key: null, status: 'auto_approved',
    iteration_count: 1, started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id,
  }).select('id').single()

  const { data: pieza } = await db().from('forge_assets').insert({
    project_id, node_id: origen.node_id, session_id: ses?.id || null,
    name: `Forge package — ${elegido}`,
    format: 'zip', mime_type: 'application/zip', storage_url: url,
    status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
    derived_from_id: origen.id,
    metadata: {
      paquete: {
        contrato: CONTRATO, package_id, level_id, nivel: elegido, entorno: entornoDelNivel,
        modelos: inventario.length, imagenes, ausencias: manifest.ausencias.length,
      },
    },
  }).select('id, name, storage_url').single()

  return {
    url, package_id, level_id, nivel: elegido, entorno: entornoDelNivel,
    bytes: buffer.length, modelos: inventario.length, imagenes,
    ausencias: manifest.ausencias,
    avisos,
    asset: pieza || null,
  }
}

module.exports = { armarPaquete, excerptDe, tramosQueNombran, recorteDelLevelMap, idDeNivel, CONTRATO }
