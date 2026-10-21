'use strict'
// ─── Engine v1.8 · outputs `extract`: paquetes armados por el motor, sin llamada al modelo ───────────
//
// Un output cuya DNA declara
//   extract: { from, sections, gate, header, optional }
// no se le pide al LLM: el motor toma el documento MAESTRO (`from`, un hermano del nodo), localiza por
// NÚMERO cada sección pedida y copia su texto entero y tal cual —encabezado, tablas, subsecciones—. Antes
// de extraer corre el Conformance Gate: los números de `gate` tienen que estar en el maestro, una vez y sin
// fusiones. Si el Gate falla, o falta una sección obligatoria, no sale paquete: el error sube con rastro
// (v1.4) y no se guarda ninguna pieza — un ADI con texto vacío engañaría a quien lo lee (animacion.service
// lo pasaría al extractor de clips), uno ausente no.
//
// Lo que mide el 09-10 sobre los 7 ADD reales: toda sección presente se localiza; lo que no está es lo que
// la v6.0 añadió. Hizo falta la regla del BLOQUE CANÓNICO: dos piezas viejas traían los 11 ADI incrustados
// después del documento y repetían 9 y 22 encabezados; acotando la búsqueda al tramo canónico, cero.
//
// El índice por número también lo usa tandas.service (modo `sections`): es la misma lectura de encabezados.

const DEFECTOS = { numbering: 'section', optional: [], gate: [], sections: [] }

/** La config `extract` de un output, con defectos; null si no la declara. */
function configExtract(outputDef) {
  const e = outputDef && typeof outputDef === 'object' ? outputDef.extract : null
  if (!e || typeof e !== 'object' || !e.from) return null
  return { ...DEFECTOS, ...e, sections: [...(e.sections || [])], gate: [...(e.gate || [])], optional: [...(e.optional || [])] }
}
/** Los outputs del nodo que se extraen, en el orden de la DNA. */
const outputsExtract = outputDefs => (Array.isArray(outputDefs) ? outputDefs : []).filter(o => configExtract(o))

// ── Índice de encabezados numerados ──────────────────────────────────────────

/** Compara números de sección: 7.10 va después de 7.9. */
const porNumero = (a, b) => {
  const A = a.split('.').map(Number), B = b.split('.').map(Number)
  for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] ?? -1) - (B[i] ?? -1); if (d) return d }
  return 0
}
const desciende = (hijo, padre) => hijo === padre || hijo.startsWith(padre + '.')

/**
 * El tramo canónico de un maestro: desde su primer encabezado numerado hasta el primer «## » posterior
 * sin número (Reference Image Set, ADI Segmentation, art_bible_intake…). Lo de fuera no cuenta.
 */
function bloqueCanonico(md) {
  const lineas = String(md || '').replace(/\r\n/g, '\n').split('\n')
  let ini = -1
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i]
    const esNumerado = /^#{1,6}\s+§?\s*\d+(\.\d+)*(\s|$)/.test(l)
    if (ini < 0) { if (esNumerado) ini = i; continue }
    if (/^##\s/.test(l) && !esNumerado) return lineas.slice(ini, i).join('\n')
  }
  return ini >= 0 ? lineas.slice(ini).join('\n') : lineas.join('\n')
}

/**
 * Los encabezados numerados de un markdown: líneas «#… §N.N Título» (o «**N.N Título**»). Un encabezado
 * con dos números («§7.4 / §7.5 …») se indexa a los dos y se recuerda como fusión.
 * Devuelve [{ linea, nivel, numeros, titulo }].
 */
