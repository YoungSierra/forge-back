// ─── Engine v1.8 · requisitos de un nodo antes de correr (`metadata.requires` de la DNA) ────────────
//
// Un nodo puede declarar en su DNA qué tiene que existir en el proyecto antes de gastar nada en él. El 3.20
// (Art Style Guide) lo usa para la regla de dirección de arte del 09-10: no corre mientras el Vertical Slice
// Specification (3.13) no esté aprobado, mientras el VS Spec cuente clases sin nombrar sus assets, o mientras
// alguno de los cuatro desgloses del ADD (§7.3.1 · §7.9.1 · §7.10.1 · §7.11.1) siga en N/A.
//
//   "requires": [
//     { "id": "vs_spec_approved",     "check": "approved",          "node": "3.13", "outputs": ["vs_spec_doc", "vs_spec"], "message": "…" },
//     { "id": "vs_spec_named_lists",  "check": "named_asset_lists", "node": "3.13", "outputs": [...], "message": "… {detail} …" },
//     { "id": "add_breakdowns_filled","check": "sections_filled",   "node": "3.9",  "outputs": ["art_direction_document"], "sections": ["7.3.1", …], "message": "… {detail} …" }
//   ]
//
// Se evalúan TODAS las reglas (no se para en la primera) y, si alguna falla, sube un error público 409
// REQUIREMENTS_NOT_MET con `missing[]` y un mensaje que dice exactamente qué falta. Se llama antes de crear
// sesión y antes de pagar nada (auto-run y chat). Un nodo sin `requires` no cambia en nada.
'use strict'
const X = require('./extraccion.service')

const publico = (code, msg, extra = {}) => { const e = new Error(msg); e.code = code; e.publico = true; e.status = 409; Object.assign(e, extra); return e }

/**
 * La pieza aprobada más reciente de un nodo (por node_key) en este proyecto: por las claves de `outputs` en ese
 * orden (output_key de la pieza o de su sesión) o, si no, la pieza de nodo entero («… — Output»). Null si no hay.
 */
async function piezaAprobada(db, { project_id, node_key, outputs = [] }) {
  const { data: nodo } = await db().from('forge_nodes').select('id, node_key, title').eq('node_key', String(node_key)).maybeSingle()
  if (!nodo) return null
  const { data } = await db().from('forge_assets')
    .select('name, content, created_at, output_key, forge_sessions!session_id(output_key)')
    .eq('project_id', project_id).eq('node_id', nodo.id)
    .in('status', ['approved', 'auto_approved']).not('content', 'is', null)
    .order('created_at', { ascending: false })
  const claveDe = a => a.output_key ?? a.forge_sessions?.output_key ?? null
  for (const k of (outputs || []).map(String)) {
    const p = (data || []).find(a => claveDe(a) === k && a.content)
    if (p) return { node_id: nodo.id, node_key: String(node_key), output_key: k, content: p.content }
  }
  const entera = (data || []).find(a => /— Output$/.test(a.name || '') && a.content)
  return entera ? { node_id: nodo.id, node_key: String(node_key), output_key: 'whole-node', content: entera.content } : null
}

/**
 * Las secciones (por número) que en el documento están ausentes, vacías o en N/A. «N/A» es lo que fijan las
 * skills y el docx v6.0 para un desglose sin Vertical Slice: el cuerpo empieza por N/A, o dice «Vertical Slice
 * scope not defined».
 */
