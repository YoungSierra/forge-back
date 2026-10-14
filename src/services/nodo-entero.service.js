'use strict'
// ─── Engine v1.10 · imágenes de un nodo corrido ENTERO ──────────────────────────────────────────
//
// Tres reglas para que la imagen de un ítem sea la de ESE ítem (informe de bugs de concepto, 13-10):
//
//   A1 · «Run output» de un output de imagen no vuelve a preguntarle al modelo: reusa la sección de la
//        respuesta APROBADA del nodo entero. Una segunda llamada traía otra lista —otros ids, otro
//        orden— y las imágenes quedaban nombradas con los seeds de esa segunda lista, no con los del
//        documento aprobado (1.1 de Vertical Slice QA: CS-01…04 de una lista, «Concept Seeds 2/3» de otra).
//   A2 · Al iterar el nodo entero por chat, el sobre nuevo se compara con el anterior POR ID: la
//        posición cuyo prompt cambió queda `outdated` (sin despachar: la regenera el usuario con ✦), la
//        id nueva queda `pending` y la que desapareció se marca `deleted`. Antes nada cambiaba: el
//        concepto nuevo seguía con la imagen del viejo.
//   A3 · Con imágenes por despachar, el documento no se exporta en la respuesta (saldría sin ellas):
//        se exporta al terminar el despacho, con las imágenes ya resueltas.
//
// Todo lo que se puede probar sin base vive en funciones puras (`transformarPorSobre`); lo demás recibe
// `db` del llamador.

const { extractSection } = require('../utils/extract-section')

/**
 * La sección `## <clave>` de la respuesta APROBADA del nodo entero (sesión sin `output_key`), lista
 * para pasarla como `respuestaPrevia`. null si el nodo nunca se aprobó entero o la respuesta no trae
 * esa sección: entonces —y solo entonces— el output se pide al modelo, porque no hay lista que reusar.
 */
async function seccionDelNodoEntero(db, { project_id, node_id, project_node_id = null, clave, outputs = [] }) {
  if (!clave) return null
  let q = db().from('forge_sessions').select('id, output_asset_id, completed_at')
    .eq('project_id', project_id).eq('node_id', node_id).is('output_key', null)
    .in('status', ['approved', 'auto_approved'])
    .order('completed_at', { ascending: false }).limit(1)
  if (project_node_id) q = q.eq('project_node_id', project_node_id)
  const { data: sesiones } = await q
  const s = (sesiones || [])[0]
  if (!s) return null

  // La pieza aprobada es la respuesta tal como se aceptó; si no hay pieza, el último turno del agente.
  let contenido = null
  if (s.output_asset_id) {
    const { data: a } = await db().from('forge_assets').select('content').eq('id', s.output_asset_id).maybeSingle()
    contenido = a?.content || null
  }
  if (!contenido) {
    const { data: m } = await db().from('forge_messages').select('content')
      .eq('session_id', s.id).eq('role', 'agent').order('order_index', { ascending: false }).limit(1).maybeSingle()
    contenido = m?.content || null
  }
  if (!contenido) return null
  const claves = (Array.isArray(outputs) ? outputs : []).map(o => o?.key || o?.name).filter(Boolean)
  const seccion = extractSection(contenido, clave, claves.filter(k => k !== clave))
  if (!seccion || !seccion.trim()) return null
  return `## ${clave}\n\n${seccion}`
}

/**
 * A2, la regla pura. `lista` = output_images[clave] (entradas { index, id?, variations[] }); `viejo` y
 * `nuevo` = sobres [{ id, texto }] de la respuesta anterior y de la nueva. Devuelve la lista nueva y
 * qué pasó. Sin ids en el sobre nuevo no se compara (no hay identidad que seguir): la lista vuelve igual.
 *
 *   · misma id, mismo texto  → la entrada pasa a la posición nueva, intacta
 *   · misma id, otro texto   → posición nueva, `outdated: true` (la imagen es la del texto viejo)
 *   · id nueva               → `{ index, id, variations: [], pending: true }`
 *   · id que desaparece      → sus variaciones `deleted`, fuera de las posiciones (índice negativo)
 *
 * Una entrada sin `id` (historial anterior a v1.10) toma la id que el sobre VIEJO tenía en su índice.
 */
