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

;(async () => {
  const problemas = []

  console.log('DECKS (código) → registro:\n')
  for (const [k, c] of Object.entries(DECKS)) {
    const { data: w } = await db().from('comfyui_workflows').select('inject_config,is_active').eq('name', c.workflow).maybeSingle()
    if (!w) { problemas.push(`DECKS.${k} apunta a «${c.workflow}», que no está registrado`); console.log(`  ✗ ${k.padEnd(9)} ${c.workflow} — NO registrado`); continue }
    const cfg = typeof w.inject_config === 'string' ? JSON.parse(w.inject_config) : w.inject_config
    const paginas = cfg?.pages?.length ?? 0
    const ok = paginas === c.paginas
    if (!ok) problemas.push(`DECKS.${k} declara ${c.paginas} páginas y «${c.workflow}» tiene ${paginas}`)
    console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(9)} ${c.workflow.padEnd(40)} código ${String(c.paginas).padStart(2)} · registro ${String(paginas).padStart(2)}`
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
        .select('inject_config,is_active,created_at').eq('name', c.sucesor.workflow).maybeSingle()
      if (!ws) {
        problemas.push(`DECKS.${k}.sucesor apunta a «${c.sucesor.workflow}», que no está registrado`)
        console.log(`  ✗ ${''.padEnd(9)} ${c.sucesor.workflow} — NO registrado (sucesor)`)
      } else {
        const cs = typeof ws.inject_config === 'string' ? JSON.parse(ws.inject_config) : ws.inject_config
        const ps = cs?.pages?.length ?? 0
        const oks = ps === c.sucesor.paginas
        if (!oks) problemas.push(`DECKS.${k}.sucesor declara ${c.sucesor.paginas} páginas y «${c.sucesor.workflow}» tiene ${ps}`)
        console.log(`  ${oks ? '✓' : '✗'} ${''.padEnd(9)} ${c.sucesor.workflow.padEnd(40)} código ${String(c.sucesor.paginas).padStart(2)} · registro ${String(ps).padStart(2)}`
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
