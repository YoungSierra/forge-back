// Comprueba que cada `image_gen_model` de la DNA apunte a un workflow que EXISTE registrado, y
// que cada output de deck declare las páginas que le tocan.
//
// POR QUÉ: el generador de decks resuelve el workflow por un mapa fijo en slide-composer, así que
// un nombre equivocado en la DNA no rompe la generación — solo los caminos que SÍ leen la DNA,
// como iterar una página. Eso hace que el error aparezca semanas después y lejos de su causa.
//
// Uso:  node scripts/preflight-workflows.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

;(async () => {
  const { data: wfs } = await db().from('comfyui_workflows').select('name, inject_config')
  const registrados = new Map(wfs.map(w => [w.name, w]))

  const { data: nodes } = await db().from('forge_nodes').select('node_key, title, outputs, status')

  const rotos = [], sinPaginas = [], ok = []
  for (const n of nodes) {
    for (const o of (Array.isArray(n.outputs) ? n.outputs : [])) {
      const modelo = o.image_gen_model
      if (!modelo || !String(modelo).startsWith('comfyui:')) continue
      const nombre = String(modelo).slice('comfyui:'.length)
      const wf = registrados.get(nombre)
      const donde = `${n.node_key}/${o.key || o.name}`

      if (!wf) { rotos.push({ donde, nombre, estado: n.status }); continue }

      // Un workflow `per_page` es un deck: sus outputs tienen que decir qué páginas cubren, o
      // nadie puede resolver una página suelta cuando la clave de su sesión envejece.
      if (wf.inject_config?.mode === 'per_page') {
        const pp = o.page_prefixes || []
        if (!pp.length) sinPaginas.push({ donde, nombre, cuantas: o.image_count ?? '?' })
        else ok.push({ donde, paginas: pp.length })
      } else ok.push({ donde, paginas: '—' })
    }
  }

  console.log('=== image_gen_model que NO existe registrado ===')
  rotos.length
    ? rotos.forEach(r => console.log(`  ${r.donde.padEnd(34)} -> "${r.nombre}"  (nodo ${r.estado})`))
    : console.log('  ninguno')

  console.log('\n=== outputs de deck SIN page_prefixes ===')
  sinPaginas.length
    ? sinPaginas.forEach(r => console.log(`  ${r.donde.padEnd(34)} ${r.cuantas} imágenes · ${r.nombre}`))
    : console.log('  ninguno')

  console.log(`\n=== correctos: ${ok.length} ===`)
  ok.forEach(r => console.log(`  ${r.donde.padEnd(34)} páginas: ${r.paginas}`))

  const fallas = rotos.length + sinPaginas.length
  console.log(`\n${fallas ? fallas + ' problema(s)' : 'todo consistente'}`)
  process.exit(fallas ? 1 : 0)
})()
