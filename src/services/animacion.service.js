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
  const fila = await filaDelAdi(db, project_id)
  return fila?.content || null
}

/** La fila entera del ADI de animación: hace falta su `id` y su `metadata` para el caché. */
async function filaDelAdi(db, project_id) {
  const { data: ses } = await db().from('forge_sessions')
    .select('id').eq('project_id', project_id).eq('output_key', 'ADI_11.6_AnimationProduction')
  if (!(ses || []).length) return null
  const { data: docs } = await db().from('forge_assets')
    .select('id, content, metadata, created_at').in('session_id', ses.map(s => s.id))
    .not('content', 'is', null).order('created_at', { ascending: false })
  return docs?.[0] || null
}

// ─── Los clips del PERSONAJE, leídos del Vertical Slice ──────────────────────
//
// Antes se leían del ADI de animación y **a nivel de proyecto**: `clipsDelProyecto` recibía el
// `project_id` y nada más. El ADI de `test_smack_migue_v.09` son 12 KB de prosa que mezclan Moon
// Jelly, Cartón, Sea Nettle y Lumi, así que el extractor se quedaba con un set y no tenía forma de
// saber cuál tocaba. Animando Moon Jelly salieron `idle, walk, run, jump, swing, swing_good,
// swing_miss, crumple`: el set de Cartón. Eso es el punto 1 del informe de JuanK.
//
// El ancla SÍ sabía de qué personaje se trata —`anclaDelPersonaje({ desde })` lo resuelve desde la
// página del Run— y esa información nunca viajaba hasta la lista de clips. Las dos mitades otra vez.
//
// **Decisión de JuanK, 21-09:** manda el Vertical Slice. Ahí los clips viven en una tabla bajo
// `## B4 · Animation`, una fila por movimiento:
//
//     | 13 | Moon Jelly — Idle Pulse (slow rhythmic bell contraction, 60 BPM) | FINAL |
//     | 17 | Exit Door — Open (theatrical swing, 1.5 s sequential panel opening) | FINAL |
//
// El sujeto de cada fila es un personaje O un prop. Se quedan las del personaje del ancla **y las
// que no son de ningún personaje** — también decisión suya: los props se animan, se montan fuera
// como animaciones de props y sus componentes van en el pack. Lo que NO puede pasar es que salga
// un `walk` en la medusa, que es su requisito de fondo.
//
// Esto NO llama al modelo: la tabla ya está escrita. El camino viejo del ADI queda como respaldo
// para los proyectos cuyo Vertical Slice no tenga la sección.

const norma = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

// Palabras que describen QUÉ HAY QUE PRODUCIR, no cómo es el personaje.
const PRODUCCION = /\b(mesh|shader|shaders|animation|animations|rig|rigs|rigging|skinning|texture|textures|material|materials|prefab|prefabs|lod|variant|sheet|clips?)\b/i
// Un código de alcance: UI-01, VFX-15, ITEM-05, ENV-01.
const CODIGO = /^[A-Z]{2,5}-\d{1,3}$/

/**
 * El nombre del personaje, sacado del ítem del alcance.
 *
 * El ítem es una línea de producción, no un nombre: «Moon Jelly × 6 (mesh + shader + animation)».
 * Viajaba TAL CUAL al modelo que escribe el prompt del video —`Personaje: …`— y el modelo leía el
 * «× 6» y dibujaba seis medusas en cuadro. Es el punto 3 del informe v4 de JuanK.
 *
 * Se quitan dos cosas y solo dos:
 *   · el multiplicador `× N`, que cuenta cuántas van en el nivel y nunca es parte de un nombre;
 *   · un paréntesis final que solo hable de producción o sea un código de alcance.
 *
 * El paréntesis NO se quita a ciegas: en la base hay «Koala (Elder)» y «Luma (Axolotl)», donde es
 * parte de la identidad del personaje. Por eso se mira lo que dice dentro, no que exista.
 */
