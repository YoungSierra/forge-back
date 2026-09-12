// ─── Maps_App: del Level Design al mapa generado ─────────────────────────────
//
// Maps_App es la herramienta de Level_Gen del equipo. Corre hospedada aparte —Python puro, sin
// Blender— y expone su propia API. Forge no la reimplementa ni la envuelve: la llama.
//
// Lo que hay que entender de su contrato, porque fue el malentendido inicial: **no consume
// imágenes ni modelos**. Sus entradas son parámetros —arquetipo, semilla, dimensiones, altura del
// jugador, gating, densidades— y devuelve el grafo del nivel, su perfil y un esquemático.
//
// Así que el trabajo de Forge acá es uno solo y es el que Forge sabe hacer: **traducir el
// documento de Level Design a esos parámetros**. La prosa del `level_map` del nodo 3.5 entra, y
// salen un arquetipo y una docena de números.
//
// El catálogo de arquetipos NO se escribe acá. Se pide a la propia herramienta (`/api/archetypes`),
// igual que las opciones de ComfyUI se piden a ComfyUI: una lista fija en el repositorio envejece
// en silencio, y el error aparecería recién al generar.

const { callLLM } = require('./llm.service')

const BASE = () => (process.env.MAPS_APP_URL || '').replace(/\/$/, '')
const MODELO = process.env.MAPS_PARAMS_MODEL || 'anthropic:claude-sonnet-4-6'

// Altura del personaje. El propio paquete de JuanK lo fija así mientras el contrato del nodo 3.6
// no declare una medida real —verificado el 10-09: ni `char_profiles` ni `char_abilities` publican
// altura, alcance ni radio de interacción— y pide que la salida diga de dónde salió el valor.
const ALTURA_POR_DEFECTO = 1.8

function exigirBase() {
  const b = BASE()
  if (!b) throw new Error('MAPS_APP_URL no está configurada: Forge no sabe dónde vive Maps_App')
  return b
}

async function pedir(ruta, opciones = {}) {
  const r = await fetch(`${exigirBase()}${ruta}`, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', ...(opciones.headers || {}) },
  })
  const texto = await r.text()
  if (!r.ok) throw new Error(`Maps_App ${ruta} respondió ${r.status}: ${texto.slice(0, 200)}`)
  try { return JSON.parse(texto) } catch { throw new Error(`Maps_App ${ruta} no devolvió JSON`) }
}

/** El catálogo, tal como lo declara la herramienta: arquetipos, sus parámetros y sus densidades. */
async function arquetipos() {
  const r = await pedir('/api/archetypes')
  return r.archetypes || []
}

/**
 * Traduce el documento de Level Design a los parámetros de una generación.
 *
 * El modelo elige SOLO entre los arquetipos que la herramienta declara, y solo puede tocar los
 * parámetros que ese arquetipo admite. No se le deja inventar ni el nombre del arquetipo ni un
 * campo: los dos los rechazaría la herramienta al generar, que es después de haber prometido algo.
 */
