// ─── Sistema de actualización conectada ──────────────────────────────────────
//
// Un archivo gráfico no es una isla. Al ajustar una página, las que dependen de ella quedan
// desactualizadas y el juego pierde coherencia visual —se cambia la paleta y los personajes siguen
// llevando los colores viejos.
//
// **Nada se auto-regenera.** Es la política de la §2.1 del documento de Miguel y no un detalle de
// implementación: generar cuesta y NO es reproducible —el mismo prompt da otra imagen y no hay
// caché—, así que regenerar sin permiso destruiría arte aprobado que nadie puede recuperar. Todo
// lo que esta cascada hace es MARCAR, con la acción sugerida:
//
//   [R] regenerar — el contenido depende del cambio; hay que volver a generar (pago, irreversible).
//   [V] revalidar — probablemente sigue valiendo; una persona lo mira y confirma. No cuesta nada.
//
// ── Por NOMBRE, no por número ────────────────────────────────────────────────
//
// La primera versión indexaba la matriz por el número de página: `19` era Environment Sheet. Los
// dos proyectos vivos corren el maestro de 34 páginas, donde esa misma hoja es la 29 — así que la
// cascada no reconocía ni una de sus hojas y no hacía nada, en silencio. Es el punto 3 del informe
// v6, y Miguel pidió resolverlo por nombre.
//
// Y no es solo renumerar: el maestro de 25 FUSIONÓ páginas. `14_VisualHierarchy` y
// `15_CameraReadability` son hoy `11_Readability`; `16_AnimationStyle` es `12_AnimationLanguage`.
// Por eso cada página lleva sus alias, y dos nombres viejos pueden apuntar a la misma fila.

const DOCUMENTO = 'Art Style Guide'