function indice(md) {
  const out = []
  const lineas = String(md || '').split('\n')
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i]
    const m = l.match(/^(#{1,6})\s+(.*)$/) || l.match(/^\*\*(.+)\*\*\s*$/)
    if (!m) continue
    const nivel = m[1].startsWith('#') ? m[1].length : 7
    let resto = (m[2] ?? m[1]).replace(/\*\*/g, '').trim()
    const numeros = []
    let k
    while ((k = resto.match(/^§?\s*(\d+(?:\.\d+)*)\s*(?:\/\s*|\s|—|–|-|:)/))) {
      numeros.push(k[1]); resto = resto.slice(k[0].length).replace(/^§?\s*/, '')
      if (!/^\d/.test(resto)) break
    }
    if (!numeros.length) continue
    out.push({ linea: i, nivel, numeros, titulo: resto.trim() })
  }
  return out
}

/**
 * La sección de número `n`: desde su encabezado hasta el siguiente encabezado numerado que NO descienda
 * de `n` (así §7.3 arrastra §7.3.1 y los «### ENV-01…» sin número). Estados: ok · ausente · fusionado
 * (el encabezado trae otro número además) · duplicado (más de un encabezado con ese número).
 */
function extraerSeccion(md, n, encs = null, { propio = false } = {}) {
  const lineas = String(md || '').split('\n')
  const e = encs || indice(md)
  const hits = e.filter(x => x.numeros.includes(n))
  if (!hits.length && propio) return { estado: 'ausente', n }
  if (!hits.length) {
    // «§5» sin encabezado propio (en el docx las fases no son encabezados): §5 = §5.1 + §5.2, en orden
    const hijos = [...new Set(e.flatMap(x => x.numeros).filter(x => x !== n && desciende(x, n)))].sort(porNumero)
      .filter((x, i, arr) => !arr.slice(0, i).some(p => desciende(x, p)))
    if (!hijos.length) return { estado: 'ausente', n }
    const partes = hijos.map(h => extraerSeccion(md, h, e))
    if (partes.some(p => p.estado === 'ausente')) return { estado: 'ausente', n }
    return { estado: partes.some(p => p.estado === 'duplicado') ? 'duplicado' : partes.some(p => p.estado === 'fusionado') ? 'fusionado' : 'ok', n, texto: partes.map(p => p.texto).join('\n\n'), titulo: `(${hijos.map(h => '§' + h).join(' + ')})`, fusion: partes.flatMap(p => p.fusion || []), hijos }
  }
  const h = hits[0]
  let fin = lineas.length
  // `propio`: solo el cuerpo del encabezado, hasta el siguiente encabezado numerado (los «###» sin número
  // siguen dentro). Lo usan las tandas por secciones, que piden cada encabezado por su número.
  for (const o of e) if (o.linea > h.linea && (propio || !o.numeros.every(x => desciende(x, n)))) { fin = o.linea; break }
  const texto = lineas.slice(h.linea, fin).join('\n').replace(/\s+$/, '')
  return { estado: hits.length > 1 ? 'duplicado' : h.numeros.length > 1 ? 'fusionado' : 'ok', n, texto, titulo: h.titulo, fusion: h.numeros }
}

/** El Conformance Gate sobre un índice: cada número una vez y sin fusión. */
function verificarGate(encs, gate) {
  const r = { ok: true, faltan: [], fusionados: [], duplicados: [] }
  for (const n of gate || []) {
    const hits = encs.filter(x => x.numeros.includes(n))
    if (!hits.length) r.faltan.push(n)
    else if (hits.length > 1) r.duplicados.push(n)
    else if (hits[0].numeros.length > 1) r.fusionados.push(`${n} (${hits[0].numeros.join('/')})`)
  }
  r.ok = !r.faltan.length && !r.fusionados.length && !r.duplicados.length
  return r
}

const error = (code, msg, extra = {}) => { const e = new Error(msg); e.code = code; e.publico = true; e.status = 422; Object.assign(e, extra); return e }

/**
 * El paquete de un output `extract` a partir del texto del maestro. Lanza (publico) si el Gate falla, si
 * falta una sección obligatoria, o si una sección pedida trae un placeholder [DRAFT]/[REPLACE].
 * Devuelve { texto, extraidas, opcionalesNA, avisos, gate }.
 */
