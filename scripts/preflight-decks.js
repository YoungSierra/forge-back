// El nombre de un workflow de deck vive en TRES sitios y los tres tienen que decir lo mismo:
//
//   1 · la DNA        — `image_gen_model` del output
//   2 · el registro   — la fila de `comfyui_workflows` y sus páginas
//   3 · el código     — la tabla `DECKS` de slide-composer, que es por donde el motor lo busca
//
// El motor resuelve el deck POR NOMBRE DE WORKFLOW contra la tabla del código. Si la DNA se
// renombra y la tabla no, `deck` queda en `undefined`, `composeDeck` revienta y el usuario ve un
// «Internal server error» que no dice nada. Pasó el 07-09 con la restructura del ASG: el ASG y el
// Art Bible dejaron de poder correr e iterar en el momento en que se aplicó v2.9.32.
//
// Esto compara los tres y falla si alguno se desvía. Correrlo después de cada delta que toque
// `image_gen_model` y después de registrar un workflow nuevo.
//
// Uso:  node scripts/preflight-decks.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { DECKS } = require('../src/services/slide-composer.service')
const { techoDeclarado, textoDeCuenta } = require('../src/services/image-count')

// Contar páginas NO es comprobar que el deck funciona. El 29-09 se registraron dos maestros nuevos
// con la lista de páginas puesta y el cableado vacío —solo `{name, save}`— y este preflight los dio
// en verde: cada página necesita además decir EN QUÉ NODO va su prompt y DE QUÉ NODO sale su
// imagen, y esos nodos tienen que existir en el grafo. Sin eso el motor compone los prompts y
// luego no tiene dónde escribirlos: salta la página en silencio y se paga la plantilla en blanco.
function revisarCableado(nombre, cfg, wf) {
  const malas = []
  if (cfg?.mode !== 'per_page') return [`«${nombre}» no declara mode: per_page — el motor no lo trata como deck`]
  for (const p of cfg.pages || []) {
    const falta = []
    // `sin_prompt` es una página que no lleva prompt por diseño —el Audio Base lo escribe un nodo
    // de Claude dentro del grafo—. Tiene que estar DECLARADO: la ausencia del campo a secas no
    // distingue «no lleva prompt» de «se olvidó cablearlo», que es el fallo que esto busca.
    if (p.sin_prompt) { /* declarado: no se le exige prompt_node */ }
    else if (!p.prompt_node) falta.push('prompt_node')
    else if (!wf?.[p.prompt_node]?.inputs) falta.push(`prompt_node #${p.prompt_node} no está en el grafo`)
    if (!p.save_node) falta.push('save_node')
    else if (!wf?.[p.save_node]) falta.push(`save_node #${p.save_node} no está en el grafo`)
    // `image_input` es opcional —solo lo llevan las páginas con ranura de referencia—, pero si se
    // declara tiene que existir, o la referencia del proyecto se escribiría en la nada.
    if (p.image_input && !wf?.[p.image_input]) falta.push(`image_input #${p.image_input} no está en el grafo`)
    if (falta.length) malas.push(`${p.name || '(sin nombre)'}: ${falta.join(', ')}`)
  }
  // Dos páginas escribiendo en el mismo nodo: la segunda pisa a la primera y sale duplicada.
  const rep = [...new Set((cfg.pages || []).map(p => p.prompt_node)
    .filter((v, i, a) => v && a.indexOf(v) !== i))]
  if (rep.length) malas.push(`prompt_node repetidos: ${rep.join(', ')}`)
  return malas.map(m => `«${nombre}» — ${m}`)
}

