// Simula EN MEMORIA la partición por output de los nodos que alimentan al 3.12, y con eso
// ensambla el TDD. NO ESCRIBE NADA EN LA BASE.
//
// Por qué hace falta: los doce nodos aguas arriba se corrieron en modo nodo entero, así que cada
// uno tiene UN asset general con todo dentro y ninguno por output. El ensamblador busca por
// `output_key` y no encuentra nada — medido: 0 de 12 inputs resueltos, 3 de 21 slots llenos.
//
// Acá se parte ese asset general con el MISMO `extractSection` que usa el motor (no un partidor
// nuevo: uno distinto daría un resultado que no se parece a lo que pasaría de verdad), se guardan
// las piezas en memoria y se le pasan al ensamblador como si fueran assets por output.
//
// Sirve para responder una sola pregunta antes de tocar la base: ¿cuánto del TDD sale de las
// fuentes sin preguntarle a un modelo?
//
// Uso:  node scripts/simular-particion-y-ensamble.js [project_id] [--glue]
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')
const { extractSection } = require('../src/utils/extract-section')
const { assemble, getTemplate, defaultGlue } = require('../src/services/assembler.service')

const PROY    = process.argv.find(a => /^[0-9a-f-]{36}$/.test(a)) || null
const CONGLUE = process.argv.includes('--glue')
const SALIDA  = path.resolve(__dirname, '../../_Prod')

