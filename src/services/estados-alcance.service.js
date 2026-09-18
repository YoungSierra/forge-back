// ─── El progreso del alcance, medido ─────────────────────────────────────────
//
// El panel de alcance movía sus estados a mano y los guardaba en el navegador. Eso enseña un
// progreso que nadie produjo: basta que alguien haga clic tres veces para que el slice parezca
// cerrado. El Frente 8 del plan de QA pide justamente validar «el progreso por categoría», así que
// el progreso tiene que venir de lo que HAY, no de lo que alguien marcó.
//
// La evidencia es lo que las cadenas dejaron escrito en cada pieza —`metadata.cadena.nombre` y
// `.paso`—, que es un dato que nadie teclea: lo pone el motor al publicar. Medido contra la base
// viva el 15-09, hoy existen piezas de character_sheet (concept_art · 3d), environment_sheet
// (concept_art · 3d), prop_sheet (concept_art · 3d), animation_sheet (animation_ref), audio_sheet
// (audio) y marketing (key_art · video).
//
// Lo que NO se puede medir se dice y se deja a mano. Forge no produce rigs, ni cuenta encuentros,
// ni sabe si una voz está grabada: inventar un estado para esos sería exactamente el problema que
// esto viene a arreglar, con otra cara. El front respeta el estado manual donde no hay medida.

// element key → qué evidencia lo aprueba. `paso` null = cualquier paso de esa cadena.
const REGLAS = {
  'character.personajes':            { cadena: 'character_sheet',   paso: 'concept_art' },
  'character.modelos':               { cadena: 'character_sheet',   paso: '3d' },
  'animation.clips':                 { cadena: 'animation_sheet',   paso: 'animation_ref' },
  'environment.entornos':            { cadena: 'environment_sheet', paso: 'concept_art' },
  'prop.props':                      { cadena: 'prop_sheet',        paso: 'concept_art' },
  'vfx.vfx':                         { cadena: 'vfx_sheet',         paso: 'flipbook' },
  'ui.pantallas':                    { cadena: 'ui_component_sheet', paso: 'ui' },
  'audio.sfx':                       { cadena: 'audio_sheet',       paso: 'audio' },
  'video_marketing.video_promocional': { cadena: 'marketing',       paso: 'video' },
}

// La paleta no sale de una cadena: es una página del ASG, y lo que la aprueba es su propia
// aprobación. Se mide aparte, por nombre de página.
const POR_PAGINA = {
  'paleta.paleta_materiales': '08_ColorSystem',
}

// ─── Y el progreso de CADA INSTANCIA ─────────────────────────────────────────
//
// Informe v8, puntos 5 y 7. Lo de arriba mide el elemento —«¿hay personajes?»— y eso basta cuando
// la categoría es una casilla. Desde que el panel enumera instancias reales («Cartón», «Moon Jelly
// × 6», «ENV-01 Biolume Bloom tileset»), medir la categoría entera deja las diecisiete fichas en
// «pending» para siempre por mucho que se completen sus workflows: el menú no reconocía la pieza
// como perteneciente a la instancia.
//
// La evidencia está en el NOMBRE, y no hace falta inventar nada: la cadena arrastra el nombre de
// la hoja de la que salió. Medido contra la base viva el 17-09 en test_smack_migue_v.09 —
//
//   Character Sheet — 18_CharacterSheet — Moon Jelly × 6 — Concept art — front
//   Environment Sheet — 19_EnvironmentSheet — ENV-01 Biolume Bloom tileset (…) — Concept art — part_01
//
// — así que basta con buscar el nombre de la instancia dentro del nombre de la pieza, acotando por
// la cadena de la categoría para que «Cartón» del Character Sheet no se cruce con «Cartón rig +
// all animations» del Animation Sheet.
//
// La clave que se devuelve es la que el panel consulta: `categoría.nombre de la instancia`.

/** Categoría del panel → su página del ASG y la cadena que la produce. Misma tabla que `vs-scope`
 *  en el front; acá hace falta para saber a qué cadena mirar. */
