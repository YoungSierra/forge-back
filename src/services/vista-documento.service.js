'use strict'
// ─── Engine v1.9 · la vista de DOCUMENTO de una pieza ────────────────────────────────────────────
//
// Una pieza de forge_assets guarda la respuesta del modelo tal cual: en un nodo entero, TODOS los
// outputs bajo su `## <clave>` —el documento, pero también el sobre de imágenes, el plan, el JSON de
// la connection—. Hasta hoy el front pintaba ese texto completo en el Moodboard, en la Asset Library
// y como asomo de la tarjeta; medido el 08-10 en dos proyectos: el «documento» del 2.2 eran 20.000
// caracteres de los que 9.000 eran el `concept_data` en JSON y 2.700 el sobre de imágenes.
//
// La DNA dice ahora para quién es cada output: `audience: "document"` (se lee) o `"internal"` (lo
// lee el motor o el nodo siguiente). Esta vista separa la pieza en dos: `content` —lo que se lee— y
// `data[]` —lo demás, por output, para el acordeón «Data»—. La pieza guardada no cambia; los que
// leen la pieza cruda (despacho, PDF por sección, slide-composer, extracción) siguen leyendo
// `content` de forge_assets.
//
// Sin `audience` en la DNA (nodos que no la declaran todavía) hay un defecto: una connection, una
// imagen o un formato de datos es `internal`; un documento (markdown, docx, pdf, pptx…) es `document`.

const { extractSection } = require('../utils/extract-section')

const FORMATOS_DOCUMENTO = ['markdown', 'md', 'document', 'docx', 'doc', 'pdf', 'pptx', 'text', 'txt', 'html', 'artifact_bundle']
const claveDe = o => (typeof o === 'object' && o ? (o.key || o.name) : o) || ''

/** Para quién es un output: lo que diga la DNA, o el defecto. */
function audienciaDe(def) {
  if (!def || typeof def !== 'object') return 'document'
  if (def.audience === 'internal' || def.audience === 'document') return def.audience
  if (def.type === 'connection') return 'internal'
  const fmt = String(def.format || '').toLowerCase()
  if (FORMATOS_DOCUMENTO.includes(fmt)) return 'document'
  if (def.image_gen) return 'internal'
  return fmt ? 'internal' : 'document'
}

/**
 * Un output `document` cuya salida es un ARCHIVO (una imagen que genera, un deck pptx): su sección en la pieza es
 * el sobre o el JSON del deck —datos—, y lo que se lee es el archivo. La vista manda la sección a `data[]` y
 * devuelve la clave en `archivos[]` para que el llamador adjunte las piezas (png, pptx) de ese output.
 */
const FORMATOS_IMAGEN = ['png', 'image', 'jpg', 'jpeg', 'webp']
function esSalidaDeArchivo(def) {
  if (!def || typeof def !== 'object' || audienciaDe(def) !== 'document') return false
  const fmt = String(def.format || '').toLowerCase()
  // `image_gen` en un documento de texto (el `pitch_document` docx del 2.1) quiere decir que el documento
  // LLEVA imágenes, no que la salida sea una imagen. Tomarlo como archivo vaciaba la vista y el PDF del chat
  // caía a la respuesta entera, con la frase y el plan de imágenes dentro (feedback de JM, 20-10).
  if (def.image_gen && fmt !== 'pptx' && FORMATOS_DOCUMENTO.includes(fmt)) return false
  return !!def.image_gen || FORMATOS_IMAGEN.includes(fmt) || fmt === 'pptx'
}

// Un bloque ```json CERCADO que parsea y pesa es un bloque de máquina (contrato, sobre, veredicto);
// uno corto puesto para ilustrar algo se queda en el texto. Mismo umbral que `sinBloquesMaquina` del PDF.
const UMBRAL_BLOQUE = 300
function separarBloquesMaquina(texto, clave) {
  const bloques = []
  const resto = String(texto || '').replace(/```json\s*\n?([\s\S]*?)```/gi, (todo, cuerpo) => {
    if (cuerpo.trim().length < UMBRAL_BLOQUE) return todo
    try { JSON.parse(cuerpo) } catch { return todo }
    bloques.push({ key: clave, label: null, kind: 'block', content: todo.trim() })
    return ''
  }).replace(/\n{3,}/g, '\n\n')
  return { texto: resto, bloques }
}

/**
 * La vista de una pieza. `outputDefs` = los outputs de la DNA del nodo; `outputKey` = la clave del output
 * cuando la pieza es de UN output (por su sesión o por su nombre «<título> — <label>»); null para una pieza
 * de nodo entero («— Output») o cuando no se sabe.
 * Devuelve { content, data: [{ key, label, kind: 'output' | 'block', content }], hidden }.
 */