function transformarPorSobre(lista, viejo, nuevo, { marcado = new Date().toISOString(), por = null } = {}) {
  const entradas = Array.isArray(lista) ? lista : []
  if (!Array.isArray(nuevo) || !nuevo.length || nuevo.some(x => !x?.id)) return { lista: entradas, cambios: null }
  const idsViejos = Array.isArray(viejo) ? viejo.map(x => x?.id || null) : []
  const textoViejo = new Map((viejo || []).filter(x => x?.id).map(x => [x.id, x.texto ?? '']))
  // `name` es el id en las entradas del camino de los planos (anteriores a v1.10)
  const idDe = e => e?.id || e?.name || idsViejos[e?.index] || null
  const porId = new Map()
  const sinId = []
  for (const e of entradas) { const id = idDe(e); if (id && !porId.has(id)) porId.set(id, e); else if (!id) sinId.push(e) }

  const cambios = { desfasadas: [], nuevas: [], borradas: [], iguales: [] }
  const salida = nuevo.map((x, i) => {
    const e = porId.get(x.id)
    if (!e) { cambios.nuevas.push(x.id); return { index: i, id: x.id, variations: [], pending: true } }
    porId.delete(x.id)
    const antes = textoViejo.has(x.id) ? textoViejo.get(x.id) : null
    const cambio = antes !== null && String(antes).trim() !== String(x.texto ?? '').trim()
    const { pending: _p, ...resto } = e
    if (cambio) { cambios.desfasadas.push(x.id); return { ...resto, index: i, id: x.id, outdated: true } }
    cambios.iguales.push(x.id)
    return { ...resto, index: i, id: x.id }
  })
  // Las que el sobre nuevo ya no nombra: borrado suave, como el de la papelera (la url queda en el historial)
  let k = 0
  for (const [id, e] of porId) {
    cambios.borradas.push(id)
    salida.push({
      ...e, id, index: -1 - k++, removed: true,
      variations: (e.variations || []).map(v => (v?.deleted ? v : { ...v, deleted: true, deleted_at: marcado, deleted_by: por, deleted_reason: 'removed_from_envelope' })),
    })
  }
  // Lo que no se pudo identificar se deja como estaba, fuera de las posiciones nuevas
  for (const e of sinId) salida.push({ ...e, index: -1 - k++ })
  return { lista: salida, cambios }
}

/**
 * A2 en la base: para cada output de imagen que YA tiene imágenes, compara el sobre del turno nuevo con el
 * del turno anterior de la misma sesión y reescribe `output_images[clave]` donde vivan (la sesión general y
 * la última sesión de ese output de la instancia). Devuelve { [clave]: listaNueva } de lo que cambió.
 */