/** Para comparar nombres de página: sin número, sin puntuación, sin mayúsculas. */
const norm = s => String(s || '').replace(/^\d+[_\s-]*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

// Cada página con el número que tiene en el maestro de 25 —solo para poder nombrarla— y los
// nombres con los que aparece en los maestros que hay en producción.
const PAGINAS = {
  key_art:              { n: '01', alias: ['KeyArt'] },
  visual_dna:           { n: '02', alias: ['VisualDNA'] },
  visual_pillars:       { n: '03', alias: ['VisualPillars'] },
  shape_language:       { n: '04', alias: ['ShapeLanguage'] },
  character_design:     { n: '05', alias: ['CharacterDesign', 'CharacterDesignLanguage', 'CostumeLanguage'] },
  environment_language: { n: '06', alias: ['EnvironmentLanguage'] },
  prop_language:        { n: '07', alias: ['PropLanguage'] },
  color_system:         { n: '08', alias: ['ColorSystem'] },
  lighting:             { n: '09', alias: ['LightingLanguage', 'Lighting'] },
  texture_style:        { n: '10', alias: ['TextureStyle', 'Material'] },
  // Fusión del maestro de 25, tal como la fija la v2.3 §2.0: «Readability = VisualHierarchy +
  // CameraReadability». DetailDensity NO entra — estaba de más de nuestro lado y Miguel lo sacó
  // explícitamente al cerrar el punto de las equivalencias.
  readability:          { n: '11', alias: ['Readability', 'VisualHierarchy', 'CameraReadability'] },
  animation_language:   { n: '12', alias: ['AnimationLanguage', 'AnimationStyle'] },
  vfx_language:         { n: '13', alias: ['VFXLanguage'] },
  audio_language:       { n: '14', alias: ['AudioLanguage'] },
  video_marketing:      { n: '15', alias: ['VideoMarketing'] },
  ui_language:          { n: '16', alias: ['UILanguage', 'UIStyle', 'Iconography'] },
  asset_sheets:         { n: '17', alias: ['AssetSheets'] },
  character_sheet:      { n: '18', alias: ['CharacterSheet'] },
  environment_sheet:    { n: '19', alias: ['EnvironmentSheet'] },
  prop_sheet:           { n: '20', alias: ['PropSheet'] },
  ui_component_sheet:   { n: '21', alias: ['UIComponentSheet'] },
  vfx_sheet:            { n: '22', alias: ['VFXSheet'] },
  audio_sheet:          { n: '23', alias: ['AudioSheet'] },
  animation_sheet:      { n: '24', alias: ['AnimationSheet'] },
  video_marketing_sheet:{ n: '25', alias: ['VideoMarketingSheet'] },
}

// nombre normalizado → clave de página. Se arma una vez.
const POR_ALIAS = {}
for (const [clave, def] of Object.entries(PAGINAS)) {
  for (const a of def.alias) POR_ALIAS[norm(a)] = clave
}

/** Las hojas de instancia: terminales dentro de la guía, pero revalidan lo que produjeron. */
const HOJAS = ['character_sheet', 'environment_sheet', 'prop_sheet', 'ui_component_sheet',
               'vfx_sheet', 'audio_sheet', 'animation_sheet', 'video_marketing_sheet']

const R = p => ({ pagina: p, accion: 'R' })
const V = p => ({ pagina: p, accion: 'V' })
const LENGUAJE = ['shape_language', 'character_design', 'environment_language', 'prop_language',
                  'lighting', 'texture_style', 'readability', 'animation_language',
                  'vfx_language', 'video_marketing', 'ui_language']
const SHEETS_R = ['character_sheet', 'environment_sheet', 'prop_sheet', 'ui_component_sheet',
                  'vfx_sheet', 'animation_sheet', 'video_marketing_sheet']

// La §2 del documento, fila por fila. Lo que no está acá no se marca.
const MATRIZ = {
  key_art: { rol: 'Gobernanza / estática', terminal: true,
    condicional: [V('visual_dna'), V('visual_pillars')] },

  visual_dna:     { rol: 'Fundacional', destinos: [R('key_art'), ...LENGUAJE.map(R), ...SHEETS_R.map(R)] },
  visual_pillars: { rol: 'Fundacional', destinos: [R('key_art'), ...LENGUAJE.map(R), ...SHEETS_R.map(R)] },

  shape_language:       { rol: 'Lenguaje', destinos: [R('character_design'), R('prop_language'), R('character_sheet'), R('prop_sheet')] },
  character_design:     { rol: 'Lenguaje', destinos: [R('character_sheet'), V('animation_language')] },
  environment_language: { rol: 'Lenguaje', destinos: [R('environment_sheet'), V('lighting'), V('readability')] },
  prop_language:        { rol: 'Lenguaje', destinos: [R('prop_sheet')] },

  color_system: { rol: 'Fundacional', destinos: [...SHEETS_R.map(R), V('vfx_language'), V('ui_language')] },

  lighting:           { rol: 'Lenguaje', destinos: [R('environment_sheet'), V('color_system')] },
  texture_style:      { rol: 'Lenguaje', destinos: [R('prop_sheet')] },
  readability:        { rol: 'Lenguaje', destinos: [R('environment_sheet'), ...SHEETS_R.filter(p => p !== 'environment_sheet').map(V)] },
  animation_language: { rol: 'Lenguaje', destinos: [R('animation_sheet'), V('character_sheet')], fuera: ['ADI §11.6 Framework [V]'] },
  vfx_language:       { rol: 'Lenguaje', destinos: [R('vfx_sheet'), V('color_system')] },
  audio_language:     { rol: 'Lenguaje (audio)', destinos: [R('audio_sheet')], fuera: ['TDD §10 Audio'] },
  video_marketing:    { rol: 'Lenguaje', destinos: [R('video_marketing_sheet'), V('visual_dna')] },
  ui_language:        { rol: 'Lenguaje', destinos: [R('ui_component_sheet'), V('color_system')] },

  asset_sheets: { rol: 'Divisoria', terminal: true, destinos: [] },

  ...Object.fromEntries(HOJAS.map(p => [p, {
    rol: 'Instancia (hoja)', terminal: true,
    destinos: [V('asset_sheets')],
    derivados: 'V',
  }])),
}

/**
 * Qué página del ASG es esta pieza, por su nombre. `null` si no lo es.
 *
 * Identidad = DOCUMENTO + nombre. El documento importa: el 3.20 emite tres decks y sus páginas
 * colisionan en el número —es lo que hizo que el Art Bible citara páginas del GDD—, y el nombre
 * importa porque el número cambia entre maestros.
 */
function paginaDe(asset) {
  const n = String(asset?.name || '')
  const m = /^\s*(.+?)\s*[—–-]\s*(.+?)\s*(?:[—–-]|$)/.exec(n)
  if (!m) return null
  if (m[1].trim().toLowerCase() !== DOCUMENTO.toLowerCase()) return null
  return POR_ALIAS[norm(m[2])] || null
}

/** El número y el nombre con que se enseña una página. */
const etiquetaDe = clave => (PAGINAS[clave] ? `${PAGINAS[clave].n} ${PAGINAS[clave].alias[0]}` : clave)

/** Qué dispara tocar esta página, sin tocar nada: es lo que el aviso previo necesita decir. */
function loQueDispara(pagina) {
  const fila = MATRIZ[pagina]
  if (!fila) return null
  return {
    pagina, etiqueta: etiquetaDe(pagina), rol: fila.rol, terminal: Boolean(fila.terminal),
    destinos: (fila.destinos || []).map(d => ({ ...d, etiqueta: etiquetaDe(d.pagina) })),
    condicional: fila.condicional || [],
    derivados: fila.derivados || null,
    fuera: fila.fuera || [],
  }
}

/**
 * Marca como desactualizado todo lo que depende de la página que acaba de cambiar.
 *
 * La marca vive en el propio activo —`metadata.desactualizado`— y no en una tabla aparte porque es
 * un estado de la pieza: quien la mira tiene que verlo ahí, y quien la regenera tiene que poder
 * limpiarlo sin coordinar dos escrituras.
 *
 * Una marca nueva NO pisa una anterior sin decirlo: si una página ya estaba marcada [R] por otro
 * cambio, se queda en [R] —la acción más fuerte manda— y se suma el origen. Bajarla a [V] porque
 * llegó después un cambio menor perdería el trabajo que ya se debía.
 */
/**
 * `cambio` dice QUÉ clase de cambio fue, y solo afecta a los derivados (v2.3 §2.1):
 *
 *   'sujeto'      cambió lo que se retrata  → los derivados se marcan [R]
 *   'tratamiento' cambió la luz o la paleta → [V], como hasta ahora
 *   null          no se sabe               → [V], que es lo que no cuesta ni destruye
 *
 * No se deduce del texto del Design Edit. «change the spider for a lion» es fácil, «make it
 * warmer and add a fireplace» no, y equivocarse manda a alguien a pagar una regeneración que no
 * hacía falta. Lo elige quien edita, que es el único que lo sabe.
 */
async function propagarDesdePagina({ db, project_id, asset_id, motivo = null, member_id = null, cambio = null }) {
  const { data: origen } = await db().from('forge_assets')
    .select('id, name, project_id, metadata').eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!origen) return { aplica: false, motivo: 'Asset not found' }

  const pagina = paginaDe(origen)
  if (!pagina) return { aplica: false }
  const fila = MATRIZ[pagina]
  if (!fila) return { aplica: false, motivo: `“${origen.name}” is not in the trigger matrix` }

  const destinos = fila.destinos || []
  if (!destinos.length && !fila.derivados) {
    return { aplica: true, pagina, etiqueta: etiquetaDe(pagina), marcadas: [], condicional: fila.condicional || [], fuera: fila.fuera || [] }
  }

  // Las páginas del MISMO documento y proyecto. Se piden todas de una y se resuelven por nombre en
  // memoria: una consulta por destino serían veinte viajes para un cambio de Visual DNA.
  const { data: hermanas } = await db().from('forge_assets')
    .select('id, name, metadata')
    .eq('project_id', project_id)
    .like('name', `${DOCUMENTO} — %`)
  const porPagina = {}
  for (const h of hermanas || []) {
    const p = paginaDe(h)
    // De cada página vale la última: una regenerada convive con la anterior y marcar la vieja no
    // le sirve a nadie. Vienen ordenadas por inserción, así que la última gana.
    if (p) porPagina[p] = h
  }

  const sello = new Date().toISOString()
  const marcadas = []
  const ausentes = []

  // En qué versión va el padre AHORA. Es la mitad del dato que pide la v2.1: la otra mitad —de
  // qué versión salió cada hija— la lleva la propia hija desde que se produjo. Con las dos, la
  // marca puede decir «esta parte viene de la v1 y la hoja va por la v4» sin abrir ninguna.
  const versionPadre = await versionVigente(db, origen.id)

  const marcar = async (pieza, accion, por) => {
    const previa = pieza.metadata?.desactualizado
    // La acción más fuerte manda: [R] no baja a [V] porque llegó un cambio menor después.
    const final = previa?.accion === 'R' ? 'R' : accion
    const origenes = [...new Set([...(previa?.origenes || []), por])]
    const metadata = {
      ...(pieza.metadata || {}),
      desactualizado: {
        accion: final, origenes, desde: previa?.desde || sello, marcado_en: sello,
        por_pagina: etiquetaDe(pagina), motivo: motivo || previa?.motivo || null, marcado_por: member_id,
        // De qué versión del padre salió esta pieza, y en cuál va él. `null` en las que se
        // produjeron antes de que esto existiera: se dice que no se sabe en vez de suponer v1.
        version_padre: versionPadre,
        version_origen: pieza.metadata?.derivado_de_version ?? null,
        // Qué clase de cambio lo provocó, para que la tarjeta pueda explicarse.
        cambio: cambio || previa?.cambio || null,
      },
    }
    const { error } = await db().from('forge_assets').update({ metadata }).eq('id', pieza.id)
    if (error) throw error
    pieza.metadata = metadata
    marcadas.push({ id: pieza.id, nombre: pieza.name, accion: final })
  }

  for (const d of destinos) {
    const pieza = porPagina[d.pagina]
    if (!pieza) { ausentes.push(etiquetaDe(d.pagina)); continue }
    if (pieza.id === origen.id) continue           // una página no se marca a sí misma
    await marcar(pieza, d.accion, origen.id)
  }

  // Lo que ESTA hoja produjo: las tres vistas, el modelo, el teaser.
  //
  // Se revalidaba siempre, porque es arte pago y suele seguir valiendo. El caso del león mostró
  // que eso se queda corto: la hoja pasó de un gato a un león y sus veinte partes seguían siendo
  // del gato — ahí no hay nada que revalidar, hay que rehacerlas. Por eso la v2.3 distingue: si
  // cambió QUÉ se retrata, los derivados van a [R]; si cambió la luz o la paleta, [V].
  if (fila.derivados) {
    const { data: hijos } = await db().from('forge_assets')
      .select('id, name, metadata').eq('project_id', project_id).eq('derived_from_id', origen.id)
    const accionHijos = cambio === 'sujeto' ? 'R' : fila.derivados
    for (const h of hijos || []) await marcar(h, accionHijos, origen.id)
  }

  // ── Aguas AFUERA: el Art Bible ────────────────────────────────────────────
  //
  // Informe v9, punto 6. Hasta acá la cascada vive dentro del Art Style Guide: `hermanas` se
  // busca con `like('${DOCUMENTO} — %')`, así que el Art Bible —que es otro documento— nunca se
  // enteraba de nada.
  //
  // Y sí depende: cada página del Art Bible se PINTA a partir de una página ya renderizada del
  // ASG, y lo dice ella misma en su prompt —«Art Style Guide (ASG · 05 Character Design
  // Language)»—. Medido el 18-09 contra el registro: las 20 páginas declaran la suya, 20 de 20.
  // Si la página del ASG cambió, la del bible se pintó desde una imagen que ya no existe.
  //
  // Va a [R] y no a [V] a propósito: no es una hoja que «probablemente siga valiendo», es una
  // obra derivada de UNA imagen concreta que cambió. Nada se regenera solo — como todo el resto
  // del sistema, esto marca y decide una persona.
  try {
    const delBible = await paginasDelBibleQueCitan(db, project_id, pagina)
    for (const b of delBible) await marcar(b, 'R', origen.id)
    if (delBible.length) console.log(`[actualizacion] aguas afuera: ${delBible.length} página(s) del Art Bible marcadas por «${etiquetaDe(pagina)}»`)
  } catch (e) {
    // Que el registro del bible no se pueda leer no puede tumbar la cascada del ASG, que es la
    // que de verdad importa. Se dice y se sigue.
    console.warn('[actualizacion] no se pudo propagar al Art Bible:', e.message)
  }

  return {
    aplica: true, pagina, etiqueta: etiquetaDe(pagina), rol: fila.rol,
    marcadas, ausentes,
    condicional: fila.condicional || [],
    fuera: fila.fuera || [],
  }
}

