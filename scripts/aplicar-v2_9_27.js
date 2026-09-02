// Aplica v2.9.27 (EnvelopeContract): 5 filas — 2.2, 3.1, 3.3, 3.4, 3.7.
//
// Cierra la causa raíz de los cinco esquemas distintos que emitió el 2.2 con la misma DNA: el
// esquema del sobre estaba DESCRITO con puntos suspensivos —`{ "id": "...", "prompt": "..." }`—,
// que no es un ejemplo sino un hueco. Ahora es un contrato literal: campos cerrados con nombre
// exacto, `prompt` obligatorio, sin URLs dentro del bloque, cardinalidad por output y un ejemplo
// con valores reales.
//
// De paso: la `[ IMAGE: <id> ]` sin reemplazar que veíamos NO era capricho del modelo — el
// placeholder estaba escrito así en la propia DNA y el modelo lo copió.
//
// Se escriben SOLO los campos que cambian y NUNCA el executor: v2.9.26 traía Sonnet en cuatro
// filas que ya corrían MiniMax, y aplicarla entera las habría revertido en silencio. Este delta
// asegura traerlo igual al vivo; igual se verifica antes y después.
//
// Uso:  node scripts/aplicar-v2_9_27.js            (simula)
//       node scripts/aplicar-v2_9_27.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const DIR = process.env.V2927_DIR
  || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Documents-V57-Studio-Forge/da14a22a-81f0-4a69-8c7d-14af2e78aa1f/scratchpad/v2927/Forge_v2.9.27'
const APLICAR = process.argv.includes('--apply')

const val = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
const igual = (a, b) => JSON.stringify(val(a)) === JSON.stringify(val(b))
const CAMPOS = ['outputs', 'constraints', 'default_prompt', 'metadata']

// Lo que el delta promete que no sobrevive. Se comprueba DESPUÉS de escribir, no de palabra.
const PROHIBIDO = [
  ['<id>', /<id>/g],
  ['style_anchor', /style_anchor/g],
  ['closes with', /closes? with/gi],
  ['[] is a valid emission', /\[\]\s*is a valid emission/gi],
  ['even when empty', /even when empty/gi],
]
const textoDe = f => JSON.stringify([f.default_prompt, val(f.outputs), val(f.constraints)])

;(async () => {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, 'nodes_v2.9.27.json'), 'utf8'))
  const filas = Array.isArray(j) ? j : (j.nodes || j.rows)

  const plan = []
  const problemas = []
  for (const f of filas) {
    const { data: v } = await db().from('forge_nodes').select('*').eq('node_key', f.node_key).maybeSingle()
    if (!v) { problemas.push(`${f.node_key}: no existe en la base`); continue }
    if (!igual(f.executor, v.executor)) {
      problemas.push(`${f.node_key}: el executor cambiaría — ${JSON.stringify(val(v.executor))} → ${JSON.stringify(val(f.executor))}`)
    }
    const campos = {}
    for (const k of CAMPOS) if (k in f && !igual(f[k], v[k])) campos[k] = val(f[k])
    plan.push({ nk: f.node_key, campos, viva: v, nueva: f })
  }

  console.log('=== v2.9.27 · 5 filas ===')
  for (const p of plan) {
    console.log(`  ${p.nk.padEnd(6)} escribe: ${Object.keys(p.campos).join(', ') || 'nada'}`)
    const antes = textoDe(p.viva), despues = textoDe(p.nueva)
    for (const [nombre, rx] of PROHIBIDO) {
      const a = (antes.match(rx) || []).length, d = (despues.match(rx) || []).length
      if (a || d) console.log(`         ${nombre.padEnd(24)} ${a} → ${d}${d ? '   *** NO SE LIMPIA' : ''}`)
      if (d) problemas.push(`${p.nk}: sobrevive «${nombre}»`)
    }
    // Los ejemplos del sobre tienen que parsear: un ejemplo roto enseña a emitir roto.
    for (const o of (val(p.nueva.outputs) || []).filter(x => x.image_gen)) {
      for (const b of String(o.prompt || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
        try { JSON.parse(b[1]) } catch (e) { problemas.push(`${p.nk}/${o.key || o.name}: el ejemplo no parsea — ${e.message.slice(0, 50)}`) }
      }
    }
  }

  if (problemas.length) {
    console.error('\n*** NO SE APLICA ***')
    for (const x of problemas) console.error(`  · ${x}`)
    process.exit(1)
  }
  console.log('\ntodas las puertas pasan: executor intacto en las 5, nada prohibido sobrevive, los ejemplos parsean.')

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const bdir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(bdir, { recursive: true })
  for (const p of plan) fs.writeFileSync(path.join(bdir, `nodo_${p.nk}_pre_v2.9.27.json`), JSON.stringify(p.viva, null, 2))
  console.log(`respaldos → ${bdir}`)

  for (const p of plan) {
    if (!Object.keys(p.campos).length) continue
    const { error } = await db().from('forge_nodes').update(p.campos).eq('node_key', p.nk)
    if (error) { console.error(`${p.nk}: ${error.message}`); process.exit(1) }
  }

  console.log('\n=== verificación (releído de la base) ===')
  for (const p of plan) {
    const { data: r } = await db().from('forge_nodes').select('executor,default_prompt,outputs,constraints,metadata').eq('node_key', p.nk).single()
    const t = textoDe(r)
    const sucio = PROHIBIDO.filter(([, rx]) => (t.match(rx) || []).length).map(([n]) => n)
    const exOk = igual(r.executor, p.viva.executor)
    console.log(`  ${p.nk.padEnd(6)} executor ${exOk ? 'intacto' : '*** CAMBIÓ'} · ${JSON.stringify(val(r.executor)).slice(0, 44)}`)
    console.log(`         v${val(r.metadata)?.dna_version} · outputs==delta: ${igual(r.outputs, p.nueva.outputs)} · prohibido que sobrevive: ${sucio.length ? sucio.join(', ') : 'nada'}`)
  }
})()
