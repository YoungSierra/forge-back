// ─── Engine v1.8 · disparo automático de la regeneración del slice ──────────────────────────────────
//
// Regla de dirección de arte (09-10): al aprobarse el Vertical Slice Specification (3.13), Forge reescribe SOLO
// los cuatro desgloses del ADD (§7.3.1 · §7.9.1 · §7.10.1 · §7.11.1), vuelve a pasar el Conformance Gate y
// reextrae los paquetes ADI. No es un botón opcional: es un paso de la cadena. El botón «Regenerate slice
// breakdowns» del 3.9 queda como reintento (misma función, `regenerarSlice`).
//
// Nada aquí nombra al 3.9 ni al 3.13: el consumidor es el nodo cuya salida por secciones declara
// `batches.slice_scope.from_node === <nodo aprobado>` y tiene grupos `slice_dependent` (la misma declaración
// que lee `alcanceDelSlice`). Se llama UNA vez por acción (Accept, auto-run), no por output: un Run entero del
// 3.13 aprueba vs_spec y luego vs_spec_doc y dispara una sola regeneración.
//
// Guardas antes de gastar: consumidor presente en el proyecto, blueprint no sellado, documento aprobado del
// consumidor (sin él no hay nada que regenerar: la próxima corrida ya recibe el alcance), crédito de la org
// (el mismo `canRun` de creditGate, sin respuesta HTTP) y «no en curso» (cerrojo en proceso por proyecto +
// salida). La regeneración corre en segundo plano: la respuesta del Accept/auto-run lleva
// `slice_regeneration: [{ node_key, output_key, started: true } | { skipped: '…' }]`. Si falla, executeOneOutput
// deja el rastro v1.4 (sesión abandoned, mensaje `system` en el hilo del consumidor, fila de log `error`).
'use strict'
const T = require('./tandas.service'), X = require('./extraccion.service')

const publico = (code, msg, status = 422) => { const e = new Error(msg); e.code = code; e.publico = true; e.status = status; return e }
const enCurso = new Map()   // `${project_id}:${node_id}:${output_key}` → promesa de la corrida en segundo plano

/** Los nodos cuya salida por secciones toma su alcance del nodo `node_key` (declaración `slice_scope` de la DNA). */
async function consumidoresDelSlice(db, node_key) {
  const { data } = await db().from('forge_nodes').select('id, node_key, title, outputs')
    .contains('outputs', [{ batches: { slice_scope: { from_node: String(node_key) } } }])
  const out = []
  for (const n of data || []) {
    for (const o of (Array.isArray(n.outputs) ? n.outputs : [])) {
      const cfg = T.configDe(o)
      if (!cfg || !T.esPorSecciones(cfg) || String(cfg.slice_scope?.from_node) !== String(node_key) || !(cfg.groups || []).some(g => g.slice_dependent)) continue
      out.push({ node_id: n.id, node_key: n.node_key, title: n.title, outputs: n.outputs, output_key: o.key || o.name, cfg })
    }
  }
  return out
}

/**
 * Regenera los grupos `slice_dependent` del maestro de un nodo sobre su pieza aprobada y reextrae los `extract`
 * que salen de él. Es el cuerpo de la ruta `regenerate-slice` (reintento) y del disparo automático.
 * Lanza NO_SLICE_GROUPS / SLICE_SCOPE_MISSING (422, públicos) antes de gastar nada; lo demás sube de
 * executeOneOutput (GATE_FAILED, BATCH_FAILED… con su rastro).
 */
async function regenerarSlice(db, { project_id, project_node_id, node_id, nodeDna, member_id = null, explicitKey = null, executeOneOutput }) {
  const outs = Array.isArray(nodeDna?.outputs) ? nodeDna.outputs : []
  const maestro = outs.find(o => { const c = T.configDe(o); return c && T.esPorSecciones(c) && (c.groups || []).some(g => g.slice_dependent) && (!explicitKey || (o.key || o.name) === explicitKey) })
  if (!maestro) throw publico('NO_SLICE_GROUPS', 'This node has no section-batched output with slice-dependent groups')
  const key = maestro.key || maestro.name
  const cfg = T.configDe(maestro)
  const alcance = await T.alcanceDelSlice(db, { project_id, cfg })
  if (!alcance) throw publico('SLICE_SCOPE_MISSING', `This project has no approved Vertical Slice Specification yet: run node ${cfg.slice_scope?.from_node || '3.13'} and approve it, then regenerate.`)
  const ran = [await executeOneOutput({ project_id, node_id, targetOutputKey: key, member_id, project_node_id, regenerar: 'slice' })]
  const failed = []
  for (const o of X.outputsExtract(outs)) {
    if (X.configExtract(o).from !== key) continue
    const k = o.key || o.name
    try { ran.push(await executeOneOutput({ project_id, node_id, targetOutputKey: k, member_id, project_node_id })) }
    catch (err) { failed.push({ output_key: k, error_code: err?.code || 'ERROR', error: err?.message }); console.warn(`[regenerate-slice] ${k}: ${err?.message}`) }
  }
  return { ran: ran.map(r => r.output_key), sessions: ran, regenerated: ran[0].regenerated || [], slice_source: { node_key: alcance.node_key, output_key: alcance.output_key, chars: alcance.chars }, ...(failed.length ? { failed } : {}) }
}

