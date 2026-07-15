// ─── Preflight de nodos: ¿qué falta para poder correr X? (SOLO LECTURA, no gasta crédito) ───
//
// Modela la resolución REAL de resolveNodeInputs (canvas-chat.service.js:106-160) para cada input:
//   1. PRECISO  — existe el asset del output por name exacto "Título — Label"
//   2. FALLBACK — no existe, pero el nodo fuente tiene algún asset aprobado: el motor cae al más
//                 reciente + extractSection("## <key>"). Si la sección existe → sirve esa; si no,
//                 inyecta el DOCUMENTO ENTERO (impreciso, puede arrastrar vocabulario ajeno).
//   3. FALTA    — el nodo fuente no corrió: no hay nada que inyectar.
//   4. HUERFANO — ningún nodo declara ese output key: el auto-wire nunca podrá cablearlo.
//
// Uso:  node scripts/preflight-nodes.js <project_id> [desde] [hasta]
//       node scripts/preflight-nodes.js e8a34c89-... 3.14 3.22
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { extractSection } = require('../src/utils/extract-section')

const PROJECT = process.argv[2]
if (!PROJECT) { console.error('uso: node scripts/preflight-nodes.js <project_id> [desde] [hasta]'); process.exit(1) }

// Comparación de versión por tupla (3.2 < 3.13). Un parseFloat compara 3.2 > 3.13 — mal.
const ver = k => String(k).split('.').map(Number)
const cmp = (a, b) => (ver(a)[0] - ver(b)[0]) || ((ver(a)[1] ?? 0) - (ver(b)[1] ?? 0))
const inRange = (k, from, to) => cmp(k, from) >= 0 && cmp(k, to) <= 0
const FROM = process.argv[3] ?? '3.0'
const TO   = process.argv[4] ?? '3.22'
const labelOf = o => (typeof o === 'object' ? (o.label || o.name || o.key) : o)

