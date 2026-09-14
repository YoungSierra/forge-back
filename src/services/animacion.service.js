// ─── Animation Sheet: del ADI a la hoja de poses ─────────────────────────────
//
// El workflow de la hoja de poses existía desde antes y estaba huérfano del sistema de Sheets:
// construido, funcional, y sin nadie que lo llamara. Esto lo conecta.
//
// Una hoja de poses es POR CLIP, no por personaje: el workflow recibe la imagen ancla, los beats
// de UN movimiento y el nombre de ese movimiento, y devuelve una lámina de tres vistas por tantas
// columnas como poses tengan esos beats. Un personaje con seis clips son seis despachos pagados,
// igual que las veinte partes del escenario.
//
// De dónde sale cada entrada, y por qué:
//
//   la lista de clips   `ADI_11.6_AnimationProduction` (nodo 3.9). El paquete de JuanK la
//                       referencia al documento de alcance del Vertical Slice, que vive en Drive
//                       y Forge no lee. Pero el ADI ya la trae —«Walk, Trot, Sprint, Bat, Sniff,
//                       Stare, Squeeze, Hide»— con sus duraciones y sus reglas, y es la misma
//                       fuente que ya usan las láminas de marketing. Se lee de ahí.
//
//   los beats           Se componen con la skill `cascadeur_movement_choreography`, que es la que
//                       define el formato exacto que el nodo 2 espera («Pose 1 (Anticipación): …»).
//                       No se parafrasea el método acá: se carga la skill registrada, igual que
//                       hace el protocolo de escala con la suya. Si no está, esto no corre.
//
//   la imagen ancla     La vista FRONTAL del personaje, que produce la cadena de Character Sheet.
//                       El propio paquete lo marca como hueco: «nadie ató automáticamente la vista
//                       Frontal al nodo 17». Es lo que el motor de cadenas ya sabe hacer.
//
// Lo que NO hace, y es del documento de JuanK, no una omisión: los pasos de Cascadeur quedan
// fuera. No hay forma de correr Cascadeur desde ComfyUI cloud. El Run entrega la hoja de poses y
// ahí termina el tramo de Forge.

const { callLLM } = require('./llm.service')
const { getSkill } = require('./prompt.service')

const MODELO = process.env.ANIM_CLIPS_MODEL || 'anthropic:claude-sonnet-4-6'

// El tope existe para que un ADI verborrágico no convierta un Run en veinte despachos pagados sin
// que nadie lo haya pedido. Si el documento declara más, se dicen y se recortan.
const TOPE_CLIPS = 8

const SKILL_BEATS = 'cascadeur_movement_choreography'

/** El texto de `ADI_11.6_AnimationProduction` de este proyecto, o null. */
async function adiDeAnimacion(db, project_id) {
  const { data: ses } = await db().from('forge_sessions')
    .select('id').eq('project_id', project_id).eq('output_key', 'ADI_11.6_AnimationProduction')
  if (!(ses || []).length) return null
  const { data: docs } = await db().from('forge_assets')
    .select('content, created_at').in('session_id', ses.map(s => s.id))
    .not('content', 'is', null).order('created_at', { ascending: false })
  return docs?.[0]?.content || null
}

/**
 * Los clips que hay que animar, leídos del ADI.
 *
 * El modelo no los inventa: extrae los que el documento nombra. Un clip que no esté en el ADI no
 * tiene reglas de movimiento, y sin reglas los beats salen genéricos — que es exactamente lo que
 * la skill de coreografía existe para evitar.
 */