function nombreDePersonaje(item) {
  let s = String(item || '').trim()
  s = s.replace(/\s*[×x]\s*\d+/gi, '')
  s = s.replace(/\s*\(([^()]*)\)\s*$/, (todo, dentro) => {
    const d = String(dentro).trim()
    if (CODIGO.test(d)) return ''
    // Solo si TODO lo de dentro es vocabulario de producción: «mesh + shader + animation» sí,
    // «Elder» no, «VFX-01, VFX-03» sí por los códigos.
    const partes = d.split(/[+,/·]/).map(x => x.trim()).filter(Boolean)
    const todasProduccion = partes.length > 0 &&
      partes.every(x => PRODUCCION.test(x) || CODIGO.test(x))
    return todasProduccion ? '' : todo
  })
  return s.replace(/\s{2,}/g, ' ').trim() || String(item || '').trim()
}

/** Los personajes del proyecto, por el ítem de instancia de sus hojas de Character Sheet. */
async function personajesDelProyecto(db, project_id) {
  const { data: hojas } = await db().from('forge_assets')
    .select('metadata')
    .eq('project_id', project_id)
    .not('metadata->instancia->>item', 'is', null)
  const items = new Set()
  for (const h of hojas || []) {
    const i = h.metadata?.instancia?.item
    if (i && norma(i).length >= 3) items.add(String(i))
  }
  return [...items]
}

/** El documento del nodo 3.13 con más texto: la tabla vive ahí, corriera como corriera el nodo. */
async function vsSpecDelProyecto(db, project_id) {
  const { data: n } = await db().from('forge_nodes').select('id').eq('node_key', '3.13').maybeSingle()
  if (!n) return null
  const { data: docs } = await db().from('forge_assets')
    .select('content')
    .eq('project_id', project_id).eq('node_id', n.id)
    .in('status', ['approved', 'auto_approved'])
    .not('content', 'is', null)
  if (!docs?.length) return null
  return docs.reduce((m, d) => d.content.length > m.content.length ? d : m).content
}

/**
 * Las filas de `B4 · Animation` que le tocan a este personaje.
 *
 * Devuelve `null` —no vacío— cuando el documento no tiene la sección: eso distingue «este proyecto
 * no usa el Vertical Slice para esto» de «este personaje no tiene animaciones», y solo lo primero
 * justifica caer al ADI.
 */
