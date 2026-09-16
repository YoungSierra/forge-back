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
  // Fusión del maestro de 25: dos páginas del de 34 caen acá.
  readability:          { n: '11', alias: ['Readability', 'VisualHierarchy', 'CameraReadability', 'DetailDensity'] },
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
async function propagarDesdePagina({ db, project_id, asset_id, motivo = null, member_id = null }) {
  const { data: origen } = await db().from('forge_assets')
    .select('id, name, project_id').eq('id', asset_id).eq('project_id', project_id).maybeSingle()
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

  // Lo que ESTA hoja produjo: las tres vistas, el modelo, el teaser. Se revalida, no se regenera:
  // es arte pago y puede seguir valiendo.
  if (fila.derivados) {
    const { data: hijos } = await db().from('forge_assets')
      .select('id, name, metadata').eq('project_id', project_id).eq('derived_from_id', origen.id)
    for (const h of hijos || []) await marcar(h, fila.derivados, origen.id)
  }

  return {
    aplica: true, pagina, etiqueta: etiquetaDe(pagina), rol: fila.rol,
    marcadas, ausentes,
    condicional: fila.condicional || [],
    fuera: fila.fuera || [],
  }
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

module.exports = {
  MATRIZ, PAGINAS, DOCUMENTO, paginaDe, etiquetaDe, loQueDispara,
  propagarDesdePagina, pendientesDelProyecto, revalidar,
}
