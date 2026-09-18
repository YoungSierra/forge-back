// ─── Las medidas del GDD, para montar a escala real ──────────────────────────
//
// Del documento de JuanK del 18-09 («Forge — Exportar inputs y recibir el montaje»): el `.zip` del
// montaje lleva un `medidas.json` con las dimensiones que el GDD declara, cada una con su valor en
// metros y de qué parte del GDD sale.
//
// La regla que él fija, y que decide todo el diseño de esto: **cada número viene con su `fuente`,
// así nadie tiene que inventar una medida**. Por eso acá no se deduce nada de la prosa ni se
// completa con valores típicos de un juego: se extrae lo que el documento DICE, y si no dice nada,
// se devuelve vacío y el montaje usa su escala estándar —puerta de 1,90 m— sabiendo que la usa.
//
// El manifiesto de hoy declaraba `altura_personaje_m: 1.8` con la fuente «valor por defecto (el 3.6
// no publica una medida real)». O sea que se estaba montando a escala genérica y el `.zip` lo
// decía, pero nadie lo leía. Esto va a buscar la medida de verdad antes de caer ahí.

const { callLLM } = require('./llm.service')

const MODELO = process.env.MEDIDAS_GDD_MODEL || 'anthropic:claude-sonnet-4-6'

/** La escala de respaldo que fija JuanK: si no hay medidas, una puerta mide 1,90 m. */
const RESPALDO = {
  altura_puerta: { valor_m: 1.90, fuente: 'escala estándar — el GDD no declara medidas' },
}

/** El GDD del proyecto, o null. Se prefiere el ensamblado; el `gdd_ref` es el respaldo. */
async function documentoDelGDD(db, project_id) {
  const { data: n } = await db().from('forge_nodes').select('id').eq('node_key', '3.8').maybeSingle()
  if (!n) return null
  const { data: docs } = await db().from('forge_assets')
    .select('name, content, output_key, created_at')
    .eq('project_id', project_id).eq('node_id', n.id)
    .in('status', ['approved', 'auto_approved']).not('content', 'is', null)
    .order('created_at', { ascending: false })
  if (!(docs || []).length) return null
  return docs.find(d => d.output_key === 'gdd_complete')
      || docs.find(d => d.output_key === 'gdd_ref')
      || docs[0]
}

/**
 * Las dimensiones en metros que el GDD declara, con su procedencia.
 *
 * Devuelve el objeto tal como lo especifica JuanK:
 *
 *   { "altura_personaje": { "valor_m": 1.80, "fuente": "GDD, sección Personaje" }, … }
 *
 * Nunca inventa. Un juego que no habla de metros devuelve `{}` y el `.zip` sale con el respaldo
 * declarado como respaldo — que es información, no un hueco.
 */
async function medidasDelGDD({ db, project_id }) {
  const doc = await documentoDelGDD(db, project_id)
  if (!doc?.content) {
    return { medidas: RESPALDO, fuente: null, de_respaldo: true, motivo: 'this project has no assembled GDD yet' }
  }

  const system = [
    'Extraés DIMENSIONES FÍSICAS de un documento de diseño de videojuego.',
    'No escribís prosa: devolvés JSON.',
    '',
    'Devolvé SOLO este objeto, sin texto alrededor y sin cercas de código:',
    '{ "medidas": { "<nombre_en_minusculas_con_guion_bajo>": { "valor_m": <número>, "fuente": "<dónde lo dice el documento>" } } }',
    '',
    'Reglas — la más importante primero:',
    '- SOLO medidas que el documento DECLARE. No completes con valores típicos de un juego, no',
    '  deduzcas de una descripción («un pasillo estrecho» no es una medida) y no conviertas una',
    '  proporción en metros. Si el documento no da dimensiones, devolvé { "medidas": {} }.',
    '- `valor_m` SIEMPRE en metros. Si el documento habla en centímetros, unidades de motor o pies,',
    '  convertí y decilo en la `fuente`.',
    '- `fuente` nombra la sección o el sitio del documento donde está la medida. Es lo que permite',
    '  volver a comprobarla: sin eso el número no sirve.',
    '- La más importante es la altura del personaje jugable. Después entran las demás que existan:',
    '  altura de puerta, ancho de pasillo, alto de escalón, altura de techo, ancho de plataforma…',
    '- Una medida por concepto. Si el documento da un rango, tomá el valor representativo y decí en',
    '  la `fuente` que era un rango.',
    '',
    'SOLO LONGITUDES. Esto sirve para construir un nivel a escala, así que entra lo que se puede',
    'medir con una cinta métrica: alto, ancho, largo, radio, distancia, separación, espesor.',
    'NO entran, aunque el documento las dé en metros:',
    '- velocidades ni aceleraciones (m/s, m/s²) — «corre a 6 m/s» NO es una dimensión;',
    '- áreas ni volúmenes (m², m³);',
    '- duraciones, ángulos, pesos, porcentajes ni cantidades.',
    'Un número cuya unidad no sea el metro a secas se descarta, por muy tentador que parezca.',
  ].join('\n')

  // 12000 y no 2000. Con 2000 el GDD de 13_lives devolvió medidas de verdad —«altura_camara_
  // personaje: 0.18»— y se cortó a media cadena: el JSON no parseaba y el proyecto quedaba
  // marcado como «no declara medidas» teniéndolas. Medido: ese documento declara TREINTA Y TRES
  // dimensiones, cada una con su cita del GDD. No cabían. El corte no era incapacidad, era
  // presupuesto — la misma trampa de siempre.
  const res = await callLLM(system, `Documento:\n\n${String(doc.content).slice(0, 40000)}`,
    { model: MODELO, rawText: true, temperature: 0.1, maxOutputTokens: 12000 })
  const texto = String(res?.data ?? res?.text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')

  let p
  try { p = JSON.parse(texto) } catch (e) {
    // El AVISO enseña el final, no el principio. Un JSON que se cortó por presupuesto empieza
    // perfecto y falla en la última línea: mirando los primeros 120 caracteres parecía que el
    // modelo había contestado cualquier cosa, y lo que pasaba era que no le alcanzó el aire.
    console.warn(`[medidas] el GDD no devolvió JSON (${texto.length} chars, ${e.message}). Final: …${texto.slice(-160)}`)
    return { medidas: RESPALDO, fuente: doc.name, de_respaldo: true, motivo: 'the measurement read did not return JSON' }
  }

  // Se limpia lo que no sea un número usable: un «valor_m» nulo o un texto es peor que no tener la
  // medida, porque el montaje lo tomaría como cero.
  const medidas = {}
  for (const [k, v] of Object.entries(p.medidas || {})) {
    const n = Number(v?.valor_m)
    if (!Number.isFinite(n) || n <= 0 || n > 1000) continue
    medidas[k] = { valor_m: Math.round(n * 1000) / 1000, fuente: String(v.fuente || doc.name) }
  }

  if (!Object.keys(medidas).length) {
    return { medidas: RESPALDO, fuente: doc.name, de_respaldo: true, motivo: 'the GDD declares no physical dimensions' }
  }
  return { medidas, fuente: doc.name, de_respaldo: false, motivo: null }
}

module.exports = { medidasDelGDD, documentoDelGDD, RESPALDO }