function clipsDeLaTabla(vs, personaje, personajes) {
  if (!vs) return null
  const L = vs.split('\n')
  const i = L.findIndex(l => /^#{1,4}\s*B4\b.*animation/i.test(l))
  if (i < 0) return null
  const j = L.findIndex((l, k) => k > i && /^#{1,4}\s/.test(l))
  const bloque = L.slice(i + 1, j < 0 ? L.length : j)

  const kAncla = norma(personaje)
  const otros = (personajes || []).map(norma).filter(p => p.length >= 3 && p !== kAncla)

  const clips = []
  for (const linea of bloque) {
    if (!/^\s*\|/.test(linea)) continue
    const celdas = linea.split('|').map(c => c.trim()).filter(Boolean)
    // Cabecera y separador de la tabla markdown.
    if (!celdas.length || /^-+$/.test(celdas[0])) continue
    // La celda que trae «Sujeto — Movimiento». Se busca el guión largo, que es lo que los separa.
    const celda = celdas.find(c => /—|–/.test(c))
    if (!celda) continue
    const [sujetoCrudo, ...resto] = celda.split(/—|–/)
    const movimiento = resto.join(' — ').trim()
    if (!movimiento) continue
    const s = norma(sujetoCrudo)
    if (s.length < 2) continue

    // Del personaje del ancla: el nombre de uno contiene al del otro en cualquier dirección — el
    // ítem es «Moon Jelly × 6» y la tabla dice «Moon Jelly».
    const esDelAncla = kAncla.length >= 3 && (s.includes(kAncla) || kAncla.includes(s))
    // De OTRO personaje: fuera. Es exactamente lo que evita el walk en la medusa.
    const esDeOtro = otros.some(o => s.includes(o) || o.includes(s))
    if (!esDelAncla && esDeOtro) continue
    // Ni del ancla ni de otro personaje ⇒ es un prop, y esos también se animan.
    if (!esDelAncla && !esDeOtro && kAncla.length < 3) continue

    // El movimiento a veces trae su descripción entre paréntesis: el nombre es lo de fuera, la
    // descripción son las reglas que después definen las poses.
    const m = movimiento.match(/^([^(]+)(?:\((.*)\))?/)
    const etiqueta = (m?.[1] || movimiento).trim()
    const reglas = (m?.[2] || '').trim()
    // El prop lleva su sujeto DENTRO del nombre: la tabla tiene «Exit Door — Open» y «Standard
    // Lever — Activate», y con solo el movimiento los dos se llamarían igual de genérico y dos
    // props con «Activate» colisionarían en una sola clave. El personaje no lo necesita: todos sus
    // clips son suyos y el nombre del personaje ya va en la ruta del archivo.
    const nombre = (esDelAncla ? norma(etiqueta) : `${norma(sujetoCrudo)}_${norma(etiqueta)}`).slice(0, 40)
    if (!nombre) continue
    if (clips.some(c => c.nombre === nombre)) continue

    clips.push({
      nombre,
      etiqueta,
      loop: /idle|loop|pulse/i.test(etiqueta),
      reglas: reglas || movimiento,
      sujeto: sujetoCrudo.trim(),
      es_prop: !esDelAncla,
    })
  }
  return clips
}

/**
 * Los clips que hay que animar.
 *
 * Primero el Vertical Slice acotado al personaje del ancla (decisión de JuanK, 21-09); si ese
 * documento no tiene la sección `B4 · Animation`, se cae al ADI como antes.
 */
async function clipsDelPersonaje({ db, project_id, desde = null, refrescar = false, soloCache = false }) {
  // Sin ancla no hay a quién acotar, y acotar mal cuesta una lámina pagada por clip. Se sigue al
  // camino viejo, que al menos es el comportamiento conocido.
  if (desde) {
    const [vs, personajes] = await Promise.all([
      vsSpecDelProyecto(db, project_id),
      personajesDelProyecto(db, project_id),
    ])

    // Quién se anima sale de la PÁGINA DEL RUN, no de la imagen ancla. Es la regla de JuanK —
    // *«si hay 2 o más páginas del mismo personaje, solo use la página del run»*— y hace falta que
    // sean dos cosas distintas: en `test_smack_migue_v.09` la vista frontal de Cartón es la
    // genérica «Character Sheet — 18_CharacterSheet — Concept art — front», cuya hoja madre no
    // declara ningún ítem. Por la imagen, Cartón no tiene nombre; por la página del Run —«Cartón
    // rig + all animations»— está dicho. Atar la lista de clips a la imagen dejaba a Cartón sin
    // acotar y cayendo al ADI, que es el fallo original.
    //
    // Se elige el ítem MÁS LARGO que la página contenga: «Cartón rig + all animations» describe
    // mejor de qué página se trata que «Cartón» a secas, y para comparar contra la tabla da igual
    // —uno contiene al otro—. Si ninguno encaja, el ítem del ancla como respaldo.
    const k = norma(desde)
    const personaje = personajes
      .filter(p => norma(p).length >= 3 && k.includes(norma(p)))
      .sort((a, b) => norma(b).length - norma(a).length)[0]
      ?? await anclaDelPersonaje({ db, project_id, desde }).then(a => a?.item).catch(() => null)

    if (personaje) {
      const clips = clipsDeLaTabla(vs, personaje, personajes)
      if (clips?.length) {
        const descartados = clips.length > TOPE_CLIPS ? clips.slice(TOPE_CLIPS).map(c => c.nombre) : []
        return {
          clips: clips.slice(0, TOPE_CLIPS), descartados, de_cache: false,
          fuente: 'vertical_slice', personaje,
        }
      }
    }
  }
  return clipsDelProyecto({ db, project_id, refrescar, soloCache })
}

/**
 * Los clips que hay que animar, leídos del ADI. RESPALDO: ver `clipsDelPersonaje`.
 *
 * El modelo no los inventa: extrae los que el documento nombra. Un clip que no esté en el ADI no
 * tiene reglas de movimiento, y sin reglas los beats salen genéricos — que es exactamente lo que
 * la skill de coreografía existe para evitar.
 */
async function clipsDelProyecto({ db, project_id, refrescar = false, soloCache = false }) {
  const fila = await filaDelAdi(db, project_id)
  const adi = fila?.content || null

  // La lista se guarda junto al documento del que sale, con la huella de ese documento. Leerla
  // cuesta una llamada al modelo, y quien abre el recuadro del Run para ELEGIR qué animaciones
  // correr no puede pagar por abrirlo. Si el ADI cambia, la huella deja de casar y se vuelve a
  // leer — el caché no puede sobrevivir al documento que lo originó.
  const huella = adi ? `${adi.length}:${adi.slice(0, 64)}` : null
  const cache = fila?.metadata?.clips_cache
  if (!refrescar && cache?.huella && cache.huella === huella) {
    return { clips: cache.clips, adi, descartados: cache.descartados || [], de_cache: true }
  }
  // `soloCache` es para quien solo quiere enseñar la lista: prefiere no tenerla a pagar por ella.
  if (soloCache) return { clips: [], descartados: [], de_cache: false, sin_leer: true }

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

  // Al lado del documento que la originó, con su huella. La siguiente vez que alguien abra el
  // recuadro para elegir animaciones, la lista sale gratis.
  if (fila?.id) {
    const metadata = { ...(fila.metadata || {}), clips_cache: { clips, descartados, huella, en: new Date().toISOString() } }
    const { error } = await db().from('forge_assets').update({ metadata }).eq('id', fila.id)
    if (error) console.warn('[clips] no se pudo guardar el caché (no es fatal):', error.message)
  }

  return { clips, adi, descartados, de_cache: false }
}

/**
 * Los beats de un clip, en el formato exacto que el nodo 2 del workflow espera.
 *
 * El método es de la skill, no de acá. Se carga registrada y se le manda como sistema: si alguien
 * la mejora en R2, esto mejora sin desplegar, que es la razón por la que las skills viven ahí.
 */
/**
 * El prompt de video de UN movimiento, y cuánto dura.
 *
 * Es la Fase 2 y la Fase 3 del proceso de JuanK en una sola llamada, y van juntas a propósito:
 * las dos salen de la MISMA caracterización del personaje —complexión, peso aparente, energía— y
 * pedirlas por separado significaría deducir esa caracterización dos veces y arriesgar que la
 * segunda no coincida con la primera. Un personaje grande y pesado se mueve más lento y asienta
 * más los golpes; uno pequeño y ágil rebota. El mismo razonamiento decide cómo se describe el
 * movimiento y cuántos segundos dura.
 *
 * Las convenciones son las suyas, literales: inglés, un párrafo descriptivo y no una lista, el
 * personaje descrito AL INICIO —el modelo de video no tiene memoria de otros prompts—, encuadre y
 * luz consistentes entre movimientos para que los clips sean comparables, y la duración FUERA del
 * texto, porque es un parámetro aparte del workflow.
 */
async function promptDeVideo({ clip, adi, personaje = null, referencia = null }) {
  const system = [
    'Escribís el prompt de un modelo de imagen-a-video para UN movimiento de un personaje de juego.',
    'No escribís prosa alrededor: devolvés JSON.',
    '',
    'Devolvé SOLO este objeto, sin texto alrededor y sin cercas de código:',
    '{ "prompt": "<un párrafo en INGLÉS>", "segundos": <número>, "estimado": true|false }',
    '',
    'EL PÁRRAFO:',
    '- En inglés, UN párrafo descriptivo. No una lista de instrucciones ni viñetas.',
    '- Empieza SIEMPRE describiendo al personaje —silueta, materiales, escala— y recién después la',
    '  acción. El modelo no recuerda otros prompts: cada uno se lee solo.',
    '- Encuadre de cámara, fondo y luz consistentes entre movimientos del mismo personaje, para que',
    '  los clips queden comparables entre sí.',
    '- NO escribas la duración en el texto. Es un parámetro aparte.',
    '- Si el documento fija una regla de deformación para este personaje (p. ej. «cero',
    '  squash-and-stretch»), repetila explícitamente: el modelo no la infiere sola.',
    '',
    'LOS SEGUNDOS:',
    '- Salen de la complexión y la energía del personaje aplicadas a ESTE movimiento, no de un',
    '  valor por defecto igual para todos.',
    '- `estimado: false` solo si el documento da un tiempo para este movimiento. Si lo dedujiste',
    '  vos, `estimado: true` — hay que poder distinguir el dato duro del criterio aplicado.',
  ].join('\n')

  const usuario = [
    personaje ? `Personaje: ${personaje}` : null,
    referencia ? `Referencia visual de la que sale el video: ${referencia}` : null,
    `Movimiento: ${clip.etiqueta || clip.nombre}`,
    clip.loop != null ? `¿Cicla? ${clip.loop ? 'sí' : 'no'}` : null,
    clip.reglas ? `Lo que el documento dice de este movimiento:\n${clip.reglas}` : null,
    '',
    'Documento de dirección de animación:',
    String(adi || '').slice(0, 24000),
  ].filter(Boolean).join('\n')

  const res = await callLLM(system, usuario, { model: MODELO, rawText: true, temperature: 0.4, maxOutputTokens: 2000 })
  const texto = String(res?.data ?? res?.text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')

  let p
  try { p = JSON.parse(texto) } catch {
    throw new Error(`el prompt de video no volvió como JSON: ${texto.slice(0, 160)}`)
  }
  if (!p.prompt || !String(p.prompt).trim()) throw new Error('el prompt de video volvió vacío')

  // Los segundos se acotan: el modelo cobra por duración y un 30 inventado es una corrida cara y
  // sin sentido. Cinco es el valor con el que viene el workflow, así que es el respaldo honesto.
  const seg = Number(p.segundos)
  const segundos = Number.isFinite(seg) && seg >= 1 && seg <= 12 ? Math.round(seg * 10) / 10 : 5

  return { texto: String(p.prompt).trim(), segundos, estimado: p.estimado !== false }
}

async function beatsDeClip({ clip, adi, personaje = null }) {
  const skill = await getSkill(SKILL_BEATS)
  if (!skill) {
    const err = new Error(`Skill "${SKILL_BEATS}" is not registered: beats cannot be composed without its method`)
    err.code = 'SIN_SKILL'
    throw err
  }

  // La skill YA define el archivo de beats entero —`movement`, `loop` y `beats[]` con `index`,
  // `role`, `description`, `trajectory_notes` y `timing_weight`— y acá se le pedía texto plano:
  // «devolvé SOLO los bloques Pose N». O sea que el `trajectory_notes` se pensaba y se tiraba en
  // la misma llamada, y el archivo que Cascadeur necesita después no existía en ninguna parte.
  // Es el punto 2 del informe de JuanK, y la causa era nuestra, no de la skill.
  //
  // Ahora se le deja emitir SU json. Las líneas «Pose N» que el nodo 2 del workflow espera se
  // derivan de ahí, así que ComfyUI recibe exactamente lo mismo que antes y la lámina no cambia.
  const system = [
    skill,
    '',
    '─────────────────────────────────────────────────────────────',
    'SALIDA PARA ESTE ENCARGO',
    '',
    'Devolvés SOLO el archivo de beats en JSON, tal como lo define el método de arriba:',
    '`movement`, `loop` y `beats[]` con `index`, `role`, `description`, `trajectory_notes` y',
    '`timing_weight`. Sin comentarios y sin texto alrededor; las cercas de código se aceptan.',
    '',
    'La cantidad de beats la decide el movimiento: el workflow lee tantas columnas como beats haya',
    'y no tiene tope. `description` es de la POSTURA y solo de lo que una imagen puede mostrar;',
    'todo lo espacial —altura del root, contacto con el piso, desplazamiento, asimetrías— va en',
    '`trajectory_notes`, que es lo que consume Cascadeur después.',
    '',
    'ESCRIBÍ `role` Y `description` EN INGLÉS. Ese texto rotula las columnas de la lámina y el',
    'resto de lo que produce la plataforma está en inglés; JuanK lo confirmó el 15-09.',
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
  const crudo = String(res?.data ?? res?.text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')

  return beatsDesdeJson(crudo, clip)
}

/** Las líneas que el nodo 2 del workflow espera, derivadas de los beats. */
const lineasDeBeats = beats => beats
  .map((b, i) => `Pose ${b.index ?? i + 1} (${b.role || 'beat'}): ${b.description}`)
  .join('\n')

/**
 * Valida el archivo de beats y devuelve las dos formas: el json que se guarda y el texto que se
 * despacha.
 *
 * Se exige lo mismo que antes —dos beats como mínimo— y además que cada uno traiga su descripción:
 * un beats con celdas vacías produce una lámina con columnas en blanco, que se paga igual.
 * `trajectory_notes` puede venir vacío, que es lo que la propia skill permite cuando no aplica.
 */
function beatsDesdeJson(crudo, clip = {}) {
  let doc
  // Las cercas se quitan acá y no solo en quien compone: por este mismo sitio entra el archivo que
  // alguien sube a mano, y copiarlo de un chat con ```json alrededor es lo más probable del mundo.
  const limpio = typeof crudo === 'string'
    ? crudo.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    : crudo
  try { doc = typeof limpio === 'string' ? JSON.parse(limpio) : limpio } catch {
    throw new Error(`los beats de "${clip.nombre || '?'}" no son JSON válido: ${String(limpio).slice(0, 120)}`)
  }
  const beats = Array.isArray(doc?.beats) ? doc.beats : null
  if (!beats || beats.length < 2) {
    throw new Error(`los beats de "${clip.nombre || '?'}" traen ${beats ? beats.length : 0} beats: hacen falta al menos dos`)
  }
  const sinTexto = beats.filter(b => !String(b?.description || '').trim())
  if (sinTexto.length) {
    throw new Error(`${sinTexto.length} beat(s) de "${clip.nombre || '?'}" no traen description`)
  }

  const json = {
    movement: doc.movement || clip.nombre || 'movement',
    loop: typeof doc.loop === 'boolean' ? doc.loop : Boolean(clip.loop),
    beats: beats.map((b, i) => ({
      index: b.index ?? i + 1,
      role: b.role || `beat ${i + 1}`,
      description: String(b.description).trim(),
      // Vacío es una respuesta: la skill dice que va '' cuando genuinamente no aplica. Lo que no
      // puede es faltar, porque es el campo que Cascadeur lee.
      trajectory_notes: String(b.trajectory_notes ?? '').trim(),
      timing_weight: b.timing_weight || 'rapido',
    })),
  }

  return { texto: lineasDeBeats(json.beats), poses: json.beats.length, json }
}

/**
 * La imagen ancla: la vista frontal del personaje, producida por la cadena de Character Sheet.
 *
 * Si hay varias no se elige la más nueva y se sigue: dos personajes resueltos son dos animaciones
 * distintas, y adivinar cuál se anima gasta una lámina por clip en el personaje equivocado. Se
 * nombra el conflicto y se para, que es lo mismo que hace el resto del sistema cuando una
 * referencia es ambigua.
 */
async function anclaDelPersonaje({ db, project_id, desde = null }) {
  const { data: frentes } = await db().from('forge_assets')
    .select('id, name, storage_url, metadata, derived_from_id, created_at')
    .eq('project_id', project_id)
    .eq('metadata->cadena->>rol', 'front')
    .not('storage_url', 'is', null)
    .order('created_at', { ascending: false })

  // Una pieza hecha con una HERRAMIENTA no es otro personaje.
  //
  // New angle sobre una vista frontal devuelve OTRA VISTA del mismo personaje, y Segmentation
  // devuelve ese mismo personaje recortado. Desde el 22-09 esas piezas heredan el sello de su
  // madre —`rol: 'front'` incluido, que es lo correcto para que la cadena las reconozca— y de
  // golpe el proyecto de Migue pasó a declarar OCHO vistas frontales donde hay dos: seis eran
  // ángulos nuevos del mismo Cartón. Con ocho «personajes» la desambiguación no puede elegir y
  // para, que es el aviso que JuanK reporta en el v3·2, el v4·1 y el v5·4.
  //
  // Se cuentan solo las que produjo la CADENA. Si no quedara ninguna se vuelve a la lista entera:
  // más vale un ancla derivada que ninguna.
  const todas = (frentes || []).filter(f => f.metadata?.cadena?.nombre === 'character_sheet')
  const deLaCadena = todas.filter(f => !f.metadata?.herramienta)
  const vivos = deLaCadena.length ? deLaCadena : todas
  if (!vivos.length) {
    const err = new Error('No character front view in this project yet: run the Character Sheet chain first')
    err.code = 'SIN_ANCLA'
    throw err
  }

  // ── Acotar por la instancia de la que se corre ──────────────────────────────
  //
  // Corriendo desde «Art Style Guide — 24_AnimationSheet — Cartón rig + all animations», el
  // personaje está DICHO: es Cartón. No hace falta que nadie lo elija, y preguntarlo cuando el
  // dato está escrito es exactamente lo que hace que una prueba se detenga.
  //
  // Se ACOTA, nunca se adivina: se filtra por el nombre de la instancia y solo se usa el resultado
  // si queda uno. Con cero o con varios se sigue al conflicto de abajo, que ahora sí se lee en
  // pantalla. Cada clip es una lámina pagada y animar al personaje equivocado cuesta ocho.
  //
  // Es la misma regla de nombres del menú de alcance: la cadena arrastra el nombre de su hoja de
  // origen, así que la pieza del personaje lo lleva dentro. La genérica —«Character Sheet —
  // 18_CharacterSheet — Concept art — front»— no nombra a nadie y queda fuera sola, que es
  // justo lo que deshace el empate del proyecto de Migue.
  let candidatos = vivos
  const k = String(desde || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (k.length >= 3) {
    // De qué personaje es cada vista frontal. NO se lee de su propio nombre: se sube un salto por
    // `derived_from_id` hasta la hoja del ASG de la que salió, que es la que lleva escrito el ítem
    // del alcance. Medido el 18-09 en test_smack_migue_v.09:
    //
    //   «Character Sheet — 18_CharacterSheet — Moon Jelly × 6 — Concept art — front»
    //     ↑ «Art Style Guide — 18_CharacterSheet — Moon Jelly × 6»   instancia: Moon Jelly × 6
    //   «Character Sheet — 18_CharacterSheet — Concept art — front»
    //     ↑ «Art Style Guide — 18_CharacterSheet»                    instancia: —
    //
    // La genérica no nombra a nadie y queda fuera sola, que es lo que deshace el empate. Por el
    // nombre de la pieza no salía: «Moon Jelly × 6 (mesh + shader + animation)» es el ítem de la
    // hoja de ANIMACIÓN y no encaja con el de la de personaje, que es «Moon Jelly × 6» a secas.
    const madres = [...new Set(vivos.map(f => f.derived_from_id).filter(Boolean))]
    const item = new Map()
    if (madres.length) {
      const { data: hojas } = await db().from('forge_assets')
        .select('id, metadata').in('id', madres)
      for (const h of hojas || []) {
        const i = h.metadata?.instancia?.item
        // El ítem SIN normalizar además del normalizado: el normalizado sirve para comparar, pero
        // lo que hace falta aguas abajo —acotar la tabla del Vertical Slice y nombrar el archivo—
        // es el nombre tal como está escrito, «Moon Jelly × 6».
        if (i) item.set(h.id, { k: String(i).toLowerCase().replace(/[^a-z0-9]+/g, ''), item: String(i) })
      }
    }
    // El personaje está DENTRO de la pista: «Cartón» dentro de «Cartón rig + all animations».
    const suyos = vivos.filter(f => {
      const i = item.get(f.derived_from_id)
      return i && i.k.length >= 3 && k.includes(i.k)
    })
    if (suyos.length === 1) {
      return {
        url: suyos[0].storage_url, nombre: suyos[0].name, id: suyos[0].id, por: 'instancia',
        item: item.get(suyos[0].derived_from_id)?.item ?? null,
      }
    }

    // Y si ninguna lleva el nombre: por ELIMINACIÓN.
    //
    // No todas las vistas frontales dicen de quién son. En el proyecto de Migue, la de Moon Jelly
    // sale de una hoja instanciada y lo declara; la de Cartón sale de la hoja genérica
    // —«Character Sheet — 18_CharacterSheet — Concept art — front»— y no declara nada. Corriendo
    // desde «Cartón rig + all animations» no había ninguna que dijera «Cartón», así que se paraba
    // por ambigüedad teniendo delante una sola candidata posible.
    //
    // Se descartan las que se sabe que son de OTRO —su ítem está declarado y no es el de la
    // página— y si queda exactamente una, ésa es. Es eliminar, no adivinar: si quedan dos o más
    // se sigue al conflicto de abajo, como antes.
    if (!suyos.length) {
      const deOtro = new Set(vivos.filter(f => {
        const i = item.get(f.derived_from_id)
        return i && i.k.length >= 3 && !k.includes(i.k)
      }))
      const resto = vivos.filter(f => !deOtro.has(f))
      if (resto.length === 1) {
        return {
          url: resto[0].storage_url, nombre: resto[0].name, id: resto[0].id, por: 'eliminación',
          item: item.get(resto[0].derived_from_id)?.item ?? null,
        }
      }
      if (resto.length) candidatos = resto
    }
    // Con varios se sigue acotado; con ninguno se deja la lista entera, para que el conflicto que
    // se nombre abajo sea el real y no uno recortado por una pista que no sirvió.
    if (suyos.length > 1) candidatos = suyos
  }

  // Del mismo job son las tres vistas de UN personaje; jobs distintos son personajes distintos.
  const jobs = [...new Set(candidatos.map(f => f.metadata?.job).filter(Boolean))]
  if (jobs.length > 1) {
    const err = new Error(
      `This project has ${jobs.length} characters with a front view (${candidatos.map(f => f.name).slice(0, 4).join(', ')}). ` +
      'Animation needs one anchor: run it from the character you want to animate.')
    err.code = 'ANCLA_AMBIGUA'
    throw err
  }

  // Sin empate no hizo falta subir a la hoja madre, pero el ítem sigue haciendo falta aguas abajo.
  // Se busca ahora, para el único candidato, en vez de repetir el mapa entero de antes.
  let itemUnico = null
  if (candidatos[0].derived_from_id) {
    const { data: madre } = await db().from('forge_assets')
      .select('metadata').eq('id', candidatos[0].derived_from_id).maybeSingle()
    itemUnico = madre?.metadata?.instancia?.item ?? null
  }

  return {
    url: candidatos[0].storage_url, nombre: candidatos[0].name, id: candidatos[0].id, por: 'único',
    item: itemUnico,
  }
}

/**
 * Guarda `<clip>_beats.json` como pieza del proyecto y devuelve su enlace.
 *
 * Va a almacenamiento y además queda como activo: el archivo lo consume una persona —lo baja para
 * Cascadeur— y un enlace que solo vive en la respuesta de una petición no lo encuentra nadie dos
 * días después. El contenido viaja también en `content`, para poder leerlo sin descargarlo.
 */
async function guardarBeats({ db, project_id, node_id = null, clip, json, member_id = null, derivadoDe = null }) {
  const { uploadToStorage } = require('./storage.service')
  const texto = JSON.stringify(json, null, 2)
  const url = await uploadToStorage(
    Buffer.from(texto, 'utf8'),
    `projects/${project_id}/beats/${clip}_beats.json`,
    'application/json; charset=utf-8')

  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id, output_key: null, status: 'auto_approved', iteration_count: 1,
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id,
  }).select('id').single()

  const { data: activo, error } = await db().from('forge_assets').insert({
    project_id, node_id, session_id: ses?.id || null,
    name: `${clip}_beats.json`,
    format: 'json', mime_type: 'application/json',
    storage_url: url, content: texto,
    status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
    // Cuelga de la hoja que lo originó: en el lienzo el archivo aparece junto a su Animation
    // Sheet, que es donde alguien lo va a buscar. Suelto, cae en el bloque del nodo y se pierde.
    ...(derivadoDe ? { derived_from_id: derivadoDe } : {}),
    // `origen` distingue este archivo de uno que subió una persona. Sin esa marca, la corrida
    // siguiente lo encuentra por nombre y lo toma por manual: el clip se queda congelado en sus
    // primeros beats para siempre y nada lo dice.
    metadata: { beats: { clip, poses: json.beats.length, loop: json.loop, para: 'cascadeur', origen: 'skill' } },
  }).select('id, name, storage_url').single()
  if (error) console.warn(`[beats] no se pudo registrar ${clip}_beats.json: ${error.message}`)

  return { url, asset_id: activo?.id || null }
}

module.exports = {
  nombreDePersonaje, clipsDelProyecto, clipsDelPersonaje, personajesDelProyecto, beatsDeClip, beatsDesdeJson, guardarBeats, lineasDeBeats, promptDeVideo,
  adiDeAnimacion, anclaDelPersonaje, TOPE_CLIPS, SKILL_BEATS,
}
