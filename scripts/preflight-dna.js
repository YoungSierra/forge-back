// ─── Preflight de ADN: ¿los nodos están listos para GENERAR? (SOLO LECTURA) ────────────────
//
// Independiente de proyecto y de canvas. Los nodos 3.x viven en preview/archived y se sacan al
// canvas con un atajo — eso NO es un bloqueador. Lo que sí bloquea es el ADN incompleto:
//   · skills declaradas que no están en forge_skill_configs, o registradas sin r2_path (no bajan)
//   · inputs required que ningún nodo produce (ni por key, ni por fan-out list<T>→single<T>)
//   · outputs sin prompt (el motor no sabe qué pedir)
//   · executor sin model
//   · tools declaradas que no están implementadas
//
// Uso:  node scripts/preflight-dna.js [desde] [hasta]
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const ver = k => String(k).split('.').map(Number)
const cmp = (a, b) => (ver(a)[0] - ver(b)[0]) || ((ver(a)[1] ?? 0) - (ver(b)[1] ?? 0))
const FROM = process.argv[2] ?? '3.0'
const TO   = process.argv[3] ?? '3.22'
const IMPLEMENTED_TOOLS = new Set(['doc_gen_docx', 'doc_gen_pptx', 'web_fetch', 'kb_read', 'image_gen'])

;(async () => {
  const { data: nodes } = await db().from('forge_nodes')
    .select('node_key, title, phase, status, inputs, outputs, skills, tools, executor, metadata, default_prompt')
  const { data: skillRows } = await db().from('forge_skill_configs').select('key, r2_path')
  const skillMap = new Map((skillRows || []).map(s => [s.key, s]))

  // productores por key, y tipos list<T> disponibles (fan-out)
  const producedKeys = new Set()
  const listTypes = new Set()
  for (const n of nodes) for (const o of (Array.isArray(n.outputs) ? n.outputs : [])) {
    const k = o.key || o.name
    if (k) producedKeys.add(k)
    const T = String(o.format || '').match(/^list<(.+)>$/)?.[1] ?? String(o.type || '').match(/^list<(.+)>$/)?.[1]
    if (T) listTypes.add(T)
  }

  const target = nodes
    .filter(n => n.phase === 'pre-production' && cmp(n.node_key, FROM) >= 0 && cmp(n.node_key, TO) <= 0)
    .sort((a, b) => cmp(a.node_key, b.node_key))

  console.log(`PREFLIGHT DE ADN — nodos ${FROM} … ${TO}   (¿listos para generar?)`)
  console.log('='.repeat(88))

  let anyFail = false
  const rows = []
  for (const n of target) {
    const probs = []
    const warns = []
    const wired = Array.isArray(n.inputs?.wired) ? n.inputs.wired : []
    const outs  = Array.isArray(n.outputs) ? n.outputs : []

    for (const s of (n.skills || [])) {
      const reg = skillMap.get(s)
      if (!reg) probs.push(`skill sin registrar: ${s}`)
      else if (!reg.r2_path) probs.push(`skill sin r2_path (no baja): ${s}`)
    }
    for (const i of wired.filter(x => x.required)) {
      const byKey = producedKeys.has(i.key)
      const byFanout = i.cardinality === 'single' && i.type && listTypes.has(i.type)
      if (!byKey && !byFanout) probs.push(`input required huérfano: ${i.key} (nadie lo produce)`)
    }
    // Un output sin prompt NO es bloqueador: canvas-chat.service.js:307-310 compone
    // basePrompt = [node.default_prompt, targetOutput.prompt].filter(Boolean) — con el
    // default_prompt del nodo alcanza (probado: 3.9 ADI_11.1_ConceptArt no tiene prompt propio
    // y generó 102.941 chars). Solo bloquea si el nodo TAMPOCO tiene default_prompt.
    // Los bundles manuales (zip/repo_link/build_artifact) los arma el humano — ni warning.
    const NO_LLM = /^(zip|png|repo_link|build_artifact)/i
    const noPrompt = outs.filter(o => !String(o.prompt || '').trim() && !NO_LLM.test(String(o.format || '')))
    if (noPrompt.length && !String(n.default_prompt || '').trim()) {
      probs.push(`${noPrompt.length} output(s) sin prompt Y el nodo no tiene default_prompt: ${noPrompt.map(o => o.key || o.name).join(', ')}`)
    } else if (noPrompt.length) {
      warns.push(`${noPrompt.length} output(s) heredan el default_prompt del nodo: ${noPrompt.map(o => o.key || o.name).slice(0, 4).join(', ')}${noPrompt.length > 4 ? '…' : ''}`)
    }
    if (!n.executor?.model) probs.push('executor sin model')
    for (const t of (n.tools || [])) if (!IMPLEMENTED_TOOLS.has(t)) probs.push(`tool no implementada: ${t}`)
    if (!outs.length) probs.push('sin outputs declarados')

    const ok = !probs.length
    if (!ok) anyFail = true
    rows.push({ k: n.node_key, t: n.title, ok, probs, warns, dna: n.metadata?.dna_version, preview: n.metadata?.preview, status: n.status, outs: outs.length, skills: (n.skills || []).length })
  }

  for (const r of rows) {
    console.log(`\n── ${r.k.padEnd(5)} ${r.t.padEnd(34)} ${r.ok ? '[LISTO ✓]' : '[INCOMPLETO ✗]'}`)
    console.log(`     dna=${r.dna ?? '?'}  status=${r.status}  preview=${r.preview ?? '?'}  outputs=${r.outs}  skills=${r.skills}`)
    for (const p of r.probs) console.log(`     ✗ ${p}`)
    for (const w of (r.warns||[])) console.log(`     · ${w}`)
  }

  console.log('\n' + '='.repeat(88))
  const listos = rows.filter(r => r.ok).length
  console.log(`RESUMEN: ${listos}/${rows.length} nodos con ADN completo`)
  for (const r of rows.filter(x => !x.ok)) console.log(`  ✗ ${r.k.padEnd(6)} ${r.t.padEnd(32)} ${r.probs.length} problema(s)`)
  if (!anyFail) console.log('  Todos los nodos del rango tienen ADN completo — se pueden generar.')
})().catch(e => { console.error(e); process.exit(1) })
