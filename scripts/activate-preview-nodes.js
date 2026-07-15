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
// ⚠ DESPUÉS DE APLICAR: correr `node scripts/regen-041-from-db.js --write`.
//    La 041 hace metadata=EXCLUDED.metadata en su ON CONFLICT y `preview` vive DENTRO de
//    metadata ⇒ re-correr la 041 sin re-snapshotear devuelve preview:true. (`status` no corre
//    ese riesgo: está deliberadamente excluido del UPDATE.)
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

  console.log('\n⚠ SIGUIENTE PASO OBLIGATORIO:')
  console.log('    node scripts/regen-041-from-db.js --write')
  console.log('    (si no, la próxima corrida de la 041 devuelve preview:true — pisa metadata)')
})().catch(e => { console.error(e); process.exit(1) })