function armarPaquete({ master, cfg, label }) {
  if (!master || !String(master).trim()) throw error('NO_MASTER', `'${label}' cannot be extracted: '${cfg.from}' has no approved document yet`)
  const canon = bloqueCanonico(master)
  const encs = indice(canon)
  if (!encs.length) throw error('NO_MASTER', `'${label}' cannot be extracted: '${cfg.from}' has no numbered sections (is it authored in the Framework 11.0 template?)`)
  const gate = verificarGate(encs, cfg.gate)
  if (!gate.ok) {
    const partes = [gate.faltan.length && `missing §${gate.faltan.join(', §')}`, gate.fusionados.length && `fused ${gate.fusionados.map(x => '§' + x).join(', ')}`, gate.duplicados.length && `duplicated §${gate.duplicados.join(', §')}`].filter(Boolean)
    throw error('GATE_FAILED', `Conformance Gate failed for '${label}': the master '${cfg.from}' is not on the Framework 11.0 template — ${partes.join('; ')}. Re-author the master, then run this output again.`, { gate })
  }
  // las secciones pedidas, sin repetidas y en orden canónico; «§5» arrastra §5.x por descendencia, así que
  // una pedida que desciende de otra pedida (§7.2.1 con §7.2) ya viene dentro y no se repite
  const unicas = [...new Set(cfg.sections.map(String))].sort(porNumero)
  const pedidas = unicas.filter(n => !unicas.some(m => m !== n && desciende(n, m)))
  const extraidas = [], opcionalesNA = [], faltan = [], avisos = []
  for (const n of pedidas) {
    const s = extraerSeccion(canon, n, encs)
    if (s.estado === 'ausente') { if (cfg.optional.includes(n)) opcionalesNA.push(n); else faltan.push(n); continue }
    if (s.estado === 'fusionado') { faltan.push(`${n} (fused with §${s.fusion.filter(x => x !== n).join(', §')})`); continue }
    if (s.estado === 'duplicado') avisos.push(`§${n} appears twice in the master; the first one was used`)
    const ph = s.texto.match(/\[(DRAFT|REPLACE)[^\]]*\]/g)
    if (ph) throw error('DRAFT_IN_SECTION', `'${label}' cannot be extracted: §${n} of '${cfg.from}' still carries ${ph.length} placeholder(s) (${ph[0]}). Approve the master first.`)
    extraidas.push({ n, titulo: s.titulo, chars: s.texto.length, texto: s.texto })
  }
  if (faltan.length) throw error('SECTION_MISSING', `'${label}' cannot be extracted: the master '${cfg.from}' has no §${faltan.join(', §')}`, { faltan })
  const lista = extraidas.map(x => `§${x.n} ${x.titulo}`.trim())
  const cabecera = String(cfg.header || `${label}`).replace(/\{\{sections\}\}/g, lista.join(' · ')).replace(/\{\{package\}\}/g, label).trim()
  const cuerpo = extraidas.map(x => x.texto)
  for (const n of opcionalesNA) cuerpo.push(`### §${n}\n\nN/A — not populated in the master (when-applicable section).`)
  const texto = `${cabecera}\n\n${cuerpo.join('\n\n')}\n\n_Extracted verbatim by the engine from ${cfg.from}: ${extraidas.length} sections, ${extraidas.reduce((s, x) => s + x.chars, 0)} characters._\n`
  return { texto, extraidas: extraidas.map(({ texto: _t, ...x }) => x), opcionalesNA, avisos, gate }
}

/**
 * El texto del maestro para extraer: la pieza aprobada más reciente del output `from` en este proyecto (por
 * `output_key` de su sesión, o por el nombre «<título> — <label>»); si solo hay una pieza de nodo entero,
 * su sección. Null si no hay nada.
 */