async function marcarDesfasadas(db, { project_id, node_id, project_node_id, session_id, replyNuevo, claves, member_id = null }) {
  const { sobreConIds } = require('./image-gen.service')
  const cambiadas = {}
  if (!claves?.length) return cambiadas
  // El turno anterior del agente en esta misma sesión: el actual ya está guardado, así que es el segundo.
  const { data: turnos } = await db().from('forge_messages').select('id, content, order_index')
    .eq('session_id', session_id).eq('role', 'agent').order('order_index', { ascending: false }).limit(2)
  const anterior = (turnos || [])[1]?.content
  if (!anterior) return cambiadas
  const marcado = new Date().toISOString()
  for (const clave of claves) {
    const nuevo = sobreConIds(replyNuevo || '', clave)
    const viejo = sobreConIds(anterior, clave)
    if (!nuevo || !viejo) continue
    // Dónde viven sus imágenes: la sesión general y la última del output en esta instancia
    const lugares = []
    const { data: gen } = await db().from('forge_sessions').select('id, output_images').eq('id', session_id).maybeSingle()
    if (gen?.output_images?.[clave]) lugares.push(gen)
    let q = db().from('forge_sessions').select('id, output_images, created_at')
      .eq('project_id', project_id).eq('node_id', node_id).eq('output_key', clave)
      .not('output_images', 'is', null).order('created_at', { ascending: false }).limit(1)
    if (project_node_id) q = q.eq('project_node_id', project_node_id)
    const { data: porOutput } = await q
    if (porOutput?.[0]?.output_images?.[clave]) lugares.push(porOutput[0])
    for (const s of lugares) {
      const { lista, cambios } = transformarPorSobre(s.output_images[clave], viejo, nuevo, { marcado, por: member_id })
      if (!cambios || (!cambios.desfasadas.length && !cambios.nuevas.length && !cambios.borradas.length)) continue
      const { error } = await db().from('forge_sessions').update({ output_images: { ...s.output_images, [clave]: lista } }).eq('id', s.id)
      if (error) { console.warn(`[v1.10 A2] ${clave}: no se pudo marcar en la sesión ${s.id}: ${error.message}`); continue }
      cambiadas[clave] = lista
      console.log(`[v1.10 A2] ${clave} (sesión ${String(s.id).slice(0, 8)}): ${cambios.desfasadas.length} outdated · ${cambios.nuevas.length} pending · ${cambios.borradas.length} deleted · ${cambios.iguales.length} sin cambio`)
    }
  }
  return cambiadas
}

/**
 * A3: el documento del turno se exporta cuando el despacho de imágenes TERMINÓ. El chat deja en los
 * tool_calls del mensaje una marca `{ tool: 'doc_gen_docx', args: { auto: true, deferred: 'images' },
 * result: { deferred: true, title, content } }`; aquí se resuelven las imágenes, se genera el PDF y la
 * marca pasa a ser el resultado normal (el chip del chat y el botón del nodo leen ese url).
 */
async function reexportarDocumentoDiferido(db, { project_id, node_id, session_id, message_id }) {
  const { data: msg } = await db().from('forge_messages').select('id, content, tool_calls').eq('id', message_id).maybeSingle()
  const marca = (msg?.tool_calls || []).find(t => t?.tool === 'doc_gen_docx' && t?.result?.deferred)
  if (!marca) return null
  const { resolverImagenesDeItems } = require('./canvas-chat.service')
  const { executeTool } = require('./tools.service')
  let itemImages = []
  try {
    itemImages = await resolverImagenesDeItems({ db, projectId: project_id, nodeId: node_id, sessionId: session_id, outKey: null, contenido: msg.content || '' })
  } catch (e) { console.warn('[v1.10 A3] imágenes del documento:', e?.message || e) }
  const r = await executeTool('doc_gen_docx', { title: marca.result.title, content: marca.result.content, item_images: itemImages }, { project_id, node_id })
  if (!r?.success || !r?.url) { console.warn('[v1.10 A3] el documento diferido no se pudo exportar'); return null }
  const tc = msg.tool_calls.map(t => (t === marca ? { ...t, result: { ...r, exported_after_images: itemImages.length } } : t))
  await db().from('forge_messages').update({ tool_calls: tc }).eq('id', msg.id)
  // Si el turno ya se aceptó, su pieza apunta al documento nuevo (el botón del nodo lee storage_url)
  const { data: ses } = await db().from('forge_sessions').select('output_asset_id').eq('id', session_id).maybeSingle()
  if (ses?.output_asset_id) await db().from('forge_assets').update({ storage_url: r.url }).eq('id', ses.output_asset_id)
  console.log(`[v1.10 A3] documento exportado tras el despacho (${itemImages.length} imagen(es)) → ${r.url}`)
  return r.url
}

module.exports = { seccionDelNodoEntero, transformarPorSobre, marcarDesfasadas, reexportarDocumentoDiferido }
