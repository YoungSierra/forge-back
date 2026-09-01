// Escribe el campo `pages` de los dos outputs de imagen del 3.20 que comparten workflow.
//
// El motor rechaza el despacho cuando un output declara N de las M páginas del workflow sin decir
// CUÁLES. En el 3.20 la partición existe y está escrita — pero en prosa, dentro del prompt:
//
//   asg_content_images    "PASS A — the 31 content slides: 01–25 and 28–33"
//   asg_synthesis_images  "PASS B — slides 26 One-Page Style Summary, 27 Asset Sheets
//                          and 34 Appendices. These summarise the other 31…"
//
// Esto no decide nada nuevo: transcribe lo que la DNA ya dice a un campo que el motor puede leer.
// No se tocan `gdd_art_style_images` (21 de 21) ni `art_bible_images` (26 de 26): ahí el conteo
// calza con el workflow entero y no hay ambigüedad que resolver.
//
// Uso:  node scripts/poner-pages-asg.js            (simula)
//       node scripts/poner-pages-asg.js --apply
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const APLICAR = process.argv.includes('--apply')
const WF = 'V57_STUDIO_ArtStyleGuide_Template'
const SINTESIS = [26, 27, 34]   // las que resumen a las demás; el resto es contenido

;(async () => {
  const { data: w } = await db().from('comfyui_workflows').select('inject_config').eq('name', WF).single()
  const ic = typeof w.inject_config === 'string' ? JSON.parse(w.inject_config) : w.inject_config
  const pags = (ic.pages || ic.paginas || []).map(p => (typeof p === 'string' ? p : (p.id || p.name || p.key)))
  if (pags.length !== 34) { console.error(`el workflow trae ${pags.length} páginas, se esperaban 34`); process.exit(1) }

  // El número va EN EL NOMBRE de la página (`26_OnePageSummary`), que es lo que hace verificable
  // la partición: se parte por el número escrito, no por la posición en el arreglo.
  const numDe = nombre => Number(String(nombre).slice(0, 2))
  const sintesis = pags.filter(p => SINTESIS.includes(numDe(p)))
  const contenido = pags.filter(p => !SINTESIS.includes(numDe(p)))

  console.log(`workflow ${WF}: ${pags.length} páginas`)
  console.log(`\nasg_synthesis_images → ${sintesis.length}`)
  sintesis.forEach(p => console.log(`   ${p}`))
  console.log(`\nasg_content_images → ${contenido.length}`)
  console.log(`   ${contenido.join('  ')}`)

  const { data: n } = await db().from('forge_nodes').select('id,outputs').eq('node_key', '3.20').single()
  const outs = n.outputs || []
  const problemas = []
  const asignar = { asg_content_images: contenido, asg_synthesis_images: sintesis }
  for (const [clave, lista] of Object.entries(asignar)) {
    const o = outs.find(x => (x.key || x.name) === clave)
    if (!o) { problemas.push(`${clave}: no existe en la DNA`); continue }
    if (o.image_count !== lista.length) problemas.push(`${clave}: image_count=${o.image_count} pero la partición da ${lista.length}`)
    if (o.pages) problemas.push(`${clave}: YA tiene pages (${o.pages.length}) — revisar antes de pisar`)
  }
  if (contenido.length + sintesis.length !== pags.length) problemas.push('la partición no cubre las 34')

  if (problemas.length) {
    console.error('\n*** NO SE APLICA ***')
    for (const p of problemas) console.error(`  · ${p}`)
    process.exit(1)
  }
  console.log('\ntodas las puertas pasan: los conteos calzan y la partición cubre las 34 sin solaparse.')

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const nuevos = outs.map(o => {
    const k = o.key || o.name
    return asignar[k] ? { ...o, pages: asignar[k] } : o
  })
  const { error } = await db().from('forge_nodes').update({ outputs: nuevos }).eq('id', n.id)
  if (error) { console.error('fallo al escribir:', error.message); process.exit(1) }

  const { data: rel } = await db().from('forge_nodes').select('outputs').eq('node_key', '3.20').single()
  console.log('\n=== verificación ===')
  for (const clave of Object.keys(asignar)) {
    const o = (rel.outputs || []).find(x => (x.key || x.name) === clave)
    console.log(`  ${clave}: pages=${o?.pages?.length ?? 'AUSENTE'} · image_count=${o?.image_count}`)
  }
  const otros = (rel.outputs || []).filter(o => !asignar[o.key || o.name])
  console.log(`  outputs no tocados: ${otros.length}`)
})()
