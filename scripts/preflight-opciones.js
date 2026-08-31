// Comprueba el camino de las opciones de generación (informe v3, punto 12) sin despachar nada.
//
// Recorre cada workflow vivo, pide su catálogo como lo pide el front, elige un valor distinto del
// actual en cada opción, lo aplica sobre una copia del grafo y verifica que el grafo quedó como se
// pidió. Es la prueba que NO se puede hacer corriendo: cada despacho es pago y no reproducible.
//
// Uso:  node scripts/preflight-opciones.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { opcionesDe, aplicarOpciones } = require('../src/services/workflow-options.service')

const clon = o => JSON.parse(JSON.stringify(typeof o === 'string' ? JSON.parse(o) : o))

;(async () => {
  const { data: wfs } = await db().from('comfyui_workflows').select('name, workflow_json').order('name')
  let ok = 0, fallos = 0, sinOpciones = 0

  for (const w of wfs) {
    let catalogo
    try { catalogo = await opcionesDe(w.workflow_json) }
    catch (e) { console.log(`✗ ${w.name}: no pude leer el catálogo — ${e.message}`); fallos++; continue }

    if (!catalogo.length) { sinOpciones++; continue }
    console.log(`\n── ${w.name}`)

    for (const o of catalogo) {
      // Un valor distinto del actual. Sin alternativa, la opción no es elegible y se dice.
      const otro = o.valores ? o.valores.find(v => v !== o.valor)
                 : o.tipo === 'BOOLEAN' ? !o.valor
                 : Number(o.valor) + 1
      if (otro === undefined) { console.log(`   ${o.clave}: sin alternativa`); continue }

      const grafo = clon(w.workflow_json)
      const { escrituras, avisos } = aplicarOpciones(grafo, { [o.clave]: otro }, catalogo)
      if (avisos.length) { console.log(`   ✗ ${o.clave}: ${avisos.join(' · ')}`); fallos++; continue }

      // ¿Quedó escrito en TODOS sus nodos? El Art Style Guide tiene 34 y escribir en uno solo
      // dejaría 33 páginas con el valor viejo sin que nada avisara.
      const puestos = o.nodos.filter(id => JSON.stringify(grafo[id]?.inputs?.[o.clave]) === JSON.stringify(otro))
      const bien = puestos.length === o.nodos.length
      if (!bien) { console.log(`   ✗ ${o.clave}: escrito en ${puestos.length}/${o.nodos.length} nodos`); fallos++; continue }

      // Si es un combo dinámico, sus hijos tienen que seguir a la rama elegida.
      let notaRamas = ''
      if (o.ramas) {
        const permitidos = new Set(o.ramas[otro] || [])
        const sobrantes = []
        for (const id of o.nodos) {
          for (const campo of Object.keys(grafo[id]?.inputs || {})) {
            if (!campo.startsWith(o.clave + '.')) continue
            // Por el primer tramo, igual que el motor: `model.images.image_1` cuelga de `images`.
            if (!permitidos.has(campo.slice(o.clave.length + 1).split('.')[0])) sobrantes.push(`${id}.${campo}`)
          }
        }
        if (sobrantes.length) { console.log(`   ✗ ${o.clave} → "${otro}": quedaron hijos de otra rama (${sobrantes.join(', ')})`); fallos++; continue }
        notaRamas = ` · rama "${otro}" deja {${[...permitidos].join(',')}}`
      }

      ok++
      console.log(`   ✓ ${o.clave.padEnd(26)} ${JSON.stringify(o.valor)} → ${JSON.stringify(otro)}  (${escrituras} escritura(s) en ${o.nodos.length} nodo(s))${notaRamas}`)
    }

    // Un valor que no existe tiene que rebotar ACÁ y no en ComfyUI, que lo descubriría al cobrar.
    const conLista = catalogo.find(o => o.valores?.length)
    if (conLista) {
      const grafo = clon(w.workflow_json)
      const r = aplicarOpciones(grafo, { [conLista.clave]: '__no_existe__' }, catalogo)
      if (r.escrituras === 0 && r.avisos.length) ok++
      else { console.log(`   ✗ ${conLista.clave}: aceptó un valor inválido`); fallos++ }
    }
  }

  console.log(`\n── ${ok} comprobaciones bien · ${fallos} mal · ${sinOpciones} workflow(s) sin opciones que exponer`)
  process.exit(fallos ? 1 : 0)
})()
