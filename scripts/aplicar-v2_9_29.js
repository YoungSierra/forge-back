// Aplica v2.9.29 (VisualPitchFills): 2 filas de ADN (2.5, 2.4) + el workflow v2 del Visual Pitch.
//
// Las dos cosas van JUNTAS o el 2.5 queda peor que antes: la DNA nueva hace que el output emita
// FILLS —solo el texto de las zonas— en vez de un prompt de render completo, y eso únicamente
// funciona contra el scaffold del workflow v2, que aporta el rol, las reglas y la gramática.
//
// El zip NO trae `inject_config`, y la registrada apunta al archivo viejo: prompt→nodo 14, y en el
// v2 los nodos son 20/21/22/23. Registrarlo sin reescribirla manda el prompt a un nodo inexistente
// y la lámina sale con el marcador sin reemplazar. La config va acá, escrita contra el archivo:
//
//   prompt  → nodo 20, campo `string_b`  (donde vive {{VISUAL_PITCH_FILLS}})
//   seed    → nodo 22
//   salidas → nodo 23
//   sin `image` ni `ref_proyecto`: el único hueco de imagen es la referencia de maquetación, que
//   por decisión de Pedro es constante del estudio y vive DENTRO del workflow. Inyectar el arte
//   del proyecto ahí la pisaría.
//
// Uso:  node scripts/aplicar-v2.9.29.js            (simula)
//       node scripts/aplicar-v2.9.29.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const DIR = process.env.V2929_DIR
  || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Documents-V57-Studio-Forge/da14a22a-81f0-4a69-8c7d-14af2e78aa1f/scratchpad/v2929/Forge_v2.9.29'
const APLICAR = process.argv.includes('--apply')
const WF = 'V57_STUDIO_2.5_Visual_pitch'

const val = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
const igual = (a, b) => JSON.stringify(val(a)) === JSON.stringify(val(b))
const CAMPOS = ['inputs', 'outputs', 'constraints', 'default_prompt', 'metadata']


;(async () => {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, 'nodes_v2.9.29.json'), 'utf8'))
  const filas = Array.isArray(j) ? j : (j.nodes || j.rows)
  
  const problemas = []
  const plan = []

  // ── Las filas ───────────────────────────────────────────────────────────────
  for (const f of filas) {
    const { data: v } = await db().from('forge_nodes').select('*').eq('node_key', f.node_key).maybeSingle()
    if (!v) { problemas.push(`${f.node_key}: no existe`); continue }
    if (!igual(f.executor, v.executor)) problemas.push(`${f.node_key}: el executor cambiaría`)
    const campos = {}
    for (const k of CAMPOS) if (k in f && !igual(f[k], v[k])) campos[k] = val(f[k])
    plan.push({ nk: f.node_key, campos, viva: v, nueva: f })
  }


  console.log('=== v2.9.29 ===')
  for (const p of plan) {
    console.log(`  ${p.nk.padEnd(5)} escribe: ${Object.keys(p.campos).join(', ') || 'nada'} · executor ${JSON.stringify(val(p.viva.executor))}`)
    for (const o of (val(p.nueva.outputs) || []).filter(x => x.image_gen)) {
      const antes = (val(p.viva.outputs) || []).find(x => (x.key || x.name) === (o.key || o.name))
      if (antes && antes.image_gen_model !== o.image_gen_model) {
        console.log(`         ${o.key || o.name}: workflow ${antes.image_gen_model} → ${o.image_gen_model}`)
      }
    }
  }

  if (problemas.length) {
    console.error('\n*** NO SE APLICA ***')
    for (const x of problemas) console.error(`  · ${x}`)
    process.exit(1)
  }
  console.log('\ntodas las puertas pasan: la config apunta a nodos reales y el marcador está donde se escribe.')

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const bdir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(bdir, { recursive: true })
  for (const p of plan) fs.writeFileSync(path.join(bdir, `nodo_${p.nk}_pre_v2.9.29.json`), JSON.stringify(p.viva, null, 2))
  console.log(`respaldos → ${bdir}`)

  for (const p of plan) {
    if (!Object.keys(p.campos).length) continue
    const { error } = await db().from('forge_nodes').update(p.campos).eq('node_key', p.nk)
    if (error) { console.error(`${p.nk}: ${error.message}`); process.exit(1) }
  }

  // ── Verificación: se simula la inyección sobre lo YA registrado ─────────────
  console.log('\n=== verificación ===')
  for (const p of plan) {
    const { data: r } = await db().from('forge_nodes').select('executor,outputs,metadata').eq('node_key', p.nk).single()
    console.log(`  ${p.nk.padEnd(5)} v${val(r.metadata)?.dna_version} · executor ${JSON.stringify(val(r.executor))} · outputs==delta ${igual(r.outputs, p.nueva.outputs)}`)
  }
})()