const POR_CATEGORIA = {
  paleta:          { pagina: '08_ColorSystem',         cadena: null },
  character:       { pagina: '18_CharacterSheet',      cadena: 'character_sheet' },
  environment:     { pagina: '19_EnvironmentSheet',    cadena: 'environment_sheet' },
  prop:            { pagina: '20_PropSheet',           cadena: 'prop_sheet' },
  ui:              { pagina: '21_UIComponentSheet',    cadena: 'ui_component_sheet' },
  vfx:             { pagina: '22_VFXSheet',            cadena: 'vfx_sheet' },
  audio:           { pagina: '23_AudioSheet',          cadena: 'audio_sheet' },
  animation:       { pagina: '24_AnimationSheet',      cadena: 'animation_sheet' },
  video_marketing: { pagina: '25_VideoMarketingSheet', cadena: 'marketing' },
}

/** El nombre de una página sin su número: el maestro renumera, los nombres no cambian. */
const sinNumero = s => String(s || '').replace(/^\d+[_\s-]*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Para comparar nombres de instancia contra nombres de pieza: solo letras y dígitos. */
const plano = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * El ÚLTIMO paso que de verdad despacha un workflow, que es el que cierra la instancia.
 *
 * Se lee de la definición de la cadena en vez de repetirla acá: si mañana Character Sheet gana un
 * paso de texturas, esto lo sigue solo. Los pasos sin `workflow` —el montaje del Environment, que
 * reúne lo que ya hay y necesita que alguien marque los papeles— no cuentan como cierre: dejarlos
 * dentro haría que un entorno con sus veinte modelos hechos no llegara nunca a «approved».
 */
function ultimoPasoDe(cadena) {
  try {
    const { CADENAS } = require('./chain.service')
    const pasos = (CADENAS?.[cadena]?.pasos || []).filter(p => p.workflow)
    return pasos.length ? pasos[pasos.length - 1].clave : null
  } catch { return null }
}

/** Lo que Forge no mide, y por qué. Viaja al front para poder decirlo en pantalla. */
const SIN_MEDIDA = {
  'character.rigs':            'Forge does not produce rigs: the rig is made downstream, in Cascadeur',
  'environment.niveles':       'Levels are described in the level map, not produced as pieces here',
  'environment.encuentros':    'Encounters are a design decision, not a produced asset',
  'environment.tipos_mapa':    'Map types are a design decision, not a produced asset',
  'prop.items':                'Items are not told apart from props by what the chain publishes',
  'audio.musica':              'The audio chain publishes one track: which one is music is not declared',
  'audio.vo':                  'Voice is not produced in Forge yet',
}

/**
 * El estado de cada elemento del alcance, medido contra lo que hay publicado.
 *
 * `aprobado` cuando la cadena que lo produce dejó al menos una pieza aprobada; `en_progreso`
 * cuando dejó piezas sin aprobar o corrió un paso anterior; y nada —el elemento no aparece—
 * cuando no hay forma de medirlo, que es distinto de «pendiente» y por eso no se devuelve.
 */
async function estadosMedidos({ db, project_id }) {
  const { data: piezas } = await db().from('forge_assets')
    .select('name, status, metadata')
    .eq('project_id', project_id)
    .not('metadata->cadena', 'is', null)

  // cadena → paso → ¿hay alguna aprobada?
  const visto = {}
  for (const p of piezas || []) {
    const c = p.metadata?.cadena
    if (!c?.nombre) continue
    const clave = `${c.nombre}::${c.paso || ''}`
    const aprobada = ['approved', 'auto_approved'].includes(p.status)
    visto[clave] = visto[clave] || { hay: 0, aprobadas: 0 }
    visto[clave].hay++
    if (aprobada) visto[clave].aprobadas++
  }

  const estados = {}
  for (const [elemento, regla] of Object.entries(REGLAS)) {
    const v = visto[`${regla.cadena}::${regla.paso}`]
    if (!v) {
      // Un paso posterior sin el suyo no existe, pero un paso ANTERIOR de la misma cadena sí
      // cuenta como empezado: el concept art del personaje ya es progreso hacia su modelo.
      const empezada = Object.keys(visto).some(k => k.startsWith(`${regla.cadena}::`))
      if (empezada) estados[elemento] = 'en_progreso'
      continue
    }
    estados[elemento] = v.aprobadas ? 'aprobado' : 'en_progreso'
  }

  // La paleta: su página del ASG, aprobada o no.
  const paginas = Object.values(POR_PAGINA)
  if (paginas.length) {
    const { data: hojas } = await db().from('forge_assets')
      .select('name, status').eq('project_id', project_id).like('name', 'Art Style Guide — %')
    for (const [elemento, pagina] of Object.entries(POR_PAGINA)) {
      const h = (hojas || []).filter(x => String(x.name).includes(pagina))
      if (!h.length) continue
      estados[elemento] = h.some(x => ['approved', 'auto_approved'].includes(x.status)) ? 'aprobado' : 'en_progreso'
    }
  }

  // ── Y ahora, instancia por instancia ──────────────────────────────────────
  Object.assign(estados, await estadosPorInstancia({ db, project_id, piezas: piezas || [] }))

  return { estados, sin_medida: SIN_MEDIDA }
}

/**
 * El estado de cada instancia declarada por el alcance, medido contra lo que sus workflows
 * dejaron publicado.
 *
 * `pendiente` (no se devuelve) mientras la cadena no arrancó —la ficha existe, pero existir no es
 * progreso: con el ASG completo TODAS las fichas nacen a la vez y marcarlas «in progress» de
 * entrada no diría nada—; `en_progreso` en cuanto hay una pieza de su cadena; y `aprobado` cuando
 * el último paso con workflow dejó una pieza aprobada.
 */
async function estadosPorInstancia({ db, project_id, piezas }) {
  let alcance
  try {
    const { itemsDelAlcance } = require('./alcance-vs.service')
    alcance = await itemsDelAlcance({ db, project_id })
  } catch { return {} }
  if (!alcance?.hay) return {}

  // página del alcance → categoría del panel.
  const catDePagina = new Map()
  for (const [cat, v] of Object.entries(POR_CATEGORIA)) catDePagina.set(sinNumero(v.pagina), cat)

  const estados = {}
  for (const [hoja, items] of Object.entries(alcance.porHoja || {})) {
    const cat = catDePagina.get(sinNumero(hoja))
    const cadena = cat && POR_CATEGORIA[cat]?.cadena
    if (!cat || !cadena || !items?.length) continue

    const cierre = ultimoPasoDe(cadena)
    const deLaCadena = piezas.filter(p => p.metadata?.cadena?.nombre === cadena)

    // Nombres normalizados, del más largo al más corto: si una instancia se llama «Cartón» y otra
    // «Cartón rig + all animations», la pieza tiene que caer en la MÁS específica que encaje, no
    // en la primera que aparezca.
    const nombres = items
      .map(i => ({ nombre: i.nombre, k: plano(i.nombre) }))
      .filter(i => i.k.length >= 3)
      .sort((a, b) => b.k.length - a.k.length)

    for (const p of deLaCadena) {
      const n = plano(p.name)
      const cual = nombres.find(i => n.includes(i.k))
      if (!cual) continue                       // pieza sin instancia: no se le atribuye a nadie
      const clave = `${cat}.${cual.nombre}`
      const aprobada = ['approved', 'auto_approved'].includes(p.status)
      const cierra = cierre && p.metadata?.cadena?.paso === cierre && aprobada
      if (cierra) estados[clave] = 'aprobado'
      else if (estados[clave] !== 'aprobado') estados[clave] = 'en_progreso'
    }
  }
  return estados
}

module.exports = { estadosMedidos, estadosPorInstancia, REGLAS, POR_PAGINA, POR_CATEGORIA, SIN_MEDIDA }
