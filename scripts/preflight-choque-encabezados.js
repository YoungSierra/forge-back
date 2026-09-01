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
// EXACTAMENTE dos almohadillas. Buscar la frase «heading per section» suelta era peor que inútil:
// v2.9.24 la conserva diciendo '###', que es justo lo que queríamos, y el preflight la denunciaba.
// La marca literal basta — el prompt viejo del 2.2 decía «One "## " heading per section» y cae
// igual por el `"## "`.
const PIDE_H2 = /(^|[^#])##(?!#)[ \t]|['"`]##(?!#)[ \t]?['"`]/

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

    // Un '## ' que nombra la CLAVE DEL PROPIO OUTPUT no es una colisión: es el contrato dicho en
    // voz alta, y es lo que hace v2.9.24 en el 2.2. Se quitan esas menciones antes de mirar, o el
    // preflight denuncia justo el arreglo que acabamos de aplicar. Igual con 1.4 y 3.9.
    const sinPropia = o => {
      const k = (o.key || o.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[_\\s]')
      let p = String(o.prompt || '')
      if (k) p = p.replace(new RegExp(`#{1,4}\\s*${k}`, 'gi'), '')
      // Y enunciar la regla no es infringirla: «'##' is reserved for output keys» o «Never promote
      // a section to '##'» hablan DE la marca para prohibirla, no mandan usarla. Sin descontarlas
      // el preflight denuncia el texto que dice que no hay que hacer lo que denuncia — y eso es
      // peor que no tener preflight: la próxima persona lee «1 colisión» sobre el arreglo.
      // Se descarta la ORACIÓN entera cuando lleva la marca junto a una palabra de prohibición.
      const PROHIBE = /\b(never|reserved|not|no longer|only|nunca|reservad|solo)\b/i
      return p.split(/(?<=\.)\s+/).filter(f => !(/#{2,4}/.test(f) && PROHIBE.test(f))).join(' ')
    }
    const culpables = outs.filter(o => PIDE_H2.test(sinPropia(o)))
    if (culpables.length) {
      chocan.push({
        nk: n.node_key, t: n.title,
        outs: culpables.map(o => o.key || o.name),
        muestra: (sinPropia(culpables[0]).match(/[^.]*##[^.]*\./) || [''])[0].trim().slice(0, 150),
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
