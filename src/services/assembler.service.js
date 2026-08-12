// ─── Assembler service · piloto 0 (v2.9.1) ──────────────────────────────────
// Motor de ensamble determinista. AISLADO: no lo invoca ningún flujo de canvas.
// Fiel a "Ensamble - Filosofía y mecanismo" + contratos de Pedro (05-ago):
//   from namespaceado: "input:<key>" | "sibling:<key>"
//   modos: copy (verbatim) · repeat (split por ID estable) · glue (stub, sin LLM)
//   manifiesto con source_hash por slot · 4 reglas del verificador · hard-block.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const TPL_DIR = path.join(__dirname, '..', 'assembly_templates')

function sha(t) { return crypto.createHash('sha256').update(String(t), 'utf8').digest('hex').slice(0, 12) }

// Carga una plantilla del catálogo local (calcado del patrón getSkill).
function getTemplate(id) {
  return JSON.parse(fs.readFileSync(path.join(TPL_DIR, id + '.json'), 'utf8'))
}

// Resuelve UN ref "input:<key>" | "sibling:<key>" contra los dos pools.
function resolveOne(ref, inputs, siblings) {
  const i = String(ref).indexOf(':')
  const ns = String(ref).slice(0, i), key = String(ref).slice(i + 1)
  const pool = ns === 'input' ? inputs : ns === 'sibling' ? siblings : null
  return pool ? pool[key] : undefined
}

// Compat: para slots de un solo origen (copy/repeat) devuelve el primero resuelto.
function resolve(from, inputs, siblings) {
  const refs = Array.isArray(from) ? from : [from]
  for (const r of refs) {
    const v = resolveOne(r, inputs, siblings)
    if (v != null) return v
  }
  return undefined
}

// Los slots `glue` declaran VARIAS fuentes: devuelve todas las que resolvieron, con su ref.
function resolveAll(from, inputs, siblings) {
  const refs = Array.isArray(from) ? from : [from]
  return refs.map(r => ({ ref: r, content: resolveOne(r, inputs, siblings) })).filter(x => x.content != null)
}