async function clipsDelProyecto({ db, project_id }) {
  const adi = await adiDeAnimacion(db, project_id)
  if (!adi) {
    const err = new Error('Node 3.9 has not produced ADI_11.6 Animation Production yet: there is no clip list to animate')
    err.code = 'SIN_ADI'
    throw err
  }

  const system = [
    'Extraés la lista de animaciones a producir de un documento de dirección de arte.',
    'No escribís prosa: devolvés JSON.',
    '',
    'Devolvé SOLO este objeto, sin texto alrededor y sin cercas de código:',
    '{ "clips": [ { "nombre": "<en minúsculas, sin espacios, ej. idle|walk|bat>",',
    '               "etiqueta": "<como lo nombra el documento>",',
    '               "loop": true|false,',
    '               "reglas": "<lo que el documento dice de ESTE movimiento, literal o resumido>" } ] }',
    '',
    'Reglas:',
    '- Solo movimientos que el documento nombre. No completes con los típicos de un juego.',
    '- Locomoción y verbos son clips por igual: caminar es uno, golpear es otro.',
    '',
    'ORDEN — importa, porque abajo hay un tope y lo que quede fuera no se produce:',
    '1. Un solo idle. Si el documento describe variantes (sentado, acicalándose, alerta), el idle',
    '   base va primero y las variantes van AL FINAL de la lista, no seguidas del base.',
    '2. Después la locomoción: caminar, trotar, correr.',
    '3. Después los verbos de acción, que son los que el juego necesita para jugarse.',
    '4. Al final las variantes y lo de personajes secundarios.',
    'Un personaje que puede caminar y golpear es jugable; uno con tres formas de estar quieto, no.',
    '- `reglas` es lo que después define las poses: si el documento da duración, peso, o qué hace',
    '  cada parte del cuerpo, eso es lo que hay que conservar.',
  ].join('\n')

  const res = await callLLM(system, `Documento:\n\n${String(adi).slice(0, 30000)}`,
    { model: MODELO, rawText: true, temperature: 0.1, maxOutputTokens: 4000 })
  const texto = String(res?.data ?? res?.text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')

  let p
  try { p = JSON.parse(texto) } catch {
    throw new Error(`la lectura de clips no devolvió JSON: ${texto.slice(0, 160)}`)
  }
  let clips = (p.clips || []).filter(c => c?.nombre)
  if (!clips.length) throw new Error('el ADI de animación no nombra ningún movimiento')

  // Idle primero, pase lo que pase: lo pide el paquete y es lo que da la pose de reposo. El orden
  // del resto ya viene pedido en el sistema; esto solo asegura la cabeza de la lista.
  const esIdle = c => /^idle/.test(c.nombre)
  const i = clips.findIndex(esIdle)
  if (i > 0) clips.unshift(clips.splice(i, 1)[0])

  const descartados = clips.length > TOPE_CLIPS ? clips.slice(TOPE_CLIPS).map(c => c.nombre) : []
  clips = clips.slice(0, TOPE_CLIPS)

  return { clips, adi, ...(descartados.length ? { descartados } : {}) }
}

/**
 * Los beats de un clip, en el formato exacto que el nodo 2 del workflow espera.
 *
 * El método es de la skill, no de acá. Se carga registrada y se le manda como sistema: si alguien
 * la mejora en R2, esto mejora sin desplegar, que es la razón por la que las skills viven ahí.
 */
async function beatsDeClip({ clip, adi, personaje = null }) {
  const skill = await getSkill(SKILL_BEATS)
  if (!skill) {
    const err = new Error(`Skill "${SKILL_BEATS}" is not registered: beats cannot be composed without its method`)
    err.code = 'SIN_SKILL'
    throw err
  }

  const system = [
    skill,
    '',
    '─────────────────────────────────────────────────────────────',
    'SALIDA PARA ESTE ENCARGO',
    '',
    'Devolvés SOLO los bloques de beats, uno por línea, en este formato y nada más:',
    '',
    'Pose 1 (<nombre de la fase>): <descripción precisa de la postura>',
    'Pose 2 (<nombre de la fase>): <descripción precisa de la postura>',
    '',
    'Sin encabezado, sin numeración extra, sin comentarios, sin cercas de código. La cantidad de',
    'poses la decide el movimiento: el workflow lee tantas columnas como bloques haya y no tiene',
    'tope. Cada descripción es de la POSTURA —dónde está cada parte del cuerpo, el peso, el eje—,',
    'no de la intención narrativa.',
    '',
    'ESCRIBÍ LOS BEATS EN INGLÉS, incluido el nombre de la fase entre paréntesis. El texto viaja a',
    'un modelo de imagen que después rotula la lámina, y el resto de lo que produce la plataforma',
    'está en inglés: una hoja de poses con las columnas en español no se puede entregar junto a las',
    'demás.',
  ].join('\n')

  const user = [
    personaje ? `Personaje: ${personaje}` : '',
    `Movimiento: ${clip.etiqueta || clip.nombre}${clip.loop ? ' (en bucle)' : ''}`,
    clip.reglas ? `\nLo que la dirección de arte dice de este movimiento:\n${clip.reglas}` : '',
    '\nDirección de animación del proyecto, para el estilo general:',
    String(adi).slice(0, 12000),
  ].filter(Boolean).join('\n')

  const res = await callLLM(system, user,
    { model: MODELO, rawText: true, temperature: 0.4, maxOutputTokens: 3000 })
  const texto = String(res?.data ?? res?.text ?? '').trim()
    .replace(/^```\s*/i, '').replace(/```\s*$/, '')

  // Un beats sin un solo bloque «Pose N» no es un beats: el workflow lo mandaría tal cual al
  // modelo de imagen y saldría una lámina sin columnas. Vale más no despachar.
  const bloques = (texto.match(/^\s*Pose\s+\d+\s*\(/gim) || []).length
  if (bloques < 2) {
    throw new Error(`los beats de "${clip.nombre}" no traen bloques «Pose N» (${bloques}): ${texto.slice(0, 120)}`)
  }
  return { texto, poses: bloques }
}

/**
 * La imagen ancla: la vista frontal del personaje, producida por la cadena de Character Sheet.
 *
 * Si hay varias no se elige la más nueva y se sigue: dos personajes resueltos son dos animaciones
 * distintas, y adivinar cuál se anima gasta una lámina por clip en el personaje equivocado. Se
 * nombra el conflicto y se para, que es lo mismo que hace el resto del sistema cuando una
 * referencia es ambigua.
 */
async function anclaDelPersonaje({ db, project_id }) {
  const { data: frentes } = await db().from('forge_assets')
    .select('id, name, storage_url, metadata, created_at')
    .eq('project_id', project_id)
    .eq('metadata->cadena->>rol', 'front')
    .not('storage_url', 'is', null)
    .order('created_at', { ascending: false })

  const vivos = (frentes || []).filter(f => f.metadata?.cadena?.nombre === 'character_sheet')
  if (!vivos.length) {
    const err = new Error('No character front view in this project yet: run the Character Sheet chain first')
    err.code = 'SIN_ANCLA'
    throw err
  }

  // Del mismo job son las tres vistas de UN personaje; jobs distintos son personajes distintos.
  const jobs = [...new Set(vivos.map(f => f.metadata?.job).filter(Boolean))]
  if (jobs.length > 1) {
    const err = new Error(
      `This project has ${jobs.length} characters with a front view (${vivos.map(f => f.name).slice(0, 4).join(', ')}). ` +
      'Animation needs one anchor: run it from the character you want to animate.')
    err.code = 'ANCLA_AMBIGUA'
    throw err
  }

  return { url: vivos[0].storage_url, nombre: vivos[0].name, id: vivos[0].id }
}

module.exports = { clipsDelProyecto, beatsDeClip, adiDeAnimacion, anclaDelPersonaje, TOPE_CLIPS, SKILL_BEATS }