/**
 * Las páginas del Art Bible de ESTE proyecto que se pintan desde una página dada del ASG.
 *
 * El vínculo no se escribe acá: se lee del registro del workflow, donde cada página del bible cita
 * la del ASG que toma como canon. Copiarlo a una tabla en el código sería una segunda verdad que
 * envejece sola — y ya pasó con los nombres de los decks.
 *
 * Se empareja por NOMBRE y no por número: el maestro del ASG pasó de 34 páginas a 25 y los números
 * se movieron, los nombres no. Es la misma lección de `bug_artbible_paginas_del_gdd`.
 */
async function paginasDelBibleQueCitan(db, project_id, paginaASG) {
  const { getWorkflowByName } = require('./config.service')
  const entry = await getWorkflowByName('V57_STUDIO_ArtBible_Template_20')
  if (!entry?.workflow_json) return []

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const buscada = norm(etiquetaDe(paginaASG))          // «19 EnvironmentSheet» → «19environmentsheet»
  const soloNombre = norm(String(etiquetaDe(paginaASG)).replace(/^\d+\s*/, ''))

  const citas = []
  for (const p of entry.inject_config?.pages || []) {
    const prompt = entry.workflow_json[p.prompt_node]?.inputs?.prompt || ''
    const cita = prompt.match(/Art Style Guide \(ASG\s*[·.\-]?\s*(\d{1,2})\s*([^)]*)\)/i)
    if (!cita) continue
    citas.push({ bible: p.nombre || p.name, num: String(cita[1]).padStart(2, '0'), nombre: norm((cita[2] || '').trim()) })
  }

  // EXACTO primero, y contención solo si deja UNA. Aflojar a «uno contiene al otro» sin exigir
  // unicidad empareja «Video Marketing» con la lámina «Video Marketing Sheet», que es otra página
  // — medido: con la regla laxa, esas dos se reclamaban mutuamente y un cambio en cualquiera
  // marcaba las dos del bible. Es la misma trampa que ya documenta `paginaDelASG`.
  let quiere = citas.filter(c => c.nombre && c.nombre === soloNombre).map(c => c.bible)
  if (!quiere.length) {
    const laxas = citas.filter(c => c.nombre && (c.nombre.includes(soloNombre) || soloNombre.includes(c.nombre)))
    if (laxas.length === 1) quiere = [laxas[0].bible]
    else if (laxas.length > 1) {
      console.warn(`[actualizacion] «${etiquetaDe(paginaASG)}» encaja con ${laxas.length} páginas del Art Bible (${laxas.map(c => c.bible).join(', ')}) — no se marca ninguna`)
    }
  }
  // Y el número, solo para las citas que no traen nombre: ahí es el mejor dato que existe.
  if (!quiere.length) {
    quiere = citas.filter(c => !c.nombre && buscada.startsWith(c.num)).map(c => c.bible)
  }
  if (!quiere.length) return []

  // Y ahora, cuáles de esas existen publicadas en este proyecto.
  const { data: hojas } = await db().from('forge_assets')
    .select('id, name, metadata')
    .eq('project_id', project_id).like('name', 'Art Bible — %')
  const cola = n => norm(String(n || '').split(/\s+[—–-]\s+/).pop())
  return (hojas || []).filter(h => quiere.some(q => cola(h.name) === norm(q)))
}

