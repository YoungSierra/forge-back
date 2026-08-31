// Punto 9 del informe v3 de Miguel: una sola versión aprobada por página.
//
// La ruta de aprobar ya desmarca la anterior (arreglado el 31-08), pero lo aprobado antes quedó
// sumado: hay páginas con varias versiones marcadas y nada dice cuál es la buena. La regla la fijó
// él: **gana la última versión, la de mayor número**, y las demás quedan desaprobadas.
//
// Desaprobar es quitar `approved_at` y `approved_by` del metadata de la versión. NO se toca
// `is_current` —vigente y aprobada son cosas distintas: una iteración recién hecha está a la vista
// sin estar aprobada— ni el `approved_at` del asset, que es de otra cosa.
//
// OJO con una consecuencia: la de mayor número no siempre es la vigente. En
// `28_CharacterSheet` gana la v9 y la vigente es la v8, así que la aprobada y la que se ve en el
// canvas quedan separadas — un estado que el flujo normal no produce, porque aprobar también pone
// vigente. `--vigente` alinea las dos; sin la bandera solo se tocan las aprobaciones, que es lo
// único que el informe pide.
//
// Uso:  node scripts/backfill-aprobacion-unica.js               (simula)
//       node scripts/backfill-aprobacion-unica.js --apply
//       node scripts/backfill-aprobacion-unica.js --apply --vigente
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const APLICAR = process.argv.includes('--apply')
const VIGENTE = process.argv.includes('--vigente')

;(async () => {
  let vers = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_asset_versions')
      .select('id, asset_id, version_number, is_current, storage_url, metadata').range(from, from + 999)
    if (!data?.length) break
    vers = vers.concat(data); if (data.length < 1000) break; from += 1000
  }
  const aprobada = v => !!(v.metadata?.approved_at || v.metadata?.approved_by)

  const porAsset = new Map()
  for (const v of vers) {
    if (!porAsset.has(v.asset_id)) porAsset.set(v.asset_id, [])
    porAsset.get(v.asset_id).push(v)
  }

  const conflictivos = [...porAsset.entries()]
    .map(([id, vs]) => ({ id, vs: vs.sort((a, b) => b.version_number - a.version_number), aprob: vs.filter(aprobada) }))
    .filter(x => x.aprob.length > 1)

  console.log(`versiones: ${vers.length} · páginas: ${porAsset.size} · con más de una aprobada: ${conflictivos.length}\n`)
  if (!conflictivos.length) return console.log('nada que hacer.')

  let desaprobadas = 0
  for (const c of conflictivos) {
    const { data: a } = await db().from('forge_assets').select('name').eq('id', c.id).maybeSingle()
    // Gana la de mayor número ENTRE LAS APROBADAS: desaprobar todas y dejar ganando a una que
    // nadie aprobó sería inventar una decisión que el usuario no tomó.
    const gana = c.aprob.reduce((x, y) => (y.version_number > x.version_number ? y : x))
    console.log(`── ${a?.name || c.id}`)
    for (const v of c.vs) {
      const marca = !aprobada(v) ? '' : v.id === gana.id ? '  ✓ queda aprobada' : '  → se desaprueba'
      console.log(`   v${String(v.version_number).padStart(2)}${v.is_current ? ' ◀ vigente' : '          '}${marca}`)
    }
    if (VIGENTE && !gana.is_current) {
      console.log(`   → v${gana.version_number} pasa a ser también la vigente`)
      if (APLICAR) {
        await db().from('forge_asset_versions').update({ is_current: false }).eq('asset_id', c.id)
        await db().from('forge_asset_versions').update({ is_current: true }).eq('id', gana.id)
        if (gana.storage_url) await db().from('forge_assets').update({ storage_url: gana.storage_url }).eq('id', c.id)
      }
    }
    for (const v of c.aprob) {
      if (v.id === gana.id) continue
      desaprobadas++
      if (!APLICAR) continue
      const limpio = { ...v.metadata }
      delete limpio.approved_at
      delete limpio.approved_by
      const { error } = await db().from('forge_asset_versions').update({ metadata: limpio }).eq('id', v.id)
      if (error) console.log(`   ✗ v${v.version_number}: ${error.message}`)
    }
    console.log()
  }

  console.log(`versiones a desaprobar: ${desaprobadas}`)
  if (!APLICAR) return console.log('(simulación — usar --apply para escribir)')

  // Releer: el punto de esto es que quede UNA, y afirmarlo sin comprobarlo es lo mismo que no
  // haberlo corrido.
  const ids = conflictivos.map(c => c.id)
  const { data: rel } = await db().from('forge_asset_versions')
    .select('asset_id, metadata').in('asset_id', ids)
  const cuenta = {}
  for (const v of (rel || [])) if (v.metadata?.approved_at || v.metadata?.approved_by) cuenta[v.asset_id] = (cuenta[v.asset_id] || 0) + 1
  const malas = Object.entries(cuenta).filter(([, n]) => n > 1)
  console.log(`\nverificación: ${ids.length} páginas revisadas · con más de una aprobada: ${malas.length}`)
})()