function seccionesEnNA(contenido, sections) {
  const canon = X.bloqueCanonico(contenido), encs = X.indice(canon)
  const na = []
  for (const n of (sections || []).map(String)) {
    const s = X.extraerSeccion(canon, n, encs, { propio: true })
    if (s.estado === 'ausente') { na.push(n); continue }
    const cuerpo = String(s.texto || '').split('\n').slice(1).join('\n').trim()
    if (!cuerpo || /^(\*\*|_|`)?\s*N\s*\/?\s*A\b/i.test(cuerpo) || /Vertical Slice scope not defined/i.test(cuerpo)) na.push(n)
  }
  return na
}

// ── «Se cuenta listando» (Instrucción de repetición §3/§6; Orden de publicación §8) ──────────────────────────
// Sobre las filas del inventario de clases del VS Spec que instancian una hoja (las mismas tablas y el mismo
// reparto por hoja que el menú de alcance, `alcance-vs.service`): una fila que declara N ≥ 2 unidades sin
// nombrarlas es un conteo, no una lista. Declarado = la columna Count, o en el nombre «N <unidad>» / «all N
// <unidad>» / un rango «1–4» de números sueltos. Nombrado = lo enumerado entre paréntesis del nombre (por «,»,
// «+», «;», «·»; un rango de ids «SFX-PA-01–05» cuenta 5) más una columna de nombres (Notes / Items / Named /
// Assets / Deliverables / List) cuando trae una lista y no prosa; la columna Rationale no cuenta. «× N» son copias
// del mismo asset, no assets distintos. Los personajes salen del roster, que nombra uno a uno.
const UNIDADES = /\b(assets?|clips?|animations?|sets?|tracks?|lines?|events?|stems?|prefabs?|effects?|items?|objects?|pieces?|props?|screens?|environments?|levels?|characters?|actors?|models?|rigs?|sprites?|layers?|sfx|vfx|variants?|loops?|stingers?|tiles?|tilesets?)\b/i
const limpio = s => String(s || '').replace(/\*\*/g, '').replace(/`/g, '').trim()
const esConteo = p => /^\s*(all\s+)?\d+\s+\S/.test(p) && (UNIDADES.test(p) || /^\s*all\s+\d+/i.test(p))   // «8 clips», «all 7 elements»
const rangoDeId = p => { const m = limpio(p).match(/^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9]+)*-(\d+)\s*[–-]\s*(\d+)$/); return m ? Math.max(1, Number(m[2]) - Number(m[1]) + 1) : 0 }
function nombrados(nombre) {
  let n = 0
  for (const g of String(nombre).match(/\(([^)]*)\)/g) || []) {
    for (const p of g.slice(1, -1).split(/\s*(?:,|\+|;|·)\s*/).map(limpio).filter(Boolean)) {
      if (esConteo(p)) continue
      n += rangoDeId(p) || 1
    }
  }
  return n
}
function declarados(nombre, cuenta) {
  let d = Number(cuenta) > 1 ? Number(cuenta) : 0
  const t = String(nombre)
  for (const m of t.matchAll(/\b(?:all\s+)?(\d+)\s+(?:[A-Za-z-]+\s+){0,2}([A-Za-z]+)\b/g)) if (UNIDADES.test(m[2]) && Number(m[1]) > 1) d = Math.max(d, Number(m[1]))
  const sinParentesis = t.replace(/\([^)]*\)/g, ' ')
  const rangos = [...sinParentesis.matchAll(/(?<![A-Za-z0-9_-])(\d+)\s*[–-]\s*(\d+)(?![A-Za-z0-9_-])/g)]
  if (rangos.length) {
    let r = rangos.reduce((s, m) => s + Math.max(0, Number(m[2]) - Number(m[1]) + 1), 0)
    r += (sinParentesis.match(/,\s*(\d+)(?!\s*[–-])/g) || []).length   // «1–5, 7»
    d = Math.max(d, r)
  }
  return d
}
/** Una celda que enumera nombres (lista corta separada por «,», «+», «;», «·»), no prosa: cuántos nombra. */
function nombresDeCelda(celda) {
  const t = limpio(celda)
  if (!t || t === '—' || /\.\s+[A-Z]/.test(t)) return 0           // una frase con punto y seguido es prosa
  const partes = t.split(/\s*(?:,|\+|;|·)\s*/).map(limpio).filter(Boolean)
  if (partes.some(p => p.length > 48)) return 0
  if (partes.length === 1 && partes[0].split(/\s+/).length >= 5) return 0   // una frase suelta, no un nombre
  let n = 0
  for (const p of partes) { if (esConteo(p)) continue; n += rangoDeId(p) || 1 }
  return n
}
/** Las tablas de clases de asset del spec (cabecera con «Asset Class»), bloque por bloque, como el menú de alcance. */
function tablasDeClases(md, A) {
  const lineas = String(md || '').split('\n')
  const cortes = []
  lineas.forEach((l, i) => { if (/^#{2,4}\s+\S/.test(l)) cortes.push(i) })
  const out = []
  for (let k = 0; k < cortes.length; k++) {
    const t = A.filasDeTabla(lineas.slice(cortes[k], cortes[k + 1] ?? lineas.length).join('\n'))
    if (t.filas?.length && (t.cabecera || []).some(c => /asset\s*class/i.test(c))) out.push({ ...t, titulo: lineas[cortes[k]].replace(/^#+\s*/, '').trim() })
  }
  return out
}
/** Las filas del inventario del VS Spec que cuentan sin listar: [{ hoja, etiqueta, nombre, declarados, nombrados }]. */
function clasesSinLista(contenido) {
  const A = require('./alcance-vs.service')
  const out = []
  for (const tabla of tablasDeClases(contenido, A)) {
    const cab = tabla.cabecera || []
    const iCuenta = cab.findIndex(c => /count/i.test(c))
    const iNombres = cab.map((c, i) => (/^(notes?|items?|named|assets?|deliverables?|list|contents?)$/i.test(limpio(c)) ? i : -1)).filter(i => i > 0)
    for (const f of tabla.filas) {
      const nombre = limpio(f[0])
      if (!nombre) continue
      const cuenta = iCuenta > 0 ? (parseInt((limpio(f[iCuenta]).match(/\d+/) || ['1'])[0], 10)) : 1
      if (cuenta === 0) continue                                   // declarado y fuera del slice
      const destino = A.A_LA_HOJA.find(d => d.re.test(nombre))
      if (!destino || destino.hoja === '18_CharacterSheet') continue
      if (/×\s*\d+/.test(nombre) && !(cuenta > 1)) continue
      const d = declarados(nombre, cuenta)
      const n = nombrados(nombre) + iNombres.reduce((s, i) => s + nombresDeCelda(f[i]), 0)
      if (d >= 2 && n < d) out.push({ hoja: destino.hoja, etiqueta: destino.etiqueta, nombre, declarados: d, nombrados: n })
    }
  }
  return out
}

/**
 * Evalúa `node.metadata.requires` contra el proyecto. Devuelve { ok: true, missing: [] } o lanza 409
 * REQUIREMENTS_NOT_MET (público) con `missing[]` = [{ id, node, check, detail, message }].
 */
async function verificarRequisitos(db, { project_id, node }) {
  const reglas = Array.isArray(node?.metadata?.requires) ? node.metadata.requires : []
  if (!reglas.length) return { ok: true, missing: [] }
  const piezas = new Map()
  const piezaDe = async r => {
    const k = `${r.node}|${(r.outputs || []).join(',')}`
    if (!piezas.has(k)) piezas.set(k, await piezaAprobada(db, { project_id, node_key: r.node, outputs: r.outputs || [] }))
    return piezas.get(k)
  }
  const missing = []
  const sinPieza = new Set()
  for (const r of reglas) {
    if (!r || !r.node || !r.check) continue
    const p = await piezaDe(r)
    let detail = null
    if (r.check === 'approved') { if (p) continue; sinPieza.add(String(r.node)) }
    else if (!p) {
      // sin pieza no hay nada que leer: si otra regla ya lo dijo (check approved del mismo nodo), no se repite
      if (sinPieza.has(String(r.node)) || reglas.some(x => x.check === 'approved' && String(x.node) === String(r.node))) continue
      detail = `no approved piece of ${r.node}`
    }
    else if (r.check === 'sections_filled') { const na = seccionesEnNA(p.content, r.sections); if (!na.length) continue; detail = na.map(n => `§${n}`).join(', ') }
    else if (r.check === 'named_asset_lists') { const f = clasesSinLista(p.content); if (!f.length) continue; detail = f.map(x => `${x.etiqueta}: «${x.nombre}» (${x.declarados} declared, ${x.nombrados} named)`).join('; ') }
    else { console.warn(`[requisitos] ${node.node_key}: unknown check «${r.check}» in ${r.id || '?'} — ignored`); continue }
    const plantilla = String(r.message || `${r.node} does not meet «${r.check}»${detail ? ': {detail}' : ''}`)
    const message = /\{detail\}/.test(plantilla) ? plantilla.replace(/\{detail\}/g, detail || '') : (detail && !p ? `${plantilla} (${detail})` : plantilla)
    missing.push({ id: r.id || null, node: String(r.node), check: r.check, detail, message })
  }
  if (!missing.length) return { ok: true, missing: [] }
  throw publico('REQUIREMENTS_NOT_MET', `${node.node_key || 'This node'} cannot run yet:\n${missing.map(m => `- ${m.message}`).join('\n')}`, { missing })
}

module.exports = { verificarRequisitos, piezaAprobada, seccionesEnNA, clasesSinLista, nombrados, declarados, nombresDeCelda }