/** Lo que está marcado hoy en el proyecto, para el panel y para los sellos del lienzo. */
async function pendientesDelProyecto({ db, project_id }) {
  const { data } = await db().from('forge_assets')
    .select('id, name, storage_url, metadata')
    .eq('project_id', project_id)
    .not('metadata->desactualizado', 'is', null)
  return (data || []).map(a => ({
    id: a.id, nombre: a.name, url: a.storage_url,
    accion: a.metadata.desactualizado.accion,
    desde: a.metadata.desactualizado.desde,
    por_pagina: a.metadata.desactualizado.por_pagina || null,
    origenes: a.metadata.desactualizado.origenes || [],
    version_padre: a.metadata.desactualizado.version_padre ?? null,
    version_origen: a.metadata.desactualizado.version_origen ?? null,
    cambio: a.metadata.desactualizado.cambio ?? null,
  }))
}

/**
 * Levanta la marca de una pieza.
 *
 * Es el gate humano de la §2.1: revalidar es mirar y confirmar, y confirmar es esto. Regenerar
 * limpia la marca también, pero por el camino normal —la pieza nueva nace sin marca— así que acá
 * solo se registra quién la dio por buena y cuándo.
 */
async function revalidar({ db, project_id, asset_id, member_id = null }) {
  const { data: pieza } = await db().from('forge_assets')
    .select('id, name, metadata').eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!pieza) { const e = new Error('Asset not found'); e.code = 'NO_ASSET'; throw e }
  const marca = pieza.metadata?.desactualizado
  if (!marca) return { id: pieza.id, nombre: pieza.name, ya_estaba: true }

  const metadata = { ...(pieza.metadata || {}) }
  delete metadata.desactualizado
  // Queda el rastro de que alguien la miró: sin esto, «no está marcada» y «nadie la revisó» se
  // leen igual.
  metadata.revalidada = { en: new Date().toISOString(), por: member_id, venia_de: marca.accion }

  const { error } = await db().from('forge_assets').update({ metadata }).eq('id', asset_id)
  if (error) throw error
  return { id: pieza.id, nombre: pieza.name, accion_previa: marca.accion }
}

/**
 * En qué versión va una pieza ahora mismo, o `null` si nunca se versionó.
 *
 * Vive acá porque es el dato que la marca necesita en los DOS extremos: la versión del padre
 * cuando se marca, y la del padre cuando se produjo la hija. Leerlo en dos sitios distintos sería
 * garantizar que un día cuenten cosas distintas.
 */
async function versionVigente(db, asset_id) {
  const { data } = await db().from('forge_asset_versions')
    .select('version_number').eq('asset_id', asset_id)
    .order('version_number', { ascending: false }).limit(1)
  return data?.[0]?.version_number ?? null
}

module.exports = {
  MATRIZ, PAGINAS, DOCUMENTO, paginaDe, etiquetaDe, loQueDispara,
  propagarDesdePagina, pendientesDelProyecto, revalidar, versionVigente, paginasDelBibleQueCitan,
}
