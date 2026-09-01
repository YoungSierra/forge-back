// Aplica v2.9.26 (EmitOnce): 9 filas de ADN — 1.1, 2.1, 2.2, 2.4, 2.5, 3.1, 3.3, 3.4, 3.7.
//
// Quita la contradicción entre dos contratos nuestros: el SECTION CONTRACT pone cada output bajo
// su '##' en el orden del contrato, y la cláusula de cierre —escrita ANTES de que ese contrato
// existiera— exigía cerrar la respuesta con el bloque de emisión. Donde el output de imagen no es
// el último, obedecer las dos significa emitir el bloque DOS VECES. La regla nueva es «exactamente
// una vez, bajo su encabezado».
//
// CONSERVANDO EL EXECUTOR. Cuatro de las nueve filas (3.1, 3.3, 3.4, 3.7) traen
// `anthropic:claude-sonnet-4-6` porque salieron de una base anterior al cambio a MiniMax: sin esta
// guarda, aplicarlas revierte cuatro nodos en silencio. Es la misma trampa de v2.9.23.
//
// Uso:  node scripts/aplicar-v2_9_26.js            (simula)
//       node scripts/aplicar-v2_9_26.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const DIR = process.env.V2926_DIR
  || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Documents-V57-Studio-Forge/da14a22a-81f0-4a69-8c7d-14af2e78aa1f/scratchpad/v2926/Forge_v2.9.26'
const APLICAR = process.argv.includes('--apply')

const val = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
const igual = (a, b) => JSON.stringify(val(a)) === JSON.stringify(val(b))
const CIERRE = /closes with|final content|nothing after/gi

;(async () => {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, 'nodes_v2.9.26.json'), 'utf8'))
  const filas = Array.isArray(j) ? j : (j.nodes || j.rows)

  const plan = []
  const problemas = []
  for (const f of filas) {
    const { data: v } = await db().from('forge_nodes').select('*').eq('node_key', f.node_key).maybeSingle()
    if (!v) { problemas.push(`${f.node_key}: no existe en la base`); continue }

    // Lo que SÍ se escribe. `executor` nunca: se conserva el vivo.
    const campos = {}
    if (!igual(f.outputs, v.outputs))               campos.outputs = val(f.outputs)
    if (f.default_prompt !== v.default_prompt)      campos.default_prompt = f.default_prompt
    if (!igual(f.metadata, v.metadata))             campos.metadata = val(f.metadata)

    const revierte = !igual(f.executor, v.executor)
    plan.push({ nk: f.node_key, campos, revierte, vivoExec: val(v.executor), deltaExec: val(f.executor),
      cierreAntes: (String(v.default_prompt || '').match(CIERRE) || []).length,
      cierreDespues: (String(f.default_prompt || '').match(CIERRE) || []).length,
      once: /EXACTLY ONCE/i.test(String(f.default_prompt || '')) })
  }

  console.log('=== v2.9.26 · 9 filas ===')
  for (const p of plan) {
    console.log(`  ${p.nk.padEnd(6)} escribe: ${Object.keys(p.campos).join(', ') || 'nada'}`)
    if (p.revierte) console.log(`         executor CONSERVADO: ${JSON.stringify(p.vivoExec)}  (el delta traía ${JSON.stringify(p.deltaExec)})`)
    if (p.cierreAntes || p.cierreDespues || p.once) {
      console.log(`         cláusulas de cierre ${p.cierreAntes} → ${p.cierreDespues} · EXACTLY ONCE: ${p.once}`)
    }
  }
  const conservados = plan.filter(p => p.revierte).length
  console.log(`\nexecutors que se conservan (el delta los habría revertido): ${conservados}`)

  if (problemas.length) {
    console.error('\n*** NO SE APLICA ***')
    for (const p of problemas) console.error(`  · ${p}`)
    process.exit(1)
  }
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const bdir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(bdir, { recursive: true })
  for (const f of filas) {
    const { data: v } = await db().from('forge_nodes').select('*').eq('node_key', f.node_key).single()
    fs.writeFileSync(path.join(bdir, `nodo_${f.node_key}_pre_v2.9.26.json`), JSON.stringify(v, null, 2))
  }
  console.log(`respaldos → ${bdir}`)

  for (const p of plan) {
    if (!Object.keys(p.campos).length) continue
    const { error } = await db().from('forge_nodes').update(p.campos).eq('node_key', p.nk)
    if (error) { console.error(`${p.nk}: ${error.message}`); process.exit(1) }
  }

  console.log('\n=== verificación (releído de la base) ===')
  for (const f of filas) {
    const { data: r } = await db().from('forge_nodes').select('executor, default_prompt, metadata, outputs').eq('node_key', f.node_key).single()
    const cierre = (String(r.default_prompt || '').match(CIERRE) || []).length
    const once = /EXACTLY ONCE/i.test(String(r.default_prompt || ''))
    const ok = igual(r.outputs, f.outputs)
    console.log(`  ${f.node_key.padEnd(6)} executor=${JSON.stringify(val(r.executor)).slice(0, 46).padEnd(46)}`
      + ` outputs==delta:${ok} · cierres:${cierre} · once:${once} · v${val(r.metadata)?.dna_version}`)
  }
})()
