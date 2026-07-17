// ─── Saca los nodos de pre-producción de preview: archived → active, preview → false ───────
//
// Alcance ESTRICTO: solo filas que hoy son status='archived' Y metadata.preview=true, en
// phase='pre-production'. No toca nada más: ni otras fases, ni nodos ya activos, ni ninguna
// otra clave de metadata (preview se pisa con merge, el resto del objeto se preserva).
//
// Efecto (forge-canvas.routes.js:2289-2312, /nodes-catalog): el catálogo normal filtra
// status='active', así que los nodos pasan a verse siempre. Los preview salían solo con
// ?include_preview=1 vía Ctrl+Alt+P buscando archived + metadata->>preview='true'; con
// preview=false dejan de matchear esa 2ª query. Deja de hacer falta el atajo.
//
// Lo único que importa es el flip de `status`. La 041 lo respeta (está excluido de su ON
// CONFLICT DO UPDATE), así que el flip es permanente. El `preview` sí lo revierte la 041
// (metadata=EXCLUDED.metadata, con {"preview":true} hardcodeado), pero eso es INOFENSIVO:
// status='archived' es la condición PRIMARIA de la query de preview, así que con el nodo en
// 'active' el flag no puede hacer nada. Apagarlo es cosmético; re-snapshotear la 041 después
// (`regen-041-from-db.js --write`) es opcional, solo para que el archivo quede prolijo.
//
// Uso:  node scripts/activate-preview-nodes.js            → dry-run, no escribe
//       node scripts/activate-preview-nodes.js --write    → aplica
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const WRITE = process.argv.includes('--write')
const PHASE = 'pre-production'
const ver = k => String(k).split('.').map(Number)
const cmp = (a, b) => (ver(a)[0] - ver(b)[0]) || ((ver(a)[1] ?? 0) - (ver(b)[1] ?? 0))

;(async () => {
  const { data: all, error } = await db()
    .from('forge_nodes').select('id, node_key, title, status, metadata').eq('phase', PHASE)
  if (error) throw error

  const targets = (all || [])
    .filter(n => n.status === 'archived' && String(n.metadata?.preview) === 'true')
    .sort((a, b) => cmp(a.node_key, b.node_key))

  const already = (all || []).filter(n => n.status === 'active')
  const otros   = (all || []).filter(n => n.status !== 'active' && !targets.includes(n))

  console.log(`Nodos en phase='${PHASE}': ${all.length}`)
  console.log(`  ya activos            : ${already.length}${already.length ? ' (' + already.map(n => n.node_key).join(',') + ')' : ''}`)
  console.log(`  archived + preview    : ${targets.length}  ← objetivo`)
  if (otros.length) console.log(`  otros (NO se tocan)   : ${otros.length} (${otros.map(n => n.node_key + ':' + n.status).join(', ')})`)

  if (!targets.length) { console.log('\nNada que hacer.'); return }

  console.log('\n' + '─'.repeat(72))
  for (const n of targets) {
    console.log(`  ${n.node_key.padEnd(6)} ${String(n.title).padEnd(34)} archived→active   preview:true→false`)
  }
  console.log('─'.repeat(72))

  if (!WRITE) {
    console.log(`\n(dry-run — no se escribió nada. Usá --write para aplicar los ${targets.length} cambios.)`)
    return
  }

  let ok = 0
  for (const n of targets) {
    const metadata = { ...(n.metadata || {}), preview: false }   // merge: preserva el resto
    const { error: uErr } = await db()
      .from('forge_nodes')
      .update({ status: 'active', metadata })
      .eq('id', n.id)
      .eq('status', 'archived')      // guard optimista: si alguien lo cambió mientras tanto, no pisa
    if (uErr) { console.error(`  ✗ ${n.node_key}: ${uErr.message}`); continue }
    ok++
  }
  console.log(`\n✓ ${ok}/${targets.length} nodos actualizados`)

  // Verificación post-escritura contra la BD (no confiar en el update)
  const { data: after } = await db()
    .from('forge_nodes').select('node_key, status, metadata').eq('phase', PHASE)
  const malStatus  = (after || []).filter(n => n.status !== 'active')
  const malPreview = (after || []).filter(n => String(n.metadata?.preview) === 'true')
  console.log(`  verificado: status!=active → ${malStatus.length}   preview=true → ${malPreview.length}`)
  if (malStatus.length) console.log('    ' + malStatus.map(n => n.node_key + ':' + n.status).join(', '))

  console.log('\nOpcional, solo prolijidad: node scripts/regen-041-from-db.js --write')
  console.log('  La 041 hace metadata=EXCLUDED.metadata con {"preview":true} hardcodeado, así que')
  console.log('  el día que se corra devuelve el flag. Es INOFENSIVO: la query de preview')
  console.log("  (forge-canvas.routes.js:2307) exige status='archived' como condición PRIMARIA, y")
  console.log("  status no se pisa en el UPDATE de la 041. Con status='active' el flag es metadata")
  console.log('  muerta: no oculta ni duplica nada. Lo único que importa acá es el flip de status.')
})().catch(e => { console.error(e); process.exit(1) })
