// Puebla `page_prefixes` en los dos outputs de imagen del 3.20.
//
// POR QUÉ EXISTE: al iterar una página del Art Style Guide el back necesita saber de qué output
// salió, para rehacerla con el workflow correcto. Lo resuelve por la clave de la sesión y, si esa
// clave ya no existe, por el nombre de la página contra `page_prefixes`. La v2.9.7 partió
// `art_style_guide_images` en `asg_content_images` + `asg_synthesis_images`, así que los 34 assets
// ya generados quedaron con una clave muerta — y el respaldo tampoco servía porque NINGÚN output
// tenía `page_prefixes` poblado. Resultado: ninguna página del ASG se podía iterar.
//
// DE DÓNDE SALE EL REPARTO: de la prosa del propio prompt de cada output, que hoy es el único
// lugar donde está escrito. `asg_content_images` dice "the 31 content slides: 01–25 and 28–33";
// `asg_synthesis_images` dice "slides 26 One-Page Style Summary, 27 Asset Sheets and 34
// Appendices". Los nombres exactos salen de `inject_config.pages` del workflow.
//
// Uso:  node scripts/set-asg-page-prefixes.js            (simula)
//       node scripts/set-asg-page-prefixes.js --apply    (escribe)
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const APLICAR  = process.argv.includes('--apply')
const NODE_KEY = '3.20'
const WORKFLOW = 'V57_STUDIO_ArtStyleGuide_Template'

// Números de página por output, tal como los declara su prompt.
const REPARTO = {
  asg_content_images:   [...Array.from({ length: 25 }, (_, i) => i + 1), 28, 29, 30, 31, 32, 33],
  asg_synthesis_images: [26, 27, 34],
}

;(async () => {
  const { data: wf, error: wfErr } = await db().from('comfyui_workflows')
    .select('inject_config').eq('name', WORKFLOW).single()
  if (wfErr) throw wfErr
  const paginas = (wf.inject_config?.pages || []).map(p => p.name)
  if (paginas.length !== 34) throw new Error(`El workflow tiene ${paginas.length} páginas, se esperaban 34`)

  // El nombre empieza por su número: "33_VideoMarketingSheet". Se busca por ahí, no por posición,
  // para que un reordenamiento del workflow no reparta mal en silencio.
  const porNumero = n => {
    const pref = String(n).padStart(2, '0') + '_'
    const hit = paginas.filter(p => p.startsWith(pref))
    if (hit.length !== 1) throw new Error(`La página ${n} resuelve a ${hit.length} nombres: ${hit.join(', ')}`)
    return hit[0]
  }

  const { data: node, error: nErr } = await db().from('forge_nodes')
    .select('id, outputs').eq('node_key', NODE_KEY).single()
  if (nErr) throw nErr

  // Superponer sobre la fila viva: se reescribe SOLO `page_prefixes` de esos dos outputs y todo
  // lo demás del arreglo queda intacto. Un full-replace de `outputs` es como se revierten cambios
  // de otro sin darse cuenta.
  const nuevos = node.outputs.map(o => {
    const clave = o.key || o.name
    if (!REPARTO[clave]) return o
    const page_prefixes = REPARTO[clave].map(porNumero)
    if (o.image_count && o.image_count !== page_prefixes.length) {
      throw new Error(`${clave}: image_count=${o.image_count} pero el reparto da ${page_prefixes.length} páginas`)
    }
    console.log(`${clave}: ${page_prefixes.length} páginas`)
    console.log(`   ${page_prefixes.join(', ')}`)
    return { ...o, page_prefixes }
  })

  // Ninguna página puede quedar en dos outputs, ni fuera de los dos.
  const todas = nuevos.flatMap(o => o.page_prefixes || [])
  const dup = todas.filter((p, i) => todas.indexOf(p) !== i)
  if (dup.length) throw new Error(`Páginas repartidas dos veces: ${dup.join(', ')}`)
  const faltan = paginas.filter(p => !todas.includes(p))
  if (faltan.length) throw new Error(`Páginas sin output: ${faltan.join(', ')}`)
  console.log(`\ncobertura: ${todas.length}/${paginas.length} páginas, sin duplicados`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')
  const { error } = await db().from('forge_nodes').update({ outputs: nuevos }).eq('id', node.id)
  if (error) throw error
  console.log('\nescrito en la DNA del ' + NODE_KEY)
})()