async function masterDeFila(db, { project_id, node_id, nodeTitle, outputDefs, from, extractSection }) {
  const def = (outputDefs || []).find(o => (o.key || o.name) === from) || { key: from }
  const { data } = await db().from('forge_assets')
    .select('name, content, created_at, output_key, forge_sessions!session_id(output_key)')
    .eq('project_id', project_id).eq('node_id', node_id)
    .in('status', ['approved', 'auto_approved']).not('content', 'is', null)
    .order('created_at', { ascending: false })
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const nombre = norm(`${nodeTitle} — ${def.label || from}`)
  const propia = (data || []).find(a => (a.output_key ?? a.forge_sessions?.output_key) === from) || (data || []).find(a => norm(a.name) === nombre)
  if (propia?.content) return propia.content
  if (extractSection) {
    const entera = (data || []).find(a => /— Output$/.test(a.name || ''))
    if (entera?.content) return extractSection(entera.content, from, (outputDefs || []).map(o => o.key || o.name).filter(k => k && k !== from))
  }
  return null
}

/** La nota para el nodo entero: el modelo no escribe los outputs que el motor extrae. */
const notaNodoEntero = claves => `## Sections written by the engine\nDo NOT emit ${claves.map(k => `'## ${k}'`).join(', ')}: the engine extracts ${claves.length === 1 ? 'it' : 'them'} verbatim from the master after this reply.`

/** Una fila de log por extracción: executor_type 'engine', sin tokens ni costo. */
function registrar({ logExecution, ctx, paquete, error: err, duration_ms }) {
  try {
    logExecution({
      project_id: ctx.project_id, node_id: ctx.node_id, session_id: ctx.session_id || null,
      triggered_by: ctx.member_id || null, trigger_type: ctx.trigger_type, executor_type: 'engine',
      provider: 'engine', model: 'extract', tokens: null, duration_ms, started_at: new Date(Date.now() - (duration_ms || 0)).toISOString(),
      status: err ? 'error' : 'success', error_code: err ? String(err.code || 'ERROR').slice(0, 64) : null, cost_usd: 0,
      metadata: {
        node_key: ctx.node_key, output_key: ctx.output_key, etapa: 'extract',
        ...(paquete ? { from: ctx.from, sections: paquete.extraidas.length, chars: paquete.extraidas.reduce((s, x) => s + x.chars, 0), ...(paquete.opcionalesNA.length ? { optional_na: paquete.opcionalesNA } : {}) } : {}),
        ...(err ? { message: String(err.message).slice(0, 300), ...(err.gate ? { gate_missing: err.gate.faltan, gate_fused: err.gate.fusionados } : {}) } : {}),
      },
    })
  } catch (e) { console.error('[extract] logExecution falló (no fatal):', e.message) }
}

/**
 * Las marcas [DRAFT …] / [REPLACE …] de un maestro, con la sección numerada que las contiene. Son las que hacen
 * que `armarPaquete` rechace la extracción («Approve the master first»), así que el Accept las enseña antes de
 * aprobar (pedido de Pedro, 20-10). Devuelve [{ seccion, tipo, texto }]; `seccion` null si va antes de toda sección.
 */
function marcasDelMaestro(texto) {
  const out = []
  let seccion = null
  for (const linea of String(texto || '').split('\n')) {
    const h = /^#{1,6}\s*\**\s*§?\s*(\d+(?:\.\d+)*)\b/.exec(linea)
    if (h) seccion = h[1]
    for (const m of linea.matchAll(/\[(DRAFT|REPLACE)[^\]]*\]/g)) out.push({ seccion, tipo: m[1], texto: m[0] })
  }
  return out
}

/** Quita las marcas [DRAFT …] (y el espacio que dejan). Las [REPLACE …] se quedan: piden editar, no aprobar. */
const quitarDrafts = texto => String(texto || '').replace(/[ \t]*\[DRAFT[^\]]*\][ \t]*/g, m => (/^[ \t]/.test(m) && /[ \t]$/.test(m) ? ' ' : ''))

module.exports = { marcasDelMaestro, quitarDrafts, configExtract, outputsExtract, bloqueCanonico, indice, extraerSeccion, verificarGate, armarPaquete, masterDeFila, notaNodoEntero, registrar, porNumero, desciende }