;(async () => {
  // TODOS los nodos (no solo pre-production): concept_data lo produce la fase de concepto.
  const { data: nodes, error } = await db()
    .from('forge_nodes').select('id, node_key, title, phase, status, inputs, outputs, skills')
  if (error) throw error
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]))

  const { data: assets } = await db()
    .from('forge_assets').select('name, content, node_id, status')
    .eq('project_id', PROJECT).in('status', ['approved', 'auto_approved']).neq('format', 'png')

  const assetsByNode = {}
  for (const a of (assets || [])) (assetsByNode[a.node_id] ||= []).push(a)
  const assetByName = new Map((assets || []).map(a => [(a.name || '').toLowerCase().trim(), a]))

  const { data: skillRows } = await db().from('forge_skill_configs').select('key')
  const haveSkills = new Set((skillRows || []).map(s => s.key))

  // nodos realmente cargados en el canvas del proyecto
  const { data: pns } = await db()
    .from('forge_project_nodes').select('node_id').eq('project_id', PROJECT).eq('removed', false)
  const onCanvas = new Set((pns || []).map(p => p.node_id))

  // key -> [{node, outputDef}]
  const producers = {}
  for (const n of nodes) for (const o of (Array.isArray(n.outputs) ? n.outputs : [])) {
    const key = o.key || o.name
    if (key) (producers[key] ||= []).push({ n, o })
  }

  // Fan-out (Instancing Brief v1.2, fan-out.service.js): un output list<T> alimenta un port
  // single<T> instanciando una lane por ítem. El port NO se cablea por key — se satisface por TIPO.
  // Sin esto el preflight marca "huérfano" un puerto que en realidad es el disparador del fan-out.
  //
  // ⚠ NO "arreglar" el puerto `mechanic_spec` (singular) de 3.16 Prototype Specification.
  // Parece un typo frente al output `mechanic_specs` (plural) de 3.2 y estuvo listado como bug a
  // corregir, pero es el CONTRATO DE INSTANCING: 3.2 emite format "list<mechanic_spec>" ⇒ T =
  // "mechanic_spec", que matchea el port {type:"mechanic_spec", cardinality:"single"} de 3.16
  // (fan-out.service.js:216). Ponerle la "s" mata el fan-out y le mete TODAS las mecánicas a cada
  // instancia, en vez de una por lane. Un port single<T> sin productor por key NO es huérfano:
  // buscar primero un list<T>.
  function fanoutSource(port) {
    if (port.cardinality !== 'single' || !port.type) return null
    for (const n of nodes) for (const o of (Array.isArray(n.outputs) ? n.outputs : [])) {
      const T = String(o.format || '').match(/^list<(.+)>$/)?.[1] ?? String(o.type || '').match(/^list<(.+)>$/)?.[1]
      if (T && T === port.type) return { n, o }
    }
    return null
  }

  function resolve(portKey, port) {
    const prods = producers[portKey] || []
    if (!prods.length) {
      const fo = port && fanoutSource(port)
      if (fo) return {
        state: 'FAN-OUT',
        detail: `${fo.n.node_key} emite ${fo.o.key || fo.o.name} (${fo.o.format || fo.o.type}) → instancia 1 lane por ítem. NO es un port a cablear.`,
      }
      return { state: 'HUERFANO', detail: 'ningún nodo declara este output' }
    }
    for (const { n, o } of prods) {
      const exact = assetByName.get(`${n.title} — ${labelOf(o)}`.toLowerCase().trim())
      if (exact) return { state: 'PRECISO', detail: `${n.node_key} → asset propio` }
    }
    for (const { n } of prods) {
      const any = (assetsByNode[n.id] || [])
      if (any.length) {
        const recent = any[any.length - 1]
        const sec = extractSection(recent.content || '', portKey)
        return {
          state: 'FALLBACK',
          detail: sec
            ? `${n.node_key} → sección "## ${portKey}" de «${recent.name}» (${sec.length} chars)`
            : `${n.node_key} → SIN sección "## ${portKey}": inyecta «${recent.name}» ENTERO (${(recent.content || '').length} chars)`,
          weak: !sec,
        }
      }
    }
    return { state: 'FALTA', detail: `lo produce ${prods.map(p => p.n.node_key).join(',')} — sin correr` }
  }

  console.log(`PREFLIGHT — proyecto ${PROJECT}   nodos ${FROM} … ${TO}`)
  console.log('='.repeat(92))
  const summary = []

  for (const n of nodes.filter(x => x.phase === 'pre-production' && inRange(x.node_key, FROM, TO)).sort((a, b) => cmp(a.node_key, b.node_key))) {
    const wired = Array.isArray(n.inputs?.wired) ? n.inputs.wired : []
    const rows = wired.map(i => ({ port: i.key, required: !!i.required, ...resolve(i.key, i) }))
    const blockers = rows.filter(r => r.required && (r.state === 'FALTA' || r.state === 'HUERFANO'))
    const weak = rows.filter(r => r.required && r.state === 'FALLBACK' && r.weak)
    const missSkills = (n.skills || []).filter(s => !haveSkills.has(s))
    const outs = Array.isArray(n.outputs) ? n.outputs : []
    const done = outs.filter(o => assetByName.has(`${n.title} — ${labelOf(o)}`.toLowerCase().trim())).length
    const ranGeneral = (assetsByNode[n.id] || []).some(a => /— output$/i.test((a.name || '').trim()))

    const inCanvas = onCanvas.has(n.id)
    const verdict = !inCanvas ? 'NO EN CANVAS' : (blockers.length ? 'BLOQUEADO' : (done === outs.length && outs.length ? 'YA CORRIDO' : 'LISTO'))
    summary.push({ k: n.node_key, t: n.title, verdict, b: blockers.length, w: weak.length, s: missSkills.length })

    console.log(`\n── ${n.node_key}  ${n.title}   [${verdict}]   status=${n.status}  assets propios ${done}/${outs.length}` +
      (ranGeneral ? '  (corrió en modo GENERAL — outputs no materializados por key)' : ''))
    if (!inCanvas) console.log(`   ! el nodo NO está cargado en el canvas del proyecto — cargá el blueprint que lo incluya antes de nada`)
    for (const r of rows) {
      const mark = { PRECISO: '✓', FALLBACK: r.weak ? '~' : '✓', FALTA: '✗', HUERFANO: '✗', 'FAN-OUT': '⇉' }[r.state]
      console.log(`   ${mark} ${String(r.port).padEnd(20)} ${r.required ? 'REQ' : 'opt'}  ${r.state.padEnd(8)} ${r.detail}`)
    }
    if (missSkills.length) console.log(`   ! skills NO registradas: ${missSkills.join(', ')}`)
  }

  console.log('\n' + '='.repeat(92))
  console.log('RESUMEN')
  for (const s of summary) console.log(`  ${s.k.padEnd(6)} ${s.t.padEnd(32)} ${s.verdict.padEnd(11)}` +
    (s.b ? ` ${s.b} req faltan` : '') + (s.w ? ` · ${s.w} req resuelven por doc entero` : '') + (s.s ? ` · ${s.s} skill(s) sin registrar` : ''))
})().catch(e => { console.error(e); process.exit(1) })
