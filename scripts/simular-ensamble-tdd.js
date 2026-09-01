// Simula el ensamble del TDD del 3.12 contra un proyecto vivo, SIN tocar la DNA ni la BD.
//
// Para qué: hoy el 3.12 le manda al modelo 465.595 chars de fuentes (≈116.400 tokens) para que las
// COPIE, y tarda entre cuatro y once minutos. La mayor parte del TDD no se redacta: se pega. Esto
// mide cuánto de ese documento sale de las fuentes sin preguntarle nada a un modelo.
//
// No escribe nada: deja el documento y el manifiesto en disco para que el equipo los revise. El
// cambio de `tdd_complete` a `assembly: true` es una decisión posterior y aparte.
//
// Uso:  node scripts/simular-ensamble-tdd.js [project_id] [--glue]
//       --glue  corre el pegamento con el LLM chico (§0.1). Sin la bandera queda en stub y el
//               ensamble cuesta CERO tokens.
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')
const { assemble, getTemplate, defaultGlue } = require('../src/services/assembler.service')
const { resolveAssemblyPools } = require('../src/services/canvas-chat.service')

const PROY   = process.argv.find(a => /^[0-9a-f-]{36}$/.test(a)) || null
const CONGLUE = process.argv.includes('--glue')
const SALIDA = path.resolve(__dirname, '../../_Prod')

;(async () => {
  const { data: n } = await db().from('forge_nodes').select('id,title,outputs').eq('node_key', '3.12').single()

  // La instancia: la que corrió, o la del proyecto que se pase.
  const { data: ses } = await db().from('forge_sessions')
    .select('project_id,project_node_id').eq('node_id', n.id)
    .not('project_node_id', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const projectId = PROY || ses?.project_id
  const pnodeId   = (!PROY || ses?.project_id === PROY) ? ses?.project_node_id : null
  if (!projectId || !pnodeId) { console.error('no encontré la instancia del 3.12'); process.exit(1) }

  const { data: p } = await db().from('projects').select('name').eq('id', projectId).single()
  console.log(`proyecto ${p.name} · instancia ${pnodeId.slice(0, 8)}\n`)

  const pools = await resolveAssemblyPools(db, {
    projectId, currentPNodeId: pnodeId, node: n, outputDefs: n.outputs || [],
  })
  const { inputs, siblings } = pools
  const tam = o => Object.entries(o).map(([k, v]) => `${k}(${String(v).length})`)
  console.log(`inputs resueltos   (${Object.keys(inputs).length}): ${tam(inputs).join(' ') || '—'}`)
  console.log(`siblings resueltos (${Object.keys(siblings).length}): ${tam(siblings).join(' ') || '—'}\n`)

  const tpl = getTemplate('tpl_3_12_tdd_complete')
  const t0 = Date.now()
  const r = await assemble(tpl, inputs, siblings, CONGLUE ? { glue: defaultGlue } : {})
  const ms = Date.now() - t0

  console.log(`── slots ──`)
  for (const s of r.manifest.slots) {
    const marca = s.filled ? '✓' : (s.required ? '✗ FALTA (requerido)' : '· vacío (opcional)')
    const extra = s.repeat_items ? ` ${s.repeat_items} ítems` : (s.note ? ` — ${s.note}` : '')
    console.log(`  ${String(s.id).padEnd(7)} ${String(s.mode).padEnd(7)} ${marca.padEnd(20)} ${String(Array.isArray(s.from) ? s.from.join('|') : s.from).slice(0, 46)}${extra}`)
  }

  console.log(`\n── verificador ──`)
  for (const v of r.verifier) console.log(`  ${v.pass ? '✓' : '✗'} ${v.rule}${v.detail ? '  · ' + v.detail : ''}`)
  console.log(`  gate: ${r.gate ? 'PASA' : 'NO PASA'}`)

  const llenos = r.manifest.slots.filter(s => s.filled).length
  console.log(`\nslots llenos: ${llenos}/${r.manifest.slots.length} · ${ms} ms · tokens de modelo: ${CONGLUE ? 'solo el pegamento de §0.1' : '0'}`)

  if (!r.assembled) {
    console.log(`\nsin documento: faltan requeridos → ${r.manifest.missing_required.join(', ')}`)
    return
  }
  fs.mkdirSync(SALIDA, { recursive: true })
  const fDoc = path.join(SALIDA, 'TDD_ensamblado_simulacion.md')
  const fMan = path.join(SALIDA, 'TDD_ensamblado_manifiesto.json')
  fs.writeFileSync(fDoc, r.assembled)
  fs.writeFileSync(fMan, JSON.stringify({ manifest: r.manifest, verifier: r.verifier, gate: r.gate }, null, 2))
  console.log(`\ndocumento  → ${fDoc}  (${r.assembled.length} chars)`)
  console.log(`manifiesto → ${fMan}`)
})()
