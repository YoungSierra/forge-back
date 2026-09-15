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
// (concept_art · 3d), prop_sheet (concept_art · 3d), animation_sheet (pose_sheet), audio_sheet
// (audio) y marketing (key_art · video).
//
// Lo que NO se puede medir se dice y se deja a mano. Forge no produce rigs, ni cuenta encuentros,
// ni sabe si una voz está grabada: inventar un estado para esos sería exactamente el problema que
// esto viene a arreglar, con otra cara. El front respeta el estado manual donde no hay medida.

// element key → qué evidencia lo aprueba. `paso` null = cualquier paso de esa cadena.
const REGLAS = {
  'character.personajes':            { cadena: 'character_sheet',   paso: 'concept_art' },
  'character.modelos':               { cadena: 'character_sheet',   paso: '3d' },
  'animation.clips':                 { cadena: 'animation_sheet',   paso: 'pose_sheet' },
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

  return { estados, sin_medida: SIN_MEDIDA }
}

module.exports = { estadosMedidos, REGLAS, POR_PAGINA, SIN_MEDIDA }
