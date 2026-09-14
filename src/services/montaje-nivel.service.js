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
    .select('id, name, format, storage_url, session_id')
    .eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!asset) return { aplica: false, motivo: 'Asset not found' }

  const entorno = entornoDe(asset)
  if (!entorno) return { aplica: false }

  // El nombre ya dijo que es una hoja de entorno; la clave de salida lo confirma contra el nodo
  // que la emitió. No al revés: 168 de 468 imágenes se generaron en modo nodo entero y no tienen
  // clave, así que exigirla sola dejaría fuera piezas legítimas.
  const { data: ses } = asset.session_id
    ? await db().from('forge_sessions').select('output_key').eq('id', asset.session_id).maybeSingle()
    : { data: null }
  if (ses?.output_key && ses.output_key !== 'world_visuals') return { aplica: false }

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

  // 2 · El kit: modelos con su caja ya leída. Sin eso no hay nada que colocar.
  const { data: modelos } = await db().from('forge_assets')
    .select('id, name, metadata').eq('project_id', project_id).eq('format', 'glb')
    .not('storage_url', 'is', null)
  const medidos = (modelos || []).filter(m => m.metadata?.medidas?.dim)
  if (!medidos.length) {
    faltantes.push({
      que: 'kit',
      dice: (modelos || []).length
        ? `${modelos.length} model(s) in this project, none of them measured yet`
        : 'This project has no 3D models to assemble',
    })
  }

  // 3 · La gramática: qué pieza juega cada papel estructural. No sale de la geometría —nada en un
  // bbox dice cuál muro es el exterior— y sin ella el montaje termina «bien» con cero objetos.
  const conPapel = medidos.filter(m => m.metadata?.montaje?.clase)
  if (medidos.length && !conPapel.length) {
    faltantes.push({ que: 'gramatica', dice: 'No model has been assigned its structural role yet' })
  }

  // 4 · Dónde vive Maps_App. Es configuración del despliegue, no del proyecto, pero se ve igual:
  // sin esto el botón contestaría un 503 después de haberse dejado pulsar.
  if (!BASE()) {
    faltantes.push({ que: 'maps_app', dice: 'The level generator is not configured on this server' })
  }

  return {
    aplica: true,
    entorno,
    niveles,
    faltantes,
    listo: faltantes.length === 0,
  }
}

module.exports = { estadoDeMontaje, entornoDe, nivelesDelEntorno, PREFIJO_ENTORNO }