;(async () => {
  const problemas = []

  console.log('DECKS (código) → registro:\n')
  for (const [k, c] of Object.entries(DECKS)) {
    const { data: w } = await db().from('comfyui_workflows').select('inject_config,is_active,workflow_json').eq('name', c.workflow).maybeSingle()
    if (!w) { problemas.push(`DECKS.${k} apunta a «${c.workflow}», que no está registrado`); console.log(`  ✗ ${k.padEnd(9)} ${c.workflow} — NO registrado`); continue }
    const cfg = typeof w.inject_config === 'string' ? JSON.parse(w.inject_config) : w.inject_config
    const paginas = cfg?.pages?.length ?? 0
    const malCableado = revisarCableado(c.workflow, cfg, w.workflow_json)
    problemas.push(...malCableado)
    const ok = paginas === c.paginas && !malCableado.length
    if (paginas !== c.paginas) problemas.push(`DECKS.${k} declara ${c.paginas} páginas y «${c.workflow}» tiene ${paginas}`)
    console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(9)} ${c.workflow.padEnd(40)} código ${String(c.paginas).padStart(2)} · registro ${String(paginas).padStart(2)}`
      + `${malCableado.length ? `  ✗ ${malCableado.length} sin cablear` : ''}`
      + (w.is_active ? '' : '  ⚠ inactivo'))
    if (c.fuente) {
      const { data: n } = await db().from('forge_nodes').select('node_key').eq('node_key', c.fuente).maybeSingle()
      if (!n) problemas.push(`DECKS.${k}: el nodo fuente ${c.fuente} no existe`)
    }

    // Y el SUCESOR, cuando el deck tiene dos maestros conviviendo. Sin esto quedaba fuera del
    // preflight justo el que usan los proyectos nuevos: podía desincronizarse en silencio y no
    // saltar hasta que alguien creara un proyecto y corriera el deck.
    if (c.sucesor) {
      const { data: ws } = await db().from('comfyui_workflows')
        .select('inject_config,is_active,created_at,workflow_json').eq('name', c.sucesor.workflow).maybeSingle()
      if (!ws) {
        problemas.push(`DECKS.${k}.sucesor apunta a «${c.sucesor.workflow}», que no está registrado`)
        console.log(`  ✗ ${''.padEnd(9)} ${c.sucesor.workflow} — NO registrado (sucesor)`)
      } else {
        const cs = typeof ws.inject_config === 'string' ? JSON.parse(ws.inject_config) : ws.inject_config
        const ps = cs?.pages?.length ?? 0
        const malS = revisarCableado(c.sucesor.workflow, cs, ws.workflow_json)
        problemas.push(...malS)
        const oks = ps === c.sucesor.paginas && !malS.length
        if (ps !== c.sucesor.paginas) problemas.push(`DECKS.${k}.sucesor declara ${c.sucesor.paginas} páginas y «${c.sucesor.workflow}» tiene ${ps}`)
        console.log(`  ${oks ? '✓' : '✗'} ${''.padEnd(9)} ${c.sucesor.workflow.padEnd(40)} código ${String(c.sucesor.paginas).padStart(2)} · registro ${String(ps).padStart(2)}`
          + `${malS.length ? `  ✗ ${malS.length} sin cablear` : ''}`
          + `  ← sucesor, desde ${String(ws.created_at).slice(0, 10)}` + (ws.is_active ? '' : '  ⚠ inactivo'))
      }
    }
  }

  console.log('\nDNA → DECKS:\n')
  const { data: nodos } = await db().from('forge_nodes').select('node_key,outputs').eq('status', 'active')
  for (const n of nodos) {
    for (const o of (n.outputs || []).filter(x => x.image_gen && x.image_gen_model)) {
      const wfName = String(o.image_gen_model).replace(/^comfyui:/, '')
      const { data: w } = await db().from('comfyui_workflows').select('inject_config').eq('name', wfName).maybeSingle()
      const cfg = w ? (typeof w.inject_config === 'string' ? JSON.parse(w.inject_config) : w.inject_config) : null
      const esPorPagina = cfg?.mode === 'per_page'
      if (!esPorPagina) continue        // no es un deck: se despacha ítem por ítem

      const deck = Object.entries(DECKS).find(([, c]) => c.workflow === wfName)?.[0]
      const paginas = cfg.pages.length
      const declara = techoDeclarado(o)
      const clave = `${n.node_key} ${o.key || o.name}`
      if (!deck) {
        problemas.push(`${clave}: «${wfName}» no está en DECKS — el motor recibiría deck=undefined y no puede correr ni iterar`)
        console.log(`  ✗ ${clave.padEnd(32)} → ${wfName}  NO está en DECKS`)
        continue
      }
      const ok = declara === paginas
      if (!ok) problemas.push(`${clave}: la DNA declara ${textoDeCuenta(o)} y «${wfName}» tiene ${paginas} páginas`)
      console.log(`  ${ok ? '✓' : '✗'} ${clave.padEnd(32)} → ${deck} · DNA ${String(declara).padStart(2)} · registro ${String(paginas).padStart(2)}`)
    }
  }

  if (problemas.length) {
    console.error(`\n*** ${problemas.length} desacuerdo(s) ***`)
    for (const p of problemas) console.error(`  · ${p}`)
    process.exit(1)
  }
  console.log('\nla DNA, el registro y el código dicen lo mismo ✓')
})()
