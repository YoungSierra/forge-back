// ─── Repara las referencias rotas de uses.inputs (BD viva) ───────────────────
//
// Dos defectos medidos con scripts/preflight-inputs.js:
//   2.1/2.2 → "concept_seed" es el TIPO de selected_seeds, no su clave. El filtro de puertos
//             (canvas-chat.service.js:98) descarta todo cable tipado que no esté en uses.inputs,
//             así que el nodo corría con el nombre del proyecto y nada más.
//   3.4     → "world_lore" es un output PROPIO del nodo: va en siblings_if_present. Puesto en
//             uses.inputs no solo no lo trae, además descarta los cables reales. La forma correcta
//             ya está en el mismo nodo, en environments_x4 — de ahí se copia.
//
// Se SUPERPONE sobre la fila viva: se lee outputs, se toca solo la clave que corresponde y se
// escribe de vuelta. Nunca full-replace — un delta que pisa la fila entera es lo que revirtió el
// 3.9 en su momento.
//
// Uso:  node scripts/fix-uses-inputs.js            (simulación)
//       node scripts/fix-uses-inputs.js --apply

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APPLY = process.argv.includes('--apply')

// output → { inputs?: nuevo uses.inputs, addSiblings?: claves a sumar a siblings_if_present }
const PLAN = {
  '2.1': { elevator_line:   { inputs: ['selected_seeds'] } },
  '2.2': { concept_data:    { inputs: ['selected_seeds'] },
           concept_document:{ inputs: ['selected_seeds', 'elevator_line', 'positioning_statement', 'market_gap_analysis'] } },
  '3.4': { faction_map:     { inputs: ['design_pillars'], addSiblings: ['world_lore'] },
           narrative_arc:   { inputs: ['design_pillars'], addSiblings: ['world_lore'] },
           dialogue_system: { inputs: ['design_pillars'], addSiblings: ['world_lore'] } },
}

;(async () => {
  const keys = Object.keys(PLAN)
  const { data: nodes, error } = await db().from('forge_nodes')
    .select('id, node_key, title, outputs')
    .in('node_key', keys).eq('status', 'active')
  if (error) { console.error('ERR lectura:', error.message); process.exit(1) }

  if (APPLY) {
    const dir = path.join(__dirname, '..', '..', '_Prod', 'backups')
    const file = path.join(dir, `forge_nodes_uses_fix_${new Date().toISOString().slice(0, 10)}.json`)
    fs.writeFileSync(file, JSON.stringify(nodes, null, 2), 'utf-8')
    console.log('backup →', file, '\n')
  }

  for (const n of nodes) {
    const plan = PLAN[n.node_key]
    const outs = JSON.parse(JSON.stringify(n.outputs))
    let tocados = 0

    for (const o of outs) {
      const p = plan[o.key || o.name]
      if (!p) continue
      o.uses = o.uses || {}
      if (p.inputs) {
        console.log(`  ${n.node_key} ${String(o.key).padEnd(18)} inputs: ${JSON.stringify(o.uses.inputs ?? null)} → ${JSON.stringify(p.inputs)}`)
        o.uses.inputs = p.inputs
      }
      if (p.addSiblings) {
        // La clave histórica es siblings_if_present; los outputs de v2.9.0 traen `siblings`. Se
        // respeta la que ya tenga la fila para no dejar el nodo con las dos.
        const clave = ('siblings' in o.uses && !('siblings_if_present' in o.uses)) ? 'siblings' : 'siblings_if_present'
        const antes = o.uses[clave] ?? []
        o.uses[clave] = [...new Set([...antes, ...p.addSiblings])]
        console.log(`  ${n.node_key} ${String(o.key).padEnd(18)} ${clave}: ${JSON.stringify(antes)} → ${JSON.stringify(o.uses[clave])}`)
      }
      tocados++
    }

    const esperados = Object.keys(plan).length
    if (tocados !== esperados) {
      console.error(`ABORTA: en ${n.node_key} se encontraron ${tocados} de ${esperados} outputs del plan`)
      process.exit(1)
    }

    if (APPLY) {
      const up = await db().from('forge_nodes').update({ outputs: outs }).eq('id', n.id)
      if (up.error) { console.error('ERR update', n.node_key, up.error.message); process.exit(1) }
      console.log(`  ✔ ${n.node_key} escrito\n`)
    } else console.log('')
  }

  console.log(APPLY ? '✔ aplicado' : '→ simulación; correr con --apply')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
