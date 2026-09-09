// ─── Ensamblador v2 · plantilla como documento ───────────────────────────────
//
// El v1 maquetaba: una lista de slots y el ensamblador escribía `## §N Título` y pegaba debajo.
// La plantilla de Pedro (v2.9.34) invierte eso y es mejor: la plantilla ES el documento —con sus
// encabezados, su caja de REAL NUMBERS, su línea *Source:* por sección— y lleva `{{slot:ID}}`
// donde va el contenido. Ensamblar es sustituir. Nada de la forma del documento vive en el código.
//
// Tres clases de slot, y el orden importa (regla del manifiesto):
//   transcribe → copia del input, sin modelo
//   pointer    → tabla armada por el ensamblador, sin modelo
//   glue       → el ÚNICO texto que escribe un modelo, y lee SECCIONES YA ENSAMBLADAS
// Los glue van al final porque leen §1–§8: antes de sustituir el resto, §3 todavía no existe.
//
// Decisión 4 de Pedro: la sección sin fuente se OMITE —sin `[FORGE]`, sin TBD, sin encabezado
// vacío— y la numeración de las demás se conserva. El apéndice registra el hueco.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const TPL_DIR = path.join(__dirname, '..', 'assembly_templates')

const sha = t => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex').slice(0, 12)

// Los documentos que este GDD engendra. Del `must_contain` de s14.downstream_documents; se puede
// sobrescribir por `opts.downstream` sin tocar la plantilla.
const DOWNSTREAM = [
  ['Art Direction Document', '3.9'],
  ['Audio Direction Document', '3.10'],
  ['Technical Design Document', '3.12'],
  ['Product Scope', '3.11'],
]

