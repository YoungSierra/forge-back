// Foto de los edges de un proyecto, para comparar antes/después de reproducir un bug.
// Uso:  node scripts/edges-snapshot.js <project_id> [--diff]
require('dotenv').config()
const fs = require('fs'), path = require('path')
const { db } = require('../src/services/supabase.service')
const P = process.argv[2]
const DIFF = process.argv.includes('--diff')
const FILE = path.join(require('os').tmpdir(), `edges_${P}.json`)
;(async () => {
  const { data: pn } = await db().from('forge_project_nodes')
    .select('id, node_type, text_label, removed, forge_nodes(node_key)').eq('project_id', P)
  const lbl = new Map(pn.map(p => [p.id, p.node_type === 'forge_node' ? (p.forge_nodes?.node_key || '?') : p.node_type]))
  const { data: e } = await db().from('forge_project_edges')
    .select('source_node_id, target_node_id, target_handle').eq('project_id', P)
  const claves = (e || []).map(x => `${lbl.get(x.source_node_id)||'?'} → ${lbl.get(x.target_node_id)||'?'} [${x.target_handle}]`).sort()

  if (!DIFF || !fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(claves, null, 1))
    return console.log('foto guardada:', claves.length, 'edges →', FILE)
  }
  const antes = JSON.parse(fs.readFileSync(FILE, 'utf-8'))
  const cont = a => a.reduce((m, k) => (m[k] = (m[k]||0)+1, m), {})
  const A = cont(antes), B = cont(claves)
  const todas = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()
  let cambios = 0
  for (const k of todas) {
    if ((A[k]||0) === (B[k]||0)) continue
    cambios++
    console.log(`  ${(A[k]||0) > (B[k]||0) ? '− SE FUE ' : '+ APARECE'}  ${k}   (${A[k]||0} → ${B[k]||0})`)
  }
  console.log(`\n${antes.length} → ${claves.length} edges | ${cambios || 'sin'} cambios`)
})()
