// ¿Qué nodos se contradicen a sí mismos sobre el nivel de los encabezados?
//
// El SECTION CONTRACT reserva '## ' para la CLAVE del output. Un prompt de output que además
// manda escribir las secciones internas del documento con '## ' pide dos cosas incompatibles en
// el mismo system prompt: el modelo obedece una y la otra se pierde en silencio. Medido el 01-09
// en el 2.2 — el documento salió con sus diez '## ' de plantilla y ni concept_data ni
// concept_document aparecieron bajo su clave.
//
// Uso:  node scripts/preflight-choque-encabezados.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const TEXTO = o => !o.image_gen && o.production !== 'deferred'
// Instrucción de encabezado de nivel 2 dirigida a las secciones del documento.
const PIDE_H2 = /(^|[^#])##\s|'##\s?'|"##\s?"|`##\s?`|heading per section|## heading/i

;(async () => {
  const { data: nodos } = await db().from('forge_nodes')
    .select('node_key,title,status,default_prompt,outputs').order('node_key')

  let conContrato = 0
  const chocan = []
  for (const n of (nodos || []).filter(x => x.status === 'active')) {
    const outs = (n.outputs || [])
    const textos = outs.filter(TEXTO)
    const tieneContrato = /SECTION CONTRACT/.test(n.default_prompt || '')
    if (!tieneContrato || textos.length < 2) continue
    conContrato++

    const culpables = outs.filter(o => PIDE_H2.test(o.prompt || ''))
    if (culpables.length) {
      chocan.push({
        nk: n.node_key, t: n.title,
        outs: culpables.map(o => o.key || o.name),
        muestra: (culpables[0].prompt.match(/[^.]*##[^.]*\./) || [''])[0].trim().slice(0, 150),
      })
    }
  }

  console.log(`nodos activos con SECTION CONTRACT y 2+ outputs de texto: ${conContrato}`)
  console.log(`de esos, con un output que además pide '## ' para secciones internas: ${chocan.length}\n`)
  for (const c of chocan) {
    console.log(`  ${c.nk.padEnd(6)} ${c.t.slice(0, 34).padEnd(36)} → ${c.outs.join(', ')}`)
    if (c.muestra) console.log(`         «${c.muestra}»`)
  }
})()
