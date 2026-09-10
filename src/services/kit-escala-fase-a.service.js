// ─── Fase A · el grafo de proporciones, leído de la imagen ───────────────────
//
// La única parte del escalado que no es aritmética. Un modelo con visión mira el Environment
// Sheet —o el Character Sheet, o una página del Art Style Guide donde varios objetos del kit
// aparezcan JUNTOS— y estima, para cada par comparable, cuánto mide uno respecto del otro. No
// metros: proporciones.
//
// Antes esto lo hacía un módulo físico de greybox construido a mano. El equipo estableció que eso
// no va a existir en proyectos nuevos, así que la única fuente es la imagen — y por eso el método
// se escribió como skill (`forge_scale_anchor_protocol`), para que se ejecute igual entre niveles
// y entre personas.
//
// Lo que este servicio NO hace: convertir proporciones en metros. Eso es la Fase B, es
// determinista y vive en `kit-escala.service`. Acá el modelo no ve una sola medida real, para que
// no pueda inventarlas.

const { callLLM } = require('./llm.service')
const { collectVisualRefs } = require('./vision.service')
const { getSkill } = require('./prompt.service')

const MODELO = process.env.KIT_SCALE_MODEL || 'anthropic:claude-sonnet-4-6'

// Si la skill todavía no está registrada en R2, el método no se improvisa: se aborta. Un grafo de
// proporciones leído sin protocolo es un grafo que nadie puede auditar después.
async function protocolo() {
  const s = await getSkill('forge_scale_anchor_protocol')
  if (!s) throw new Error('la skill "forge_scale_anchor_protocol" no está registrada: sin ella no se corre la Fase A')
  return s
}

/**
 * @param {object[]} objetos  `{ id, descripcion? }` — los objetos del kit que hay que proporcionar
 * @param {object[]} laminas  `{ label, imageUrl }` — las imágenes donde aparecen juntos
 * @param {object}   opciones `{ declaradas }` — medidas ya declaradas en el ADD, si las hay
 */
async function proponerGrafo({ objetos, laminas, declaradas = [] }) {
  if (!objetos?.length) throw new Error('no hay objetos que proporcionar')
  if (!laminas?.length) throw new Error('no hay ninguna lámina donde leer las proporciones')

  const { images, nota } = await collectVisualRefs(
    laminas.map(l => ({ label: l.label, isImage: true, imageUrl: l.imageUrl })),
  )
  if (!images.length) throw new Error('ninguna de las láminas se pudo cargar como imagen')

  const system = [
    await protocolo(),
    '',
    '## Formato de salida',
    'Responde SOLO con un objeto JSON, sin texto alrededor y sin cercas de código:',
    '{',
    '  "grafo_de_proporciones": [ { "de": "<id>", "a": "<id>", "proporcion": <número>, "leida_en": "<etiqueta de la lámina>", "confianza": "alta|media|baja", "por_que": "<qué se comparó>" } ],',
    '  "ancla": { "objeto_id": "<id>", "eje": "y", "valor_m": <número>, "metodo": "declarado|clase_canonica|reticula", "justificacion": "<de dónde sale la medida>" },',
    '  "descartadas": [ { "par": "<id> / <id>", "por_que": "<escorzo, oclusión, planos distintos, prop estilizado>" } ]',
    '}',
    '',
    'Reglas que no se negocian:',
    '- Los `id` salen de la lista que se te da. No inventes objetos ni renombres.',
    '- `proporcion` es tamaño(de) ÷ tamaño(a), leído en la misma dimensión, casi siempre la altura.',
    '- Si un par no es comparable —distinto plano de profundidad, oclusión, gran angular, un prop',
    '  deliberadamente estilizado— NO lo estimes: va en `descartadas` con el motivo.',
    '- El ancla es UN objeto. Si alguna medida viene declarada abajo, ese objeto es el ancla y el',
    '  método es "declarado". Si no hay ninguna, elegí una clase arquitectónica estándar (puerta,',
    '  ventana, escalón) y marcá "clase_canonica", que es el método menos fiable.',
    '- El eje es siempre la altura.',
  ].join('\n')

  const user = [
    'Objetos del kit:',
    ...objetos.map(o => `- ${o.id}${o.descripcion ? ` — ${o.descripcion}` : ''}`),
    '',
    declaradas.length
      ? 'Medidas reales DECLARADAS en el Art Direction Document (usá una de estas como ancla):\n'
        + declaradas.map(d => `- ${d.objeto_id}: ${d.valor_m} m — ${d.fuente || 'ADD'}`).join('\n')
      : 'No hay ninguna medida real declarada en el Art Direction Document: el ancla va a tener que salir de una clase estándar, y hay que marcarlo así.',
    '',
    `Láminas adjuntas: ${images.map(i => i.nombre).join(', ')}`,
    nota || '',
  ].filter(Boolean).join('\n')

  const res = await callLLM(system, user, {
    model: MODELO, images, rawText: true, temperature: 0.2, maxOutputTokens: 4000,
  })
  const texto = String(res?.data ?? res?.text ?? '').trim()

  let json
  try {
    // El modelo puede devolverlo entre cercas aunque se le pida que no.
    const limpio = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    json = JSON.parse(limpio)
  } catch {
    throw new Error(`la Fase A no devolvió JSON legible: ${texto.slice(0, 200)}`)
  }

  // Nada que el modelo nombre y no exista puede entrar: un id inventado rompe el grafo en silencio.
  const conocidos = new Set(objetos.map(o => o.id))
  const fuera = []
  const grafo = (json.grafo_de_proporciones || []).filter(e => {
    const ok = conocidos.has(e.de) && conocidos.has(e.a) && e.proporcion > 0
    if (!ok) fuera.push(`${e.de}/${e.a}`)
    return ok
  })
  if (json.ancla && !conocidos.has(json.ancla.objeto_id)) {
    throw new Error(`la Fase A ancló en "${json.ancla.objeto_id}", que no es uno de los objetos del kit`)
  }

  return {
    grafo,
    ancla: json.ancla || null,
    descartadas: json.descartadas || [],
    ...(fuera.length ? { aristas_descartadas_por_id_desconocido: fuera } : {}),
    modelo: MODELO,
  }
}

module.exports = { proponerGrafo, MODELO }