;(async () => {
  const { data: n312 } = await db().from('forge_nodes').select('id,title,outputs').eq('node_key', '3.12').single()
  const { data: ses } = await db().from('forge_sessions')
    .select('project_id,project_node_id').eq('node_id', n312.id)
    .not('project_node_id', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const projectId = PROY || ses?.project_id
  // La instancia tiene que ser la DE ESE PROYECTO. Usar la de la última sesión —que puede ser de
  // otro proyecto— buscaba cables de una instancia ajena y devolvía cero: el ensamble parecía
  // imposible cuando en realidad se estaba mirando el canvas equivocado.
  let pnodeId = (ses && ses.project_id === projectId) ? ses.project_node_id : null
  if (!pnodeId) {
    const { data: pn } = await db().from('forge_project_nodes')
      .select('id').eq('project_id', projectId).eq('node_id', n312.id).limit(1).maybeSingle()
    pnodeId = pn?.id
  }
  if (!pnodeId) { console.error('el 3.12 no está instanciado en ese proyecto'); process.exit(1) }
  const { data: p } = await db().from('projects').select('name').eq('id', projectId).single()
  console.log(`proyecto ${p.name}\n`)

  // ── 1 · los cables que entran, y de qué nodo vienen ──
  const { data: edges } = await db().from('forge_project_edges')
    .select('source_node_id, source_handle, target_handle')
    .eq('project_id', projectId).eq('target_node_id', pnodeId)

  const inputs = {}
  const traza = []

  for (const e of (edges || [])) {
    const th = e.target_handle || '', sh = e.source_handle || ''
    if (!th.startsWith('in-') || !sh.startsWith('out-')) continue
    const puerto = th.slice(3), outKey = sh.slice(4)
    if (inputs[puerto]) continue

    const { data: src } = await db().from('forge_project_nodes')
      .select('node_id, forge_nodes(node_key,title,outputs)').eq('id', e.source_node_id).maybeSingle()
    if (!src?.node_id) continue

    // El asset aprobado del nodo fuente. Si ya hubiera uno por output, se usa tal cual: partir
    // algo que ya viene partido sería inventar un problema.
    const { data: cand } = await db().from('forge_assets')
      .select('name, content, created_at, forge_sessions!session_id(output_key)')
      .eq('project_id', projectId).eq('node_id', src.node_id)
      .in('status', ['approved', 'auto_approved']).neq('format', 'png')
      .order('created_at', { ascending: false })

    const yaPartido = (cand || []).find(a => a.forge_sessions?.output_key === outKey)
    if (yaPartido?.content) {
      inputs[puerto] = yaPartido.content
      traza.push({ puerto, nodo: src.forge_nodes?.node_key, via: 'asset por output', chars: yaPartido.content.length })
      continue
    }

    const general = (cand || []).find(a => a.content)
    if (!general) { traza.push({ puerto, nodo: src.forge_nodes?.node_key, via: 'SIN ASSET', chars: 0 }); continue }

    // La partición simulada: mismo criterio que el motor — corta donde empieza otro output.
    const hermanas = (src.forge_nodes?.outputs || []).map(o => o.key || o.name).filter(Boolean)
    const trozo = extractSection(general.content, outKey, hermanas)
    if (trozo) {
      inputs[puerto] = trozo
      traza.push({ puerto, nodo: src.forge_nodes?.node_key, via: 'partido en memoria', chars: trozo.length, de: general.content.length })
    } else {
      traza.push({ puerto, nodo: src.forge_nodes?.node_key, via: 'NO TIENE SU SECCIÓN', chars: 0, de: general.content.length })
    }
  }

  // ── 2 · los hermanos del propio 3.12 ──
  const siblings = {}
  const { data: own } = await db().from('forge_assets')
    .select('content, forge_sessions!session_id(output_key)')
    .eq('project_id', projectId).eq('node_id', n312.id)
    .in('status', ['approved', 'auto_approved']).neq('format', 'png')
    .order('created_at', { ascending: false })
  for (const a of (own || [])) {
    const k = a.forge_sessions?.output_key
    if (k && !siblings[k] && a.content) siblings[k] = a.content
  }

  console.log('── de dónde sale cada input ──')
  for (const t of traza.sort((a, b) => a.puerto < b.puerto ? -1 : 1)) {
    const detalle = t.via === 'partido en memoria' ? `${t.chars} de ${t.de} chars` : (t.de ? `0 de ${t.de} chars` : '—')
    console.log(`  ${t.puerto.padEnd(24)} ${String(t.nodo).padEnd(6)} ${t.via.padEnd(22)} ${detalle}`)
  }
  console.log(`\ninputs en memoria: ${Object.keys(inputs).length} · siblings: ${Object.keys(siblings).length}`)

  // ── 3 · el ensamble ──
  const tpl = getTemplate('tpl_3_12_tdd_complete')
  const t0 = Date.now()
  const r = await assemble(tpl, inputs, siblings, CONGLUE ? { glue: defaultGlue } : {})
  const ms = Date.now() - t0

  console.log(`\n── slots ──`)
  for (const s of r.manifest.slots) {
    const marca = s.filled ? '✓' : (s.required ? '✗ FALTA' : '· vacío')
    console.log(`  ${String(s.id).padEnd(7)} ${String(s.mode).padEnd(7)} ${marca.padEnd(9)} ${String(Array.isArray(s.from) ? s.from.join('|') : s.from).slice(0, 44)}${s.repeat_items ? ` · ${s.repeat_items} ítems` : ''}`)
  }
  console.log(`\n── verificador ──`)
  for (const v of r.verifier) console.log(`  ${v.pass ? '✓' : '✗'} ${v.rule}${v.detail ? '  · ' + v.detail : ''}`)

  const llenos = r.manifest.slots.filter(s => s.filled).length
  console.log(`\nslots llenos: ${llenos}/${r.manifest.slots.length} · ${ms} ms · tokens de modelo: ${CONGLUE ? 'solo §0.1' : '0'} · gate ${r.gate ? 'PASA' : 'NO PASA'}`)

  if (!r.assembled) return console.log(`\nsin documento: faltan ${r.manifest.missing_required.join(', ')}`)

  fs.mkdirSync(SALIDA, { recursive: true })
  const f = path.join(SALIDA, 'TDD_ensamblado_simulacion.md')
  fs.writeFileSync(f, r.assembled)
  fs.writeFileSync(path.join(SALIDA, 'TDD_ensamblado_manifiesto.json'),
    JSON.stringify({ traza, manifest: r.manifest, verifier: r.verifier, gate: r.gate }, null, 2))
  console.log(`\ndocumento → ${f} (${r.assembled.length} chars)`)
  console.log('NADA se escribió en la base.')
})()
