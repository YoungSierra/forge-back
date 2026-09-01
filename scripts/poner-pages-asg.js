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
//
// `pages` son ÍNDICES 1-based, NO nombres: `composeDeck` filtra con `solo.includes(i + 1)`. Con
// nombres no coincide ninguna página, el deck queda en cero, el grafo podado se queda sin un solo
// SaveImage y ComfyUI responde «Prompt has no outputs». Lo escribí con nombres a las 20:05 del
// 01-09 y ese fue exactamente el error que salió.
//
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

  // El número se lee DEL NOMBRE de la página (`26_OnePageSummary`), no de su posición: así la
  // partición queda verificable contra lo que dice el prompt, y un reordenamiento del arreglo no
  // la cambia en silencio.
  const numDe = n => Number(String(n).slice(0, 2))
  const numeros = pags.map(numDe)
  if (numeros.some(n => !Number.isInteger(n) || n < 1)) { console.error('hay páginas cuyo nombre no empieza por su número'); process.exit(1) }
  const nombreDe = i => pags[numeros.indexOf(i)] || `?${i}`

  const sintesis  = numeros.filter(n => SINTESIS.includes(n))
  const contenido = numeros.filter(n => !SINTESIS.includes(n))

  console.log(`workflow ${WF}: ${pags.length} páginas\n`)
  console.log(`asg_synthesis_images → ${sintesis.length}   pages=[${sintesis.join(', ')}]`)
  sintesis.forEach(i => console.log(`   ${String(i).padStart(2)}  ${nombreDe(i)}`))
  console.log(`\nasg_content_images → ${contenido.length}   pages=[${contenido.join(', ')}]`)
  console.log(`   ${contenido.map(nombreDe).join('  ')}`)

  const { data: n } = await db().from('forge_nodes').select('id,outputs').eq('node_key', '3.20').single()
  const outs = n.outputs || []
  const asignar = { asg_content_images: contenido, asg_synthesis_images: sintesis }
  const problemas = []

  for (const [clave, lista] of Object.entries(asignar)) {
    const o = outs.find(x => (x.key || x.name) === clave)
    if (!o) { problemas.push(`${clave}: no existe en la DNA`); continue }
    if (o.image_count !== lista.length) problemas.push(`${clave}: image_count=${o.image_count} pero la partición da ${lista.length}`)
    if (Array.isArray(o.pages) && o.pages.length) {
      const yaNumerico = o.pages.every(x => typeof x === 'number')
      if (yaNumerico && o.pages.length === lista.length && o.pages.every((x, i) => x === lista[i])) {
        problemas.push(`${clave}: ya tiene exactamente este pages — nada que hacer`)
      } else {
        // Un `pages` de strings es justamente el error que este script viene a corregir: se pisa.
        console.log(`\n  (${clave}: se reemplaza un pages ${yaNumerico ? 'numérico distinto' : 'de NOMBRES, que no filtra nada'})`)
      }
    }
  }
  const cubre = [...contenido, ...sintesis].sort((a, b) => a - b)
  if (cubre.length !== 34 || new Set(cubre).size !== 34) problemas.push('la partición no cubre las 34 sin solaparse')

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
    const tipos = [...new Set((o?.pages || []).map(x => typeof x))].join('/')
    console.log(`  ${clave}: pages=${o?.pages?.length ?? 'AUSENTE'} (${tipos}) · image_count=${o?.image_count}`)
    // La prueba que importa: el mismo filtro que usa composeDeck.
    const pasan = numeros.filter((_, i) => (o?.pages || []).includes(i + 1)).length
    console.log(`     páginas que compondría composeDeck: ${pasan}`)
  }
  console.log(`  outputs no tocados: ${(rel.outputs || []).filter(o => !asignar[o.key || o.name]).length}`)
})()
