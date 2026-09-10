// Mide los `.glb` ya almacenados y les deja la caja en la metadata.
//
// Los modelos nuevos se miden solos al publicarse (chain.service). Este script es para los que ya
// estaban: lee los primeros 64 KB de cada archivo, no descarga nada más.
//
// Uso:  node scripts/medir-modelos.js [--apply] [--forzar]
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { medirGlb, medirActivo } = require('../src/services/glb-medidas.service')

const APLICAR = process.argv.includes('--apply')
const FORZAR  = process.argv.includes('--forzar')

;(async () => {
  const { data: ass } = await db().from('forge_assets')
    .select('id, name, format, storage_url, metadata, project_id')
    .eq('format', 'glb').not('storage_url', 'is', null)
    .order('created_at', { ascending: false })

  console.log(`modelos .glb almacenados: ${ass.length}\n`)
  let medidos = 0, yaTenian = 0, fallaron = 0, inexactos = 0

  for (const a of ass) {
    if (a.metadata?.medidas && !FORZAR) {
      yaTenian++
      console.log(`· ${a.name.slice(0, 46).padEnd(48)} ya medido`)
      continue
    }
    try {
      const m = APLICAR ? await medirActivo(db, a, { forzar: FORZAR }) : await medirGlb(a.storage_url)
      medidos++
      if (!m.exacta) inexactos++
      console.log(`${m.exacta ? '✓' : '⚠'} ${a.name.slice(0, 46).padEnd(48)}`
        + ` ${m.dim.x} × ${m.dim.y} × ${m.dim.z}  alto=${m.alto}  base_y=${m.base_y}`
        + (m.exacta ? '' : `  ← ${m.nodos_transformados} nodo(s) con transformación: la caja es aproximada`))
    } catch (e) {
      fallaron++
      console.log(`✗ ${a.name.slice(0, 46).padEnd(48)} ${e.message}`)
    }
  }

  console.log(`\nmedidos ${medidos} · ya tenían ${yaTenian} · fallaron ${fallaron}`
    + (inexactos ? ` · ${inexactos} aproximados` : ''))
  if (!APLICAR) console.log('\n(simulación — usar --apply para guardar en la metadata)')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