async function parametrosDesdeLevelDesign({ levelMap, nivel = null, alturaJugador = null }) {
  const catalogo = await arquetipos()
  if (!catalogo.length) throw new Error('Maps_App no declara ningún arquetipo')

  const system = [
    'Elegís la configuración de un generador procedural de niveles a partir de un documento de',
    'Level Design. No escribís prosa: devolvés JSON.',
    '',
    'Arquetipos disponibles, con los parámetros que cada uno admite:',
    ...catalogo.map(a => `- ${a.id} — ${a.label}${a.params?.length ? ` · parámetros: ${a.params.join(', ')}` : ''}`
      + `${a.density_elements?.length ? ` · densidades: ${a.density_elements.join(', ')}` : ''}`),
    '',
    'Devolvé SOLO este objeto, sin texto alrededor y sin cercas de código:',
    '{',
    '  "archetype": "<uno de los ids de arriba, exacto>",',
    '  "seed": <entero>,',
    '  "map_width": <metros>, "map_height": <metros>,',
    '  "room_scale_mult": <0.5 a 2>,',
    '  "extra": { "<parámetro del arquetipo>": <valor> },',
    '  "elements": { "<densidad del arquetipo>": { "density": <0 a 1> } },',
    '  "por_que": "<en una frase, qué del documento llevó a este arquetipo>"',
    '}',
    '',
    'Reglas:',
    '- El `archetype` tiene que ser uno de la lista, escrito igual. No inventes.',
    '- En `extra` y `elements` solo entran las claves que ese arquetipo declara arriba.',
    '- Si el documento no dice algo, omitilo en vez de inventarlo: la herramienta tiene sus propios',
    '  valores por defecto y son mejores que un número inventado.',
    '- La semilla es tuya: elegí una y dejala fija, para que la generación sea repetible.',
  ].join('\n')

  const user = [
    nivel ? `Nivel: ${nivel}` : '',
    '',
    'Documento de Level Design:',
    String(levelMap).slice(0, 30000),
  ].filter(Boolean).join('\n')

  const res = await callLLM(system, user, { model: MODELO, rawText: true, temperature: 0.2, maxOutputTokens: 1500 })
  const texto = String(res?.data ?? res?.text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let p
  try { p = JSON.parse(texto) } catch { throw new Error(`la traducción a parámetros no devolvió JSON: ${texto.slice(0, 160)}`) }

  const elegido = catalogo.find(a => a.id === p.archetype)
  if (!elegido) throw new Error(`arquetipo inventado: "${p.archetype}" no está en el catálogo de Maps_App`)

  // Las claves que el arquetipo no declara se descartan acá y se dicen. Mandarlas sería un 400 de
  // la herramienta con el nivel a medio generar.
  const fuera = []
  const filtrar = (obj, permitidas, donde) => {
    const out = {}
    for (const [k, v] of Object.entries(obj || {})) {
      if (permitidas.includes(k)) out[k] = v
      else fuera.push(`${donde}.${k}`)
    }
    return out
  }

  return {
    parametros: {
      archetype: p.archetype,
      seed: Number.isInteger(p.seed) ? p.seed : Math.floor(Math.random() * 100000),
      map_width: Number(p.map_width) || 30,
      map_height: Number(p.map_height) || 24,
      room_scale_mult: Number(p.room_scale_mult) || 1,
      // Un solo valor, dos consumidores: la generación del mapa y el anclaje de escala.
      player_height_m: alturaJugador || ALTURA_POR_DEFECTO,
      extra: filtrar(p.extra, elegido.params || [], 'extra'),
      elements: filtrar(p.elements, elegido.density_elements || [], 'elements'),
    },
    por_que: p.por_que || null,
    altura_declarada: Boolean(alturaJugador),
    ...(fuera.length ? { descartados: fuera } : {}),
    modelo: MODELO,
  }
}

/**
 * Genera el nivel. Devuelve `{ level_graph, profile, image_png_base64, stats }`; para un arquetipo
 * de edificio son N pisos con esa misma forma cada uno.
 */
async function generar(parametros) {
  const esEdificio = (await arquetipos()).find(a => a.id === parametros.archetype)?.is_building
  const ruta = esEdificio ? '/api/generate_building' : '/api/generate'
  return pedir(ruta, { method: 'POST', body: JSON.stringify(parametros) })
}

/**
 * Genera y publica el resultado como piezas del proyecto: el esquemático como imagen, y el grafo y
 * el perfil como documentos. Cuelgan del activo de origen, así que se dibujan a su derecha con el
 * mismo criterio que todo lo demás.
 */
async function generarYPublicar({ db, project_id, origen_asset_id = null, node_id = null, parametros, member_id = null }) {
  const { uploadToStorage } = require('./storage.service')
  const t0 = Date.now()
  const r = await generar(parametros)

  // Un edificio devuelve pisos; un nivel plano, uno solo. Se tratan igual.
  const pisos = r.floors ? r.floors : [r]
  const sello = Date.now().toString(36)
  const creados = []

  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id, output_key: null, status: 'auto_approved', iteration_count: 1,
    started_at: new Date(t0).toISOString(), completed_at: new Date().toISOString(), triggered_by: member_id,
  }).select('id').single()

  for (const [i, piso] of pisos.entries()) {
    const sufijo = pisos.length > 1 ? ` — piso ${i + 1}` : ''
    const base = `projects/${project_id}/mapas/${sello}${pisos.length > 1 ? `_p${i + 1}` : ''}`

    const png = Buffer.from(piso.image_png_base64, 'base64')
    const urlPng = await uploadToStorage(png, `${base}_esquematico.png`, 'image/png')
    const urlGrafo = await uploadToStorage(
      Buffer.from(JSON.stringify(piso.level_graph, null, 2), 'utf8'), `${base}_level_graph.json`, 'application/json')
    const urlPerfil = await uploadToStorage(
      Buffer.from(JSON.stringify(piso.profile, null, 2), 'utf8'), `${base}_profile.json`, 'application/json')

    const comun = {
      project_id, node_id, session_id: ses.id,
      status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
      ...(origen_asset_id ? { derived_from_id: origen_asset_id } : {}),
      metadata: {
        mapa: { archetype: parametros.archetype, seed: parametros.seed, piso: pisos.length > 1 ? i + 1 : null },
        parametros, stats: piso.stats,
        // De dónde salió la altura: del documento o del valor por defecto. El propio paquete pide
        // que quede registrado, para que nunca quede en duda cuál se usó.
        player_height_m: parametros.player_height_m,
      },
    }

    for (const [nombre, url, formato, mime] of [
      [`Mapa — ${parametros.archetype}${sufijo}`, urlPng, 'png', 'image/png'],
      [`Mapa — ${parametros.archetype}${sufijo} — level_graph`, urlGrafo, 'json', 'application/json'],
      [`Mapa — ${parametros.archetype}${sufijo} — profile`, urlPerfil, 'json', 'application/json'],
    ]) {
      const { data: a, error } = await db().from('forge_assets')
        .insert({ ...comun, name: nombre, format: formato, mime_type: mime, storage_url: url })
        .select('id, name, storage_url, format').single()
      if (error) throw error
      creados.push(a)
    }
  }

  try {
    require('./execution-log.service').logExecution({
      project_id, node_id, triggered_by: member_id,
      trigger_type: 'mapa', executor_type: 'maps_app', provider: 'maps_app', model: parametros.archetype,
      is_estimated: true, duration_ms: Date.now() - t0, started_at: new Date(t0).toISOString(),
      metadata: { seed: parametros.seed, pisos: pisos.length },
    })
  } catch (e) { console.warn('[mapas] logExec falló (no fatal):', e.message) }

  return { creados, pisos: pisos.length, stats: pisos.map(p => p.stats) }
}

/**
 * Del grafo del nivel a la orden de montaje.
 *
 * Lo corre el mismo servicio que genera los mapas, porque el paquete de montaje es Python y
 * `forge-back` es Node: no hay intérprete con `level_generator` de este lado. La ruta vive en un
 * archivo propio del despliegue y no toca una línea de Maps_App.
 *
 * La gramática no es opcional aunque el contrato la deje pasar vacía: dice qué pieza juega cada
 * papel estructural, y sin ella el montaje termina «bien» con cero objetos.
 */
async function ordenDeMontaje({ level_graph, kit_catalog, grammar, strategy = 'modular_hex', strategy_params = {}, assets_dir = 'modelos/', prefix = null, assembly_profile_id = null }) {
  return pedir('/api/assembly', {
    method: 'POST',
    body: JSON.stringify({ level_graph, kit_catalog, grammar, strategy, strategy_params, assets_dir, prefix, assembly_profile_id }),
  })
}

module.exports = { arquetipos, parametrosDesdeLevelDesign, generar, generarYPublicar, ordenDeMontaje, ALTURA_POR_DEFECTO, BASE }
