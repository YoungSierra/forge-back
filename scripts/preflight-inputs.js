// ─── Preflight de INPUTS: ¿qué ve realmente cada output? (SOLO LECTURA, $0) ───
//
// Dos cosas distintas dejan a un output ciego, y desde el canvas las dos se ven igual —el cable
// dibujado, el nodo en verde— así que hay que medirlas, no suponerlas:
//
//   1. DNA rota  — `uses.inputs` nombra algo que el nodo NO declara como input. El filtro de
//                  puertos (canvas-chat.service.js:98) descarta TODO cable tipado que no esté en
//                  esa lista, así que el nodo queda con el nombre del proyecto y nada más.
//                  Dos formas medidas: el TIPO en vez de la clave (`concept_seed` por
//                  `selected_seeds`) y un output PROPIO puesto como input (va en `siblings`).
//   2. Sin aprobar — un asset sin `approved`/`auto_approved` no existe para aguas abajo: ni como
//                  input (línea 203) ni como sibling (línea 530). Correr no basta; hay que aceptar.
//
// Uso:  node scripts/preflight-inputs.js                 → audita la DNA de todos los nodos
//       node scripts/preflight-inputs.js <project_id>    → + mide lo que entra en ese proyecto

require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const PROJECT = process.argv[2] || null
const ver = k => String(k).split('.').map(Number)
const cmp = (a, b) => (ver(a)[0] - ver(b)[0]) || ((ver(a)[1] ?? 0) - (ver(b)[1] ?? 0))

async function auditarDna() {
  const { data: nodes } = await db().from('forge_nodes').select('node_key, title, inputs, outputs, status')
  const activos = (nodes || []).filter(n => n.status === 'active').sort((a, b) => cmp(a.node_key, b.node_key))

  const filas = []
  let revisados = 0
  for (const n of activos) {
    const wired  = n.inputs?.wired || []
    const claves = new Set(wired.map(i => i.key))
    const propios = new Set((n.outputs || []).map(o => o.key || o.name))
    const porTipo = new Map()
    for (const i of wired) porTipo.set(i.type, [...(porTipo.get(i.type) || []), i.key])

    for (const o of (n.outputs || [])) {
      const ui = o.uses?.inputs
      if (!Array.isArray(ui) || !ui.length) continue
      revisados++
      for (const ref of ui) {
        if (claves.has(ref)) continue
        const arreglo = porTipo.has(ref)
          ? `es el TIPO, no la clave → usar "${porTipo.get(ref).join('" | "')}"`
          : propios.has(ref)
            ? `es un output PROPIO del nodo → va en uses.siblings_if_present, no en uses.inputs`
            : 'no existe ni como clave, ni como tipo, ni como output propio'
        filas.push({ nodo: n.node_key, output: o.key || o.name, ref, arreglo })
      }
    }
  }

  console.log('── DNA ──────────────────────────────────────────────────────────────')
  console.log('outputs con uses.inputs revisados:', revisados, '| referencias rotas:', filas.length)
  for (const f of filas) console.log(`  ${f.nodo.padEnd(5)} ${String(f.output).padEnd(22)} "${f.ref}" → ${f.arreglo}`)
  if (!filas.length) console.log('  sin hallazgos')
  return filas
}

async function medirProyecto(projectId) {
  const { buildSystemPrompt } = require('../src/services/canvas-chat.service')
  const { data: pnodes } = await db().from('forge_project_nodes')
    .select('id, node_id, lane_id, forge_nodes(node_key, title, outputs)')
    .eq('project_id', projectId).eq('removed', false)

  const conNodo = (pnodes || []).filter(p => p.forge_nodes?.node_key).sort((a, b) => cmp(a.forge_nodes.node_key, b.forge_nodes.node_key))

  console.log('\n── LO QUE ENTRA DE VERDAD ───────────────────────────────────────────')
  const ciegos = []
  for (const p of conNodo) {
    for (const o of (p.forge_nodes.outputs || [])) {
      const key = o.key || o.name
      let r
      // Un output que no resuelve no debe tumbar la auditoría: se anota y se sigue.
      try {
        r = await buildSystemPrompt(db, {
          projectId, nodeId: p.node_id, sessionId: null,
          userMessage: 'preflight', targetOutputKey: key, projectNodeId: p.id,
        })
      } catch (e) { console.log(`  ${p.forge_nodes.node_key} ${key}: ERROR ${e.message}`); continue }

      const chars = r.resolvedInputs.reduce((s, i) => s + i.length, 0)

      // Un output puede vivir legítimamente de sus HERMANOS (uses.inputs: [] + siblings): el 2.1
      // pitch_document se arma de elevator_line y pitch_images, no de upstream. Esos no entran por
      // resolvedInputs sino por el bloque "Existing outputs from this node", así que contar solo
      // los inputs los marcaba CIEGOS teniendo su fuente delante — el preflight mentía.
      const bloque = r.finalSystemPrompt.match(/## Existing outputs from this node\n([\s\S]*?)(?:\n\n## |$)/)
      const hermanos = bloque ? (bloque[1].match(/^### (.+)$/gm) || []) : []
      const linea = `  ${p.forge_nodes.node_key.padEnd(5)} ${String(key).padEnd(22)} ` +
        `${String(r.resolvedInputs.length).padStart(2)} in /${String(chars).padStart(7)} ch  ` +
        `${String(hermanos.length).padStart(2)} herm /${String(bloque ? bloque[1].length : 0).padStart(7)} ch`

      const fuentes = [
        ...r.resolvedInputs.map(i => i.split('\n')[0].replace('### ', '')),
        ...hermanos.map(h => h.replace('### ', '').replace(' (this node — existing output)', '') + ' [herm]'),
      ]
      if (!fuentes.length) { ciegos.push(`${p.forge_nodes.node_key}/${key}`); console.log(linea + '   ← CIEGO: solo el nombre del proyecto') }
      else console.log(linea + '   ' + fuentes.join(' + '))
    }
  }
  console.log('\noutputs CIEGOS:', ciegos.length, ciegos.length ? '→ ' + ciegos.join(', ') : '')
}

;(async () => {
  await auditarDna()
  if (PROJECT) await medirProyecto(PROJECT)
  else console.log('\n(pasá un project_id para medir además lo que entra en un proyecto vivo)')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