function getTemplateV2(ref) {
  // El `template_ref` de la DNA viene con glosa —«tpl_gdd_complete_v2 (md + manifest)»—, que es
  // para quien lee la fila. El id es la primera palabra. Sin recortarla no se encuentra el
  // archivo y el despacho se cae a la plantilla v1: el nodo produce, y produce el documento viejo.
  const id = String(ref || '').trim().split(/[\s(]/)[0]
  if (!id) return null
  const md = path.join(TPL_DIR, id + '.md')
  const mf = path.join(TPL_DIR, id + '.manifest.json')
  if (!fs.existsSync(md) || !fs.existsSync(mf)) return null
  return {
    template_id: id,
    body: fs.readFileSync(md, 'utf8'),
    manifest: JSON.parse(fs.readFileSync(mf, 'utf8')),
  }
}

// ── Extracción de campos ─────────────────────────────────────────────────────
// El manifiesto nombra campos —`concept_data.title`, `hud_layout.per_state_layouts`— y lo que
// llega es lo que el nodo emitió. Medido el 09-09 sobre el proyecto vivo: `concept_data` viaja
// como bloque ```json, `design_pillars` como tabla, `world_lore` como campos en negrita. De los
// 47 campos que el manifiesto pide, 17 se localizan por su nombre y 30 no, porque son nombres de
// esquema que la prosa dice con otras palabras (`progression_interlock`, `trigger_architecture`).
//
// Por eso el slot que no encuentra sus campos NO queda vacío: transcribe el input entero y lo
// declara (`via: 'input completo'`). Un GDD con una sección de más es un documento; un GDD con
// treinta secciones vacías porque el nombre no coincidía no lo es. El apéndice lo registra, así
// que la imprecisión se ve y se puede cerrar campo por campo.
const norm = s => String(s).replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase()

// Lo transcrito entra DENTRO de una sección `## N`, y trae sus propios encabezados: el
// `mechanic_specs` del proyecto abre «## Integration Map» y «## Difficulty Curve». Pegados tal
// cual quedan al mismo nivel que «## 3 Core Gameplay» y el documento pierde su índice — y peor,
// los slots de pegamento leen «la sección §3 hasta el próximo ##», así que se llevaban un tercio
// de lo que debían. Se hunden tres niveles: nada transcrito puede ser `#` ni `##`.
function hundirEncabezados(texto) {
  return String(texto).replace(/^(#{1,6})(\s)/gm, (m, h, sp) => '#'.repeat(Math.min(6, h.length + 3)) + sp)
}

function jsonDelTexto(texto) {
  const m = /```json\s*([\s\S]*?)```/.exec(texto) || /^\s*(\{[\s\S]*\})\s*$/.exec(String(texto).trim())
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

function porRutaJson(obj, ruta) {
  let cur = obj
  for (const p of String(ruta).split('.')) {
    if (cur == null) return undefined
    cur = Array.isArray(cur) ? cur.map(x => x?.[p]).filter(v => v !== undefined) : cur[p]
    if (Array.isArray(cur) && !cur.length) return undefined
  }
  return cur
}

const comoTexto = v => v == null ? null
  : typeof v === 'string' ? v
    : Array.isArray(v) ? v.map(x => typeof x === 'string' ? `- ${x}` : `- ${JSON.stringify(x)}`).join('\n')
      : JSON.stringify(v, null, 2)

// Campo en negrita: «**Logline:** A composer-pilot races…». Toma hasta la línea en blanco o el
// siguiente campo, que es el mismo criterio del compositor de láminas.
function porNegrita(texto, nombre) {
  const esc = String(nombre).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rx = new RegExp(`^\\*\\*\\s*${esc}[^*\\n]{0,20}\\*\\*:?[ \\t]*`, 'im')
  const m = rx.exec(texto)
  if (!m) return null
  const resto = texto.slice(m.index + m[0].length)
  const corte = /\n\s*\n|\n\*\*/.exec(resto)
  return (corte ? resto.slice(0, corte.index) : resto).trim() || null
}

// Sección por encabezado, hasta el próximo del mismo nivel o superior.
function porEncabezado(texto, nombre) {
  const L = String(texto).split('\n')
  const i = L.findIndex(l => /^#{1,6} /.test(l) && norm(l.replace(/^#+\s*/, '')).includes(norm(nombre)))
  if (i < 0) return null
  const nivel = (L[i].match(/^#+/) || ['#'])[0].length
  const out = [L[i]]
  for (let j = i + 1; j < L.length; j++) {
    const m = L[j].match(/^(#+) /)
    if (m && m[1].length <= nivel) break
    out.push(L[j])
  }
  return out.join('\n').trim()
}

// `fields` viene con adornos del manifiesto: `pillars[].name`, `items[] (name, value, drop)`,
// `verbs[] numbered`. Lo que sirve para buscar es la ruta pelada.
const rutaLimpia = campo => String(campo).replace(/\[\]/g, '').replace(/[\s(:].*$/, '').trim()

function extraerCampos(texto, campos) {
  if (!campos || !campos.length || campos.includes('*')) return { texto: String(texto).trim(), via: 'input completo' }
  const obj = jsonDelTexto(texto)
  const partes = [], vias = []
  for (const campo of campos) {
    const ruta = rutaLimpia(campo)
    if (!ruta) continue
    const hoja = ruta.split('.').pop()
    let v = null, via = null
    if (obj) {
      const j = porRutaJson(obj, ruta) ?? porRutaJson(obj, hoja)
      if (j !== undefined) { v = comoTexto(j); via = 'json' }
    }
    if (v == null) { const n = porNegrita(texto, hoja.replace(/_/g, ' ')) || porNegrita(texto, hoja); if (n) { v = n; via = 'negrita' } }
    if (v == null) { const h = porEncabezado(texto, hoja.replace(/_/g, ' ')); if (h) { v = h; via = 'encabezado' } }
    if (v != null) { partes.push(campos.length > 1 ? `**${hoja.replace(/_/g, ' ')}:** ${v}` : v); vias.push(via) }
  }
  // Ningún campo localizado: el input entero, declarado. Ver la nota de arriba.
  if (!partes.length) return { texto: String(texto).trim(), via: 'input completo', campos_no_hallados: campos }
  return { texto: partes.join('\n\n'), via: [...new Set(vias)].join('+') }
}

// ── Secciones del documento a medio ensamblar ────────────────────────────────
// Los glue leen «§1, §2» o «§1–§8» o «§1 fact sheet, §3 mechanic_specs». Del texto de `reads`
// solo interesan los números; el resto es la glosa para el humano.
function seccionesQueLee(reads) {
  const nums = new Set()
  const t = String(reads || '')
  for (const m of t.matchAll(/§\s*(\d+)\s*[–—-]\s*§?\s*(\d+)/g)) {
    for (let i = Number(m[1]); i <= Number(m[2]); i++) nums.add(String(i))
  }
  for (const m of t.matchAll(/§\s*(\d+)(?!\s*[–—-]\s*§?\s*\d)/g)) nums.add(m[1])
  return [...nums].sort((a, b) => Number(a) - Number(b))
}

// Devuelve el texto de la sección `## N Título` del documento en curso.
function seccionDelDoc(doc, numero) {
  const L = String(doc).split('\n')
  const i = L.findIndex(l => new RegExp(`^##\\s+${numero}(?![\\d.])`).test(l))
  if (i < 0) return null
  const out = [L[i]]
  for (let j = i + 1; j < L.length; j++) {
    if (/^##\s/.test(L[j])) break
    out.push(L[j])
  }
  return out.join('\n').trim()
}

// ── Pointers ─────────────────────────────────────────────────────────────────
function tablaDownstream(lista) {
  return ['| Document | Consuming node |', '|---|---|', ...lista.map(([t, n]) => `| ${t} | ${n} |`)].join('\n')
}

function tablaReferenceStack(texto) {
  const obj = texto ? jsonDelTexto(texto) : null
  const stack = obj ? porRutaJson(obj, 'fact_sheet.reference_stack') ?? porRutaJson(obj, 'reference_stack') : null
  if (!stack) return null
  const filas = (Array.isArray(stack) ? stack : [stack]).map(x =>
    typeof x === 'string' ? `| ${x} | — |` : `| ${x.title ?? x.name ?? JSON.stringify(x)} | ${x.for ?? x.reference_for ?? '—'} |`)
  return ['| Reference | What it is a reference for |', '|---|---|', ...filas].join('\n')
}

// El apéndice ES el mapa de secciones: una fila por sección con de dónde salió y qué faltó.
function tablaSectionMap(entradas) {
  const porSeccion = new Map()
  for (const e of entradas) {
    const s = String(e.section)
    if (!porSeccion.has(s)) porSeccion.set(s, { fuentes: new Set(), huecos: [], verbatim: new Set() })
    const r = porSeccion.get(s)
    if (e.filled && e.source) r.fuentes.add(e.source)
    if (!e.filled) r.huecos.push(e.slot)
    for (const v of (e.verbatim || [])) r.verbatim.add(v)
  }
  const filas = [...porSeccion.entries()].map(([s, r]) => {
    const autorada = r.fuentes.size === 0 && !r.huecos.length
    return `| ${s} | ${autorada ? '3.8 (authored)' : [...r.fuentes].join(', ') || '3.8 (authored)'} | ${[...r.verbatim].join(', ') || '—'} | ${r.huecos.join(', ') || '—'} |`
  })
  return ['| Section | Source | Verbatim fields | Gaps |', '|---|---|---|---|', ...filas].join('\n')
}

// ── Pegamento ────────────────────────────────────────────────────────────────
// El único texto que escribe un modelo, y escribe SOBRE lo ya ensamblado: no recibe los inputs
// crudos sino las secciones del documento, que es lo que el manifiesto declara en `reads`.
// Recibe además el `must_contain` y las `rules` del slot —son el contrato del autor, no una
// sugerencia nuestra— y su techo de palabras, que el verificador comprueba después.
async function glueV2({ slot, sections }) {
  const { callLLM } = require('./llm.service')
  const techo = slot.ceiling_words || 300

  const system = [
    'You write ONE section of an assembled game design document.',
    'Everything you read below is already written and approved by upstream nodes.',
    'You connect and commit; you do not add facts.',
    '',
    'Hard rules:',
    '- Never invent a mechanic, number, name or system that is not in the sections you were given.',
    '- Never restate a section at length. This is a brief, not a summary.',
    `- Ceiling: ${techo} words. Going over fails the gate.`,
    '- Prose and short tables only. No top-level headings: the document already has them.',
    ...(slot.rules || []).map(r => `- ${r}`),
    '',
    slot.must_contain ? `This section MUST carry: ${slot.must_contain}` : '',
  ].filter(Boolean).join('\n')

  const user = [
    `Write: ${slot.slot}`,
    '',
    'Sections you may draw from:',
    ...sections.map(s => `--- §${s.n} ---\n${String(s.texto).slice(0, 14000)}`),
  ].join('\n')

  const res = await callLLM(system, user, {
    model: process.env.ASSEMBLY_GLUE_MODEL || 'anthropic:claude-haiku-4-5-20251001',
    rawText: true,
    temperature: 0.3,
    // Con holgura sobre el techo: un presupuesto justo se gasta razonando y devuelve vacío, que
    // no es lo mismo que no poder escribirlo. El techo lo hace cumplir el verificador.
    maxOutputTokens: Math.round(techo * 3),
  })
  const texto = String(res?.text ?? res ?? '').trim()
  return texto.replace(/^```[\s\S]*?```$/gm, '').replace(/^#{1,2} .*$/gm, '').trim() || null
}

// ── Ensamblado ───────────────────────────────────────────────────────────────
// `opts.glue({ slot, sections, doc })` produce el texto de un slot de pegamento. Sin ella los
// glue quedan en blanco y el ensamble sigue siendo determinista y de cero tokens — es como corre
// la prueba en seco.
async function assembleV2(template, inputs = {}, siblings = {}, opts = {}) {
  const slots = template.manifest.slots
  const manifest = { template_id: template.template_id, slots: [], missing_required: [], omitted_sections: [] }
  // El comentario de cabecera de la plantilla explica la plantilla, no es parte del documento —y
  // como cita un `{{slot:ID}}` de ejemplo, dejarlo dentro hacía fallar la regla que comprueba que
  // no quedó ningún marcador sin sustituir.
  let doc = template.body.replace(/<!--[\s\S]*?-->\n?/g, '')

  const pon = (id, texto) => { doc = doc.split(`{{slot:${id}}}`).join(texto ?? '') }

  // 1 · transcribe
  for (const s of slots.filter(x => x.kind === 'transcribe')) {
    const clave = s.source?.input
    const texto = clave ? inputs[clave] ?? siblings[clave] : null
    const e = { slot: s.slot, section: String(s.section), kind: s.kind, source: clave, required: !!s.required, filled: false, llm_generated: false, verbatim: s.verbatim_fields }
    if (texto == null) {
      // Decisión 4: sin fuente, el slot se omite. No es un fallo del ensamble.
      e.note = 'input ausente — slot omitido'
      if (s.required) manifest.missing_required.push(s.slot)
      manifest.slots.push(e); pon(s.slot, ''); continue
    }
    const r = extraerCampos(texto, s.source?.fields)
    const cuerpo = hundirEncabezados(r.texto)
    e.filled = true; e.via = r.via; e.chars = cuerpo.length; e.source_hash = sha(r.texto)
    if (r.campos_no_hallados) e.campos_no_hallados = r.campos_no_hallados
    manifest.slots.push(e)
    pon(s.slot, cuerpo)
  }

  // 2 · pointer
  for (const s of slots.filter(x => x.kind === 'pointer')) {
    const e = { slot: s.slot, section: String(s.section), kind: s.kind, required: !!s.required, filled: false, llm_generated: false }
    let texto = null
    if (s.slot === 's14.downstream_documents') texto = tablaDownstream(opts.downstream || DOWNSTREAM)
    else if (s.slot === 's14.reference_stack') texto = tablaReferenceStack(inputs[s.source?.input])
    // El mapa de secciones se arma al final, cuando ya se sabe qué se llenó.
    else if (s.slot === 'appendix.section_map') { manifest.slots.push({ ...e, note: 'se arma al final' }); continue }
    if (texto) { e.filled = true; e.chars = texto.length }
    else e.note = 'sin datos para el puntero'
    manifest.slots.push(e)
    pon(s.slot, texto || '')
  }

  // 3 · glue — leen secciones YA ensambladas
  for (const s of slots.filter(x => x.kind === 'glue')) {
    const nums = seccionesQueLee(s.source?.reads)
    const sections = nums.map(n => ({ n, texto: seccionDelDoc(doc, n) })).filter(x => x.texto)
    const e = { slot: s.slot, section: String(s.section), kind: s.kind, required: !!s.required, filled: false, llm_generated: false, reads: nums }
    let texto = null
    if (opts.glue && sections.length) {
      try { texto = await opts.glue({ slot: s, sections, doc, template }) }
      catch (err) { e.note = 'glue falló: ' + err.message }
    } else if (!sections.length) e.note = 'ninguna de las secciones que lee quedó en el documento'
    else e.note = 'glue en seco (sin modelo)'
    if (texto) { e.filled = true; e.llm_generated = true; e.chars = texto.length; e.words = texto.trim().split(/\s+/).length }
    else if (s.required && !opts.glue) e.note = e.note || 'glue no producido'
    manifest.slots.push(e)
    pon(s.slot, texto || '')
  }

  // 4 · el apéndice, con lo que acabó pasando
  const mapa = tablaSectionMap(manifest.slots.filter(x => x.section && x.section !== 'appendix'))
  pon('appendix.section_map', mapa)
  const eMapa = manifest.slots.find(x => x.slot === 'appendix.section_map')
  if (eMapa) { eMapa.filled = true; eMapa.note = undefined; eMapa.chars = mapa.length }

  // 5 · secciones que quedaron sin nada: fuera el encabezado y su línea *Source:*
  doc = omitirSeccionesVacias(doc, manifest)

  const verifier = verificar(template, manifest, doc)
  const gate = manifest.missing_required.length === 0 && verifier.every(v => v.pass)
  return { assembled: doc, manifest, verifier, gate }
}

// Una sección sin contenido es su encabezado, líneas en blanco y la línea *Source:*. Si no queda
// nada más, se va entera — encabezado incluido (decisión 4). La numeración no se toca: es parte
// del texto de la plantilla y las demás secciones conservan la suya.
function omitirSeccionesVacias(doc, manifest) {
  const L = doc.split('\n')
  const out = []
  let i = 0
  while (i < L.length) {
    const m = /^##\s+(\S+)/.exec(L[i])
    if (!m) { out.push(L[i]); i++; continue }
    let j = i + 1
    while (j < L.length && !/^##\s/.test(L[j])) j++
    const cuerpo = L.slice(i + 1, j).filter(l => l.trim() && !/^\*Source:/.test(l.trim()))
    if (!cuerpo.length) { manifest.omitted_sections.push(m[1]); i = j; continue }
    out.push(...L.slice(i, j)); i = j
  }
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n'
}

// El verificador determinista, con las reglas que el manifiesto declara.
function verificar(template, manifest, doc) {
  const slots = manifest.slots
  const glue = slots.filter(s => s.kind === 'glue')
  const porId = Object.fromEntries(template.manifest.slots.map(s => [s.slot, s]))
  return [
    { rule: 'R1 ningún slot requerido sin fuente', pass: manifest.missing_required.length === 0, detail: manifest.missing_required.join(', ') || '—' },
    { rule: 'R2 no queda ningún marcador sin sustituir', pass: !/\{\{slot:/.test(doc), detail: (doc.match(/\{\{slot:[^}]+\}\}/g) || []).join(', ') || '—' },
    { rule: 'R3 solo los glue traen texto de modelo', pass: slots.every(s => !s.llm_generated || s.kind === 'glue'), detail: '—' },
    {
      rule: 'R4 ningún glue pasa su techo de palabras',
      pass: glue.every(s => !s.words || !porId[s.slot]?.ceiling_words || s.words <= porId[s.slot].ceiling_words),
      detail: glue.filter(s => s.words).map(s => `${s.slot}:${s.words}/${porId[s.slot]?.ceiling_words ?? '∞'}`).join(' ') || '—',
    },
  ]
}

module.exports = { assembleV2, getTemplateV2, glueV2, extraerCampos, seccionesQueLee, seccionDelDoc, omitirSeccionesVacias, hundirEncabezados }
