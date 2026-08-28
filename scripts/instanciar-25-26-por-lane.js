// Instancia 2.5 y 2.6 por lane en un proyecto YA armado, y deja 2.7 como único punto de
// convergencia. La DNA ya mueve el fan-in a 2.7 para proyectos nuevos; esto lo aplica a un canvas
// existente, que no se re-instancia solo.
//
// Qué hace:
//   · la instancia actual de 2.5 y 2.6 se queda con el lane A
//   · se crea una segunda instancia de cada una para el lane B
//   · los cables se reparten: cada lane alimenta SU 2.5 y SU 2.6
//   · 2.7 recibe de las dos: dos decks, dos veredictos, dos casos financieros
//   · se colocan en el layout a la derecha del 2.4 de su lane, para que caigan dentro de la caja
//
// Uso:  node scripts/instanciar-25-26-por-lane.js <project_id>
//       node scripts/instanciar-25-26-por-lane.js <project_id> --apply --backup=<carpeta>
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const PROY    = process.argv[2]
const APLICAR = process.argv.includes('--apply')
const BACKUP  = process.argv.find(a => a.startsWith('--backup='))?.split('=')[1]
if (!PROY) { console.error('uso: <project_id> [--apply] [--backup=carpeta]'); process.exit(1) }

const POR_LANE = ['2.5', '2.6']
const FAN_IN   = '2.7'