function vistaDocumento({ content, outputDefs, outputKey = null }) {
  const texto = String(content || '').replace(/\r\n/g, '\n')
  const defs = Array.isArray(outputDefs) ? outputDefs : []
  const porClave = new Map(defs.map(d => [claveDe(d), d]))
  const labelDe = k => { const d = porClave.get(k); return d ? (d.label || d.name || k) : k }
  const data = []
  const claves = [...porClave.keys()].filter(Boolean)

  // ¿Viene seccionada por outputs? Un `## <clave>` de la DNA en el texto.
  const esClave = linea => {
    const m = /^##\s+\*{0,2}\s*([A-Za-z0-9_.\-]+)\s*\*{0,2}\s*$/.exec(linea)
    if (!m) return null
    const k = m[1]
    return claves.find(c => c.toLowerCase() === k.toLowerCase()) || null
  }
  const lineas = texto.split('\n')
  const seccionada = lineas.some(l => esClave(l))

  const archivos = []
  if (!seccionada) {
    // Pieza de un output (o sin encabezados de clave): la audiencia de ESE output decide
    const def = outputKey ? porClave.get(outputKey) : null
    if (def && (audienciaDe(def) === 'internal' || esSalidaDeArchivo(def))) {
      data.push({ key: outputKey, label: labelDe(outputKey), kind: 'output', content: texto.trim() })
      if (esSalidaDeArchivo(def)) archivos.push(outputKey)
      return { content: '', data, hidden: data.length, archivos }
    }
    const { texto: limpio, bloques } = separarBloquesMaquina(texto, outputKey)
    data.push(...bloques)
    return { content: limpio.trim(), data, hidden: data.length, archivos }
  }

  // Pieza de nodo entero: cada `## <clave>` abre una sección de ese output hasta el siguiente `## <clave>`;
  // lo que no es clave (el título, los `##` del propio modelo) se queda en el documento, en su orden.
  const partes = []   // { tipo: 'texto' | 'output', key, lineas }
  let actual = { tipo: 'texto', key: null, lineas: [] }
  for (const l of lineas) {
    const k = esClave(l)
    if (k) { partes.push(actual); actual = { tipo: 'output', key: k, lineas: [] }; continue }
    actual.lineas.push(l)
  }
  partes.push(actual)

  // el documento se recompone línea a línea, como estaba: una pieza sin outputs internal ni bloques de máquina sale igual
  const documento = []
  for (const p of partes) {
    const cuerpo = p.lineas.join('\n')
    if (p.tipo === 'output' && (audienciaDe(porClave.get(p.key)) === 'internal' || esSalidaDeArchivo(porClave.get(p.key)))) {
      if (cuerpo.trim()) data.push({ key: p.key, label: labelDe(p.key), kind: 'output', content: cuerpo.trim() })
      if (esSalidaDeArchivo(porClave.get(p.key))) archivos.push(p.key)
      continue
    }
    const { texto: limpio, bloques } = separarBloquesMaquina(cuerpo, p.key)
    data.push(...bloques)
    if (p.tipo === 'output') { if (limpio.trim()) documento.push(`## ${p.key}\n${limpio}`) }
    else if (limpio.trim() || !documento.length) documento.push(limpio)
  }
  // data[] en el orden de la DNA (los bloques de máquina de una sección documento van con su clave)
  const orden = k => { const i = claves.indexOf(k); return i < 0 ? claves.length : i }
  data.sort((a, b) => orden(a.key) - orden(b.key))
  return { content: documento.join('\n').replace(/\n{3,}/g, '\n\n').trim(), data, hidden: data.length, archivos }
}

/**
 * Las piezas ARCHIVO que acompañan a la vista: las png/pptx aprobadas del proyecto que produjeron los outputs de
 * `archivos` (por `output_key`, o por el nombre «<título> — <label|key>…»), más la propia pieza si lleva un
 * storage_url de documento (el .pptx de un deck). [{ key, label, name, url, format, kind: 'image' | 'file' }].
 */
async function archivosDeLaVista(db, { project_id, node_id, nodeTitle, outputDefs, archivos, pieza }) {
  const out = []
  const visto = new Set()
  const poner = (f) => { if (f.url && !visto.has(f.url)) { visto.add(f.url); out.push(f) } }
  if (pieza?.storage_url && /\.(pptx|pdf|docx)(\?|$)/i.test(pieza.storage_url)) {
    poner({ key: null, label: null, name: pieza.name, url: pieza.storage_url, format: pieza.storage_url.match(/\.(\w+)(\?|$)/)[1].toLowerCase(), kind: 'file' })
  }
  if (!archivos?.length || !project_id || !node_id) return out
  const { data } = await db().from('forge_assets').select('name, storage_url, format, output_key, created_at, forge_sessions!session_id(output_key)')
    .eq('project_id', project_id).eq('node_id', node_id).in('status', ['approved', 'auto_approved']).not('storage_url', 'is', null)
    .order('created_at', { ascending: false })
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  for (const key of archivos) {
    const def = (outputDefs || []).find(d => claveDe(d) === key) || { key }
    const nombre = norm(`${nodeTitle} — ${def.label || def.name || key}`)
    for (const a of (data || [])) {
      const k = a.output_key ?? a.forge_sessions?.output_key ?? null
      const casa = k === key || norm(a.name).startsWith(nombre) || norm(a.name) === norm(`${nodeTitle} — ${key}`)
      if (!casa) continue
      const fmt = String(a.format || '').toLowerCase()
      poner({ key, label: def.label || def.name || key, name: a.name, url: a.storage_url, format: fmt, kind: FORMATOS_IMAGEN.includes(fmt) ? 'image' : 'file' })
    }
  }
  return out
}

/**
 * La clave del output de una pieza: la de su sesión, o el label de su nombre «<título> — <label>».
 * Null para «— Output» (nodo entero) y para nombres que no casan con ningún output.
 */
function claveDePieza({ name, sessionOutputKey, assetOutputKey, nodeTitle, outputDefs }) {
  if (assetOutputKey) return assetOutputKey
  if (sessionOutputKey) return sessionOutputKey
  const nombre = String(name || '')
  if (/— Output$/.test(nombre)) return null
  const label = nombre.includes(' — ') ? nombre.slice(nombre.indexOf(' — ') + 3).trim() : nombre
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const def = (outputDefs || []).find(d => norm(d.label || d.name || d.key) === norm(label) || norm(claveDe(d)) === norm(label))
  return def ? claveDe(def) : null
}

module.exports = { vistaDocumento, audienciaDe, esSalidaDeArchivo, archivosDeLaVista, claveDePieza, separarBloquesMaquina, FORMATOS_DOCUMENTO }