/** Guardas y lanzamiento en segundo plano para UN consumidor. Devuelve lo que viaja en la respuesta. */
async function lanzar(db, { project_id, consumidor: c, member_id, deps }) {
  const { executeOneOutput, isBlueprintSealed } = deps
  const { data: pns } = await db().from('forge_project_nodes').select('id, blueprint_id')
    .eq('project_id', project_id).eq('node_id', c.node_id).eq('removed', false)
  const pn = (pns || [])[0]
  if (!pn) return { skipped: 'NOT_IN_PROJECT' }
  if (isBlueprintSealed && await isBlueprintSealed(project_id, pn.blueprint_id)) return { skipped: 'SEALED' }
  const { extractSection } = require('../utils/extract-section')
  const maestro = await X.masterDeFila(db, { project_id, node_id: c.node_id, nodeTitle: c.title, outputDefs: c.outputs, from: c.output_key, extractSection })
  if (!maestro) return { skipped: 'NO_MASTER' }
  const { data: proj } = await db().from('projects').select('org_id').eq('id', project_id).maybeSingle()
  if (proj?.org_id) {
    const { canRun } = require('./credits.service')
    const r = await canRun(proj.org_id, { projectId: project_id, memberId: member_id })
    if (!r?.ok) return { skipped: 'NO_CREDIT', reason: r?.reason || null }
  }
  const clave = `${project_id}:${c.node_id}:${c.output_key}`
  if (enCurso.has(clave)) return { skipped: 'IN_PROGRESS' }
  const corrida = regenerarSlice(db, { project_id, project_node_id: pn.id, node_id: c.node_id, nodeDna: { outputs: c.outputs }, member_id, executeOneOutput })
    .then(r => { console.log(`[slice-trigger] ${c.node_key}/${c.output_key}: regenerated §${(r.regenerated || []).join(', §')} · ${r.ran.length} outputs${r.failed ? ` · ${r.failed.length} failed` : ''}`); return r })
    .catch(err => { console.warn(`[slice-trigger] ${c.node_key}/${c.output_key} failed: ${err?.code || ''} ${err?.message}`); return { error: err } })
    .finally(() => { if (enCurso.get(clave) === corrida) enCurso.delete(clave) })
  enCurso.set(clave, corrida)
  return { started: true, project_node_id: pn.id }
}

/**
 * Tras aprobar salidas de un nodo: para cada consumidor del slice cuyo `slice_scope.outputs` incluya alguna de
 * las claves aprobadas (null = pieza de nodo entero), lanza la regeneración. Devuelve [] si no hay consumidor
 * o ninguna clave aprobada es del alcance. Nunca lanza: un fallo aquí no puede romper el Accept.
 */
async function trasAprobarSalida(db, { project_id, node_key, output_keys = null, member_id = null, deps = {} }) {
  const out = []
  try {
    const consumidores = await consumidoresDelSlice(db, node_key)
    for (const c of consumidores) {
      const esperadas = (c.cfg.slice_scope?.outputs || []).map(String)
      const claves = Array.isArray(output_keys) ? output_keys : [null]
      if (claves.length && !claves.some(k => k == null || esperadas.includes(String(k)))) continue
      const r = await lanzar(db, { project_id, consumidor: c, member_id, deps })
      out.push({ node_key: c.node_key, output_key: c.output_key, ...r })
    }
  } catch (err) { console.warn(`[slice-trigger] not evaluated after ${node_key}: ${err?.message}`) }
  return out
}

/** Para pruebas y cierres ordenados: espera las regeneraciones en curso. */
async function esperarEnCurso() { const r = await Promise.all([...enCurso.values()]); return r }

module.exports = { consumidoresDelSlice, regenerarSlice, trasAprobarSalida, esperarEnCurso, enCurso }