;(async () => {
  const { data: pns } = await db().from('forge_project_nodes')
    .select('*, forge_nodes(node_key,title)').eq('project_id', PROY).eq('removed', false)
  const de = k => pns.filter(p => p.forge_nodes?.node_key === k)
  const clave = id => pns.find(p => p.id === id)?.forge_nodes?.node_key ?? '?'
  const laneDe = id => pns.find(p => p.id === id)?.lane_id ?? null

  // Los lanes existentes, en el orden en que aparecen los nodos que ya están instanciados
  const lanes = [...new Set(pns.filter(p => p.lane_id).map(p => p.lane_id))]
  if (lanes.length !== 2) { console.error(`Se esperaban 2 lanes, hay ${lanes.length}. No se toca nada.`); process.exit(1) }
  const [laneA, laneB] = lanes
  console.log(`lanes: A=${String(laneA).slice(0, 8)}  B=${String(laneB).slice(0, 8)}`)

  for (const k of [...POR_LANE, FAN_IN]) {
    const inst = de(k)
    if (inst.length !== 1) { console.error(`${k} tiene ${inst.length} instancia(s); esto asume exactamente 1. No se toca nada.`); process.exit(1) }
    const { count } = await db().from('forge_sessions').select('id', { count: 'exact', head: true }).eq('project_node_id', inst[0].id)
    if (count) { console.error(`${k} tiene ${count} sesión(es). Limpiar antes de re-instanciar. No se toca nada.`); process.exit(1) }
  }

  const { data: edges } = await db().from('forge_project_edges').select('*').eq('project_id', PROY)
  const { data: proyecto } = await db().from('projects').select('canvas_layout').eq('id', PROY).maybeSingle()
  const layout = typeof proyecto?.canvas_layout === 'string' ? JSON.parse(proyecto.canvas_layout) : (proyecto?.canvas_layout || {})

  const posDe = pnId => (layout.nodes || []).find(n => n.id === pnId)?.position ?? null

  // ── Plan ────────────────────────────────────────────────────────────────────────────────────
  const plan = { asignarLane: [], crear: [], edgesBorrar: [], edgesCrear: [], layout: [] }

  for (const k of POR_LANE) {
    const orig = de(k)[0]
    plan.asignarLane.push({ id: orig.id, node_key: k, lane_id: laneA })

    // Copia para el lane B — hereda el bound_item_ref del 2.4 de ese lane
    const refB = de('2.4').find(p => p.lane_id === laneB)?.bound_item_ref ?? null
    const nueva = {
      project_id: PROY, node_id: orig.node_id, blueprint_id: orig.blueprint_id,
      node_type: orig.node_type, order_index: orig.order_index + 3,
      lane_id: laneB, bound_item_ref: refB, removed: false,
    }
    plan.crear.push({ node_key: k, fila: nueva })
  }

  console.log('\n=== cables actuales hacia los nodos afectados ===')
  const afectados = [...POR_LANE, FAN_IN]
  for (const e of edges) {
    const kt = clave(e.target_node_id)
    if (!afectados.includes(kt)) continue
    const ks = clave(e.source_node_id), ls = laneDe(e.source_node_id)
    console.log(`  ${ks}/${ls ? String(ls).slice(0, 6) : 'FUERA'} ${String(e.source_handle).padEnd(24)} → ${kt} ${e.target_handle}`)
  }

  console.log('\n(simulación de reparto — el detalle se imprime al aplicar)')
  console.log(`  2.5 y 2.6: la instancia actual → lane A; se crea una nueva para lane B`)
  console.log(`  cada cable de un lane apunta al 2.5/2.6 de SU lane`)
  console.log(`  2.7 recibe investor_deck y review_verdict de AMBOS lanes`)

  if (BACKUP) {
    fs.mkdirSync(BACKUP, { recursive: true })
    fs.writeFileSync(path.join(BACKUP, 'project_nodes.json'), JSON.stringify(pns, null, 1))
    fs.writeFileSync(path.join(BACKUP, 'project_edges.json'), JSON.stringify(edges, null, 1))
    fs.writeFileSync(path.join(BACKUP, 'canvas_layout.json'), JSON.stringify(layout, null, 1))
    console.log(`\nrespaldo → ${BACKUP}`)
  }
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  // ── 1 · la instancia actual pasa al lane A ──────────────────────────────────────────────────
  for (const a of plan.asignarLane) {
    const refA = de('2.4').find(p => p.lane_id === laneA)?.bound_item_ref ?? null
    await db().from('forge_project_nodes').update({ lane_id: a.lane_id, bound_item_ref: refA }).eq('id', a.id)
    console.log(`  ${a.node_key}: instancia existente → lane A`)
  }

  // ── 2 · se crean las del lane B ─────────────────────────────────────────────────────────────
  const nuevos = {}
  for (const c of plan.crear) {
    const { data, error } = await db().from('forge_project_nodes').insert(c.fila).select('id').single()
    if (error) { console.error(`  ✗ ${c.node_key}: ${error.message}`); process.exit(1) }
    nuevos[c.node_key] = data.id
    console.log(`  ${c.node_key}: creada para lane B · pn=${data.id.slice(0, 8)}`)
  }

  // ── 3 · reparto de cables ───────────────────────────────────────────────────────────────────
  const origA = Object.fromEntries(POR_LANE.map(k => [k, de(k)[0].id]))
  const idPorLane = (k, lane) => lane === laneB ? nuevos[k] : origA[k]

  for (const e of edges) {
    const kt = clave(e.target_node_id)
    if (!POR_LANE.includes(kt)) continue
    const ls = laneDe(e.source_node_id)
    if (!ls) continue                                    // viene de fuera de los lanes: se queda
    const destinoCorrecto = idPorLane(kt, ls)
    if (destinoCorrecto === e.target_node_id) continue    // ya apunta bien
    await db().from('forge_project_edges').update({ target_node_id: destinoCorrecto }).eq('id', e.id)
    console.log(`  cable ${clave(e.source_node_id)}/${String(ls).slice(0, 6)} → ${kt} reapuntado a su lane`)
  }

  // 2.6 lane B ← 2.5 lane B (investor_deck)
  const pn27 = de(FAN_IN)[0].id
  const e25a26 = edges.find(e => clave(e.source_node_id) === '2.5' && clave(e.target_node_id) === '2.6')
  if (e25a26) {
    await db().from('forge_project_edges').insert({
      project_id: PROY, source_node_id: nuevos['2.5'], target_node_id: nuevos['2.6'],
      source_handle: e25a26.source_handle, target_handle: e25a26.target_handle, is_auto: true,
    })
    console.log('  cable 2.5/B → 2.6/B (investor_deck) creado')
  }
  // 2.7 ← 2.5 lane B y 2.6 lane B
  for (const [k, handle] of [['2.5', 'investor_deck'], ['2.6', 'review_verdict']]) {
    const modelo = edges.find(e => clave(e.source_node_id) === k && clave(e.target_node_id) === FAN_IN)
    if (!modelo) continue
    await db().from('forge_project_edges').insert({
      project_id: PROY, source_node_id: nuevos[k], target_node_id: pn27,
      source_handle: modelo.source_handle, target_handle: modelo.target_handle, is_auto: true,
    })
    console.log(`  cable ${k}/B → 2.7 (${handle}) creado`)
  }

  // ── 4 · posiciones: a la derecha del 2.4 de su lane ─────────────────────────────────────────
  const nodos = Array.isArray(layout.nodes) ? [...layout.nodes] : []
  const ANCHO = 250
  for (const k of POR_LANE) {
    const iOrden = POR_LANE.indexOf(k) + 1
    for (const [lane, pnId] of [[laneA, origA[k]], [laneB, nuevos[k]]]) {
      const ref = de('2.4').find(p => p.lane_id === lane)
      const base = ref ? posDe(ref.id) : null
      if (!base) continue
      const pos = { x: base.x + ANCHO * iOrden, y: base.y }
      const i = nodos.findIndex(n => n.id === pnId)
      if (i >= 0) nodos[i] = { ...nodos[i], position: pos }
      else nodos.push({ id: pnId, position: pos })
      console.log(`  ${k}/${lane === laneA ? 'A' : 'B'} colocado en x=${pos.x} y=${pos.y}`)
    }
  }
  await db().from('projects').update({ canvas_layout: { ...layout, nodes: nodos } }).eq('id', PROY)

  // ── verificación ────────────────────────────────────────────────────────────────────────────
  console.log('\n=== verificación posterior ===')
  const { data: v } = await db().from('forge_project_nodes')
    .select('id,lane_id,forge_nodes(node_key)').eq('project_id', PROY).eq('removed', false)
  for (const k of [...POR_LANE, FAN_IN]) {
    const inst = v.filter(x => x.forge_nodes?.node_key === k)
    console.log(`  ${k}: ${inst.length} instancia(s) · ${inst.map(i => i.lane_id ? String(i.lane_id).slice(0, 6) : 'FUERA').join(', ')}`)
  }
  const { data: ve } = await db().from('forge_project_edges').select('*').eq('project_id', PROY)
  const nom = id => {
    const p = v.find(x => x.id === id)
    return p ? `${p.forge_nodes?.node_key}/${p.lane_id ? String(p.lane_id).slice(0, 6) : 'FUERA'}` : '?'
  }
  console.log('\n  cables hacia 2.5, 2.6 y 2.7:')
  for (const e of ve.filter(x => ['2.5', '2.6', '2.7'].includes(nom(x.target_node_id).split('/')[0]))) {
    console.log(`     ${nom(e.source_node_id).padEnd(14)} ${String(e.source_handle).padEnd(24)} → ${nom(e.target_node_id)}`)
  }
})()