// repeat: parte por header de ID estable '### PREFIX-NN Title' (contrato F-4),
// nunca por '###' ciego; ordena ascendente por NN → reproducibilidad byte a byte.
function splitStableId(content) {
  const re = /^### [A-Z]+-\d{2} .*$/gm
  const idx = []; let m
  while ((m = re.exec(content)) !== null) idx.push(m.index)
  if (!idx.length) return []
  const items = idx.map((start, i) => content.slice(start, i + 1 < idx.length ? idx[i + 1] : content.length).trim())
  const nn = s => parseInt((s.match(/^### [A-Z]+-(\d{2})/) || [])[1], 10)
  return items.sort((a, b) => nn(a) - nn(b))
}

// Pegamento por defecto: LLM CHICO, y sólo para conectar lo que ya validaron los nodos.
// Nunca es fuente de verdad — por eso R4 exige que ningún slot que no sea `glue` traiga
// contenido de modelo. Si falla, el slot queda vacío en vez de romper el ensamble: los slots
// de pegamento son opcionales por contrato.
async function defaultGlue({ slot, sources }) {
  const { callLLM } = require('./llm.service')
  const rules = slot.glue_rules || {}
  const system = [
    'You write CONNECTIVE TISSUE for an assembled design document.',
    'The surrounding sections are already written and validated by upstream nodes.',
    'Your job is to connect them, NOT to add information.',
    'Hard rules:',
    '- Do NOT invent facts, mechanics, numbers or proper nouns that are not in the sources.',
    '- Do NOT restate the sources at length; write the bridge, not a summary of everything.',
    '- Output prose only: no headings, no bullet lists, no markdown fences.',
    rules.instruction ? `- Additional rule from the template: ${rules.instruction}` : '',
  ].filter(Boolean).join('\n')

  const user = [
    `Section to write: ${slot.heading || slot.id}`,
    '',
    'Sources:',
    ...sources.map(s => `--- ${s.ref} ---\n${String(s.content).slice(0, 12000)}`),
  ].join('\n')

  const res = await callLLM(system, user, {
    model:           process.env.ASSEMBLY_GLUE_MODEL || 'anthropic:claude-haiku-4-5-20251001',
    rawText:         true,
    temperature:     0.3,
    maxOutputTokens: rules.max_tokens || 300,
  })
  const text = String(res?.text ?? res ?? '').trim()
  // El pegamento no puede traer estructura: si el modelo metió headings o fences, se limpian.
  return text.replace(/^```[\s\S]*?```$/gm, '').replace(/^#{1,6} .*$/gm, '').trim() || null
}

// Ensambla un artefacto + manifiesto y corre el verificador determinista.
// `opts.glue`: función async para los slots de pegamento. Si no se pasa, quedan en stub
// (comportamiento del piloto: determinista y 0 tokens).
async function assemble(template, inputs = {}, siblings = {}, opts = {}) {
  const doc = []
  const manifest = { template_id: template.template_id, slots: [], missing_required: [] }

  for (const slot of template.slots) {
    const entry = { id: slot.id, mode: slot.mode, from: slot.from, required: !!slot.required, filled: false, llm_generated: false }

    if (slot.mode === 'glue') {
      const sources = resolveAll(slot.from, inputs, siblings)
      if (!opts.glue || !sources.length) {
        entry.note = !sources.length ? 'glue sin fuentes resueltas' : 'glue stubbed (no LLM); optional by contract'
        if (slot.required && !sources.length) manifest.missing_required.push(slot.id)
        manifest.slots.push(entry); continue
      }
      let text = null
      try { text = await opts.glue({ slot, sources, template }) }
      catch (e) { entry.note = 'glue falló: ' + e.message }
      if (text) {
        doc.push(`## ${slot.id} ${slot.heading}\n\n${text}`)
        entry.filled = true; entry.llm_generated = true
        entry.source_refs = sources.map(s => s.ref)
        entry.source_hash = sha(sources.map(s => s.content).join('\n'))
      } else if (slot.required) manifest.missing_required.push(slot.id)
      manifest.slots.push(entry); continue
    }
    const content = resolve(slot.from, inputs, siblings)
    if (content == null) {
      if (slot.required) manifest.missing_required.push(slot.id)
      manifest.slots.push(entry); continue
    }
    let body
    if (slot.mode === 'repeat') { const items = splitStableId(content); entry.repeat_items = items.length; body = items.length ? items.join('\n\n') : String(content).trim() }
    else { body = String(content).trim() }
    doc.push(`## ${slot.id} ${slot.heading}\n\n${body}`)
    entry.filled = true; entry.source_hash = sha(content)
    manifest.slots.push(entry)
  }

  const ok = manifest.missing_required.length === 0
  const assembled = ok ? `# Assembled by ${template.template_id}\n\n` + doc.join('\n\n---\n\n') + '\n' : null

  // Verificador determinista (las 4 reglas del doc de assembly)
  const filled = new Set(manifest.slots.filter(e => e.filled).map(e => e.id))
  const req = template.slots.filter(s => s.required)
  const rep = manifest.slots.filter(e => e.mode === 'repeat' && e.filled)
  const verifier = [
    { rule: 'R1 required slots filled', pass: req.every(s => filled.has(s.id)), detail: manifest.missing_required.length ? 'missing: ' + manifest.missing_required.join(',') : '—' },
    { rule: 'R2 every filled from resolved', pass: manifest.slots.filter(e => e.filled).every(e => resolve(e.from, inputs, siblings) != null), detail: '' },
    { rule: 'R3 repeat slots have >=1 item', pass: rep.every(e => (e.repeat_items || 0) >= 1), detail: rep.map(e => `${e.id}:${e.repeat_items}`).join(' ') },
    { rule: 'R4 only glue may carry LLM content', pass: manifest.slots.every(e => !e.llm_generated || e.mode === 'glue'), detail: '' },
  ]
  const gate = ok && verifier.every(v => v.pass)
  return { assembled, manifest, verifier, gate }
}

module.exports = { assemble, resolve, resolveAll, defaultGlue, getTemplate, sha, splitStableId }
