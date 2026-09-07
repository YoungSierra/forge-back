// Aplica v2.9.32 (ASG25): 2 filas — 3.20 y 1.1.
//
// Lleva el 3.20 al maestro de 25 páginas de Migue: una sola pasada, `asg_synthesis_images`
// retirado, `reference_map` a los 8 slots reales, el Art Bible a 20 páginas, y la corrección del
// SECTION CONTRACT de v2.9.31 —el modelo escribe TRES secciones, no nueve: los prompt sets son
// ensamblaje determinista y las imágenes son renders—. En 1.1, el default pasa a pedir 3–5 seeds,
// que es de donde salían 20 de los 31 avisos de `image_count`.
//
// PUERTAS
//   0 · La base del zip contra la tabla viva, ignorando el orden de claves (jsonb no lo conserva).
//   1 · El executor del zip es el del vivo.
//   2 · Lo declarado tiene que coincidir con el workflow REGISTRADO. Es la puerta que importa hoy:
//       un output que declara 20 páginas apuntando a un deck de 26 no falla al escribirse, falla
//       al correr —`generateDeck` lo rechaza— y para entonces ya nadie se acuerda del delta.
//   3 · Solo se permite perder `asg_synthesis_images`, y solo si nadie lo consume. Un output que
//       desaparece es la falla más cara y la más fácil de no ver.
//
// EL REPUNTE. El Art Bible de 20 páginas quedó registrado como `V57_STUDIO_ArtBible_Template_20`,
// no con el nombre del de 26 — igual que el ASG quedó como `..._25`, que es a lo que Pedro ya
// apunta. Él lo pidió así: «si lo registrás con otro nombre, avisá y lo repunto». Se repunta acá,
// que es un campo, y se le avisa.
//
// Uso:  node scripts/aplicar-v2_9_32.js            (simula)
//       node scripts/aplicar-v2_9_32.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')
const { techoDeclarado, textoDeCuenta } = require('../src/services/image-count')

const DIR = process.env.V2932_DIR
  || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Documents-V57-Studio-Forge/da14a22a-81f0-4a69-8c7d-14af2e78aa1f/scratchpad/v2932/Forge_v2.9.32'
const APLICAR = process.argv.includes('--apply')

// El repunte: workflow que dice el zip → workflow que está registrado de verdad.
const REPUNTAR = { 'comfyui:V57_STUDIO_ArtBible_Template': 'comfyui:V57_STUDIO_ArtBible_Template_20' }
// Lo único que este delta puede quitar.
const RETIRAR = ['asg_synthesis_images']

const val = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
const ord = v => Array.isArray(v) ? v.map(ord)
  : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ord(v[k])])) : v
const igual = (a, b) => JSON.stringify(ord(val(a))) === JSON.stringify(ord(val(b)))
const CAMPOS = ['inputs', 'outputs', 'constraints', 'default_prompt', 'metadata']
const COMPARAR = [...CAMPOS, 'tools', 'skills', 'executor', 'purpose', 'role', 'title', 'status', 'phase', 'standalone_prompt']

;(async () => {
  const filas = JSON.parse(fs.readFileSync(path.join(DIR, 'nodes_v2.9.32.json'), 'utf8'))
  const baseRaw = JSON.parse(fs.readFileSync(path.join(DIR, 'base_export_20260903_plus_v2.9.30_31.json'), 'utf8'))
  const baseFilas = Array.isArray(baseRaw) ? baseRaw : (baseRaw.nodes || baseRaw.rows || Object.values(baseRaw)[0])
  const porBase = Object.fromEntries(baseFilas.map(f => [f.node_key, f]))

  const problemas = []
  const plan = []

  for (const f of filas) {
    const { data: v } = await db().from('forge_nodes').select('*').eq('node_key', f.node_key).maybeSingle()
    if (!v) { problemas.push(`${f.node_key}: no existe`); continue }

    // ── El repunte de workflows, ANTES de comparar ─────────────────────────────
    //
    // Va primero porque el repunte es parte de lo que este delta significa acá. Comparando antes,
    // la fila ya escrita no coincide con el zip sin repuntar, el script la da por «no aplicada» y
    // acusa a Pedro de haber movido algo — un falso susto en cada reejecución.
    //
    // Se parsea UNA vez y se guarda de vuelta en la fila. La primera versión mutaba una copia, y
    // tanto el diff como lo que se escribe volvían a parsear el texto original: las puertas daban
    // el repunte por bueno y a la base iba el nombre viejo.
    f.outputs = val(f.outputs) || []
    const outs = f.outputs
    const repuntes = []
    for (const o of outs) {
      if (o.image_gen_model && REPUNTAR[o.image_gen_model]) {
        repuntes.push(`${o.key || o.name}: ${o.image_gen_model} → ${REPUNTAR[o.image_gen_model]}`)
        o.image_gen_model = REPUNTAR[o.image_gen_model]
      }
    }

    const yaAplicada = COMPARAR.filter(c => c in f).every(c => igual(f[c], v[c]))
    const b = porBase[f.node_key]
    if (yaAplicada) console.log(`  ${f.node_key}: ya está aplicada`)
    else if (!b) problemas.push(`${f.node_key}: no está en la base del zip`)
    else {
      const desviado = COMPARAR.filter(c => c in b && !igual(b[c], v[c]))
      if (desviado.length) problemas.push(`${f.node_key}: la base difiere del vivo en ${desviado.join(', ')} — parar y avisar a Pedro`)
    }
    if (!igual(f.executor, v.executor)) problemas.push(`${f.node_key}: el executor cambiaría`)

    // ── Puerta 2 · lo declarado contra el workflow registrado ──────────────────
    for (const o of outs.filter(x => x.image_gen && x.image_gen_model)) {
      const nombre = String(o.image_gen_model).replace(/^comfyui:/, '')
      const { data: w } = await db().from('comfyui_workflows').select('inject_config').eq('name', nombre).maybeSingle()
      if (!w) { problemas.push(`${f.node_key}/${o.key || o.name}: el workflow «${nombre}» no está registrado`); continue }
      const cfg = val(w.inject_config)
      const paginas = cfg?.pages?.length
      const declara = techoDeclarado(o)
      if (paginas && declara && paginas !== declara) {
        problemas.push(`${f.node_key}/${o.key || o.name}: declara ${textoDeCuenta(o)} pero «${nombre}» tiene ${paginas} páginas`
          + ' — generateDeck rechazaría la corrida')
      }
    }

    // ── Puerta 3 · qué outputs se pierden ─────────────────────────────────────
    const kv = (val(v.outputs) || []).map(o => o.key || o.name)
    const kf = outs.map(o => o.key || o.name)
    for (const k of kv) {
      if (kf.includes(k)) continue
      if (!RETIRAR.includes(k)) { problemas.push(`${f.node_key}: se perdería el output ${k}, que no está declarado como retirado`); continue }
      const { data: nodos } = await db().from('forge_nodes').select('node_key,inputs,outputs').neq('node_key', f.node_key)
      const consumen = nodos.filter(n => (JSON.stringify(n.inputs) + JSON.stringify((n.outputs || []).map(o => o.uses))).includes(k)).map(n => n.node_key)
      if (consumen.length) problemas.push(`${f.node_key}: ${k} se retira pero lo consumen ${consumen.join(', ')}`)
      else console.log(`  ${f.node_key}: se retira «${k}» — nadie lo consume aguas abajo ✓`)
    }

    const campos = {}
    for (const k of CAMPOS) if (k in f && !igual(f[k], v[k])) campos[k] = val(f[k])
    plan.push({ nk: f.node_key, campos, viva: v, nueva: f, repuntes })
  }

  console.log('\n=== v2.9.32 · ASG on the 25-page master ===\n')
  for (const p of plan) {
    console.log(`  ${p.nk.padEnd(5)} v${val(p.viva.metadata)?.dna_version} → v${val(p.nueva.metadata)?.dna_version}`
      + `  escribe: ${Object.keys(p.campos).join(', ') || 'nada'}`)
    for (const r of p.repuntes) console.log(`        ↻ repuntado ${r}`)
    const vo = val(p.viva.outputs) || [], fo = val(p.nueva.outputs) || []
    console.log(`        outputs ${vo.length} → ${fo.length}`)
    for (const o of fo) {
      const k = o.key || o.name
      const antes = vo.find(x => (x.key || x.name) === k)
      if (!antes) { console.log(`        + NUEVO ${k}`); continue }
      const dif = [...new Set([...Object.keys(o), ...Object.keys(antes)])].filter(c => !igual(o[c], antes[c]))
      if (dif.length) console.log(`        ~ ${k.padEnd(24)} ${dif.join(', ')}`)
    }
    for (const o of vo) if (!fo.find(x => (x.key || x.name) === (o.key || o.name))) console.log(`        − RETIRADO ${o.key || o.name}`)
  }

  if (problemas.length) {
    console.error('\n*** NO SE APLICA ***')
    for (const x of problemas) console.error(`  · ${x}`)
    process.exit(1)
  }
  console.log('\ntodas las puertas pasan: base == vivo, executor intacto, cuentas == workflow registrado, y lo retirado no lo consume nadie.')

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const bdir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(bdir, { recursive: true })
  for (const p of plan) fs.writeFileSync(path.join(bdir, `nodo_${p.nk}_pre_v2.9.32.json`), JSON.stringify(p.viva, null, 2))
  console.log(`\nrespaldos → ${bdir}`)

  for (const p of plan) {
    if (!Object.keys(p.campos).length) continue
    const { error } = await db().from('forge_nodes').update(p.campos).eq('node_key', p.nk)
    if (error) { console.error(`${p.nk}: ${error.message}`); process.exit(1) }
  }

  console.log('\n=== verificación ===')
  for (const p of plan) {
    const { data: r } = await db().from('forge_nodes').select('executor,outputs,metadata,constraints').eq('node_key', p.nk).single()
    const outs = val(r.outputs) || []
    console.log(`  ${p.nk.padEnd(5)} v${val(r.metadata)?.dna_version} · outputs ${outs.length}`
      + ` · outputs==delta ${igual(r.outputs, p.nueva.outputs)} · executor intacto ${igual(r.executor, p.viva.executor)}`)
    for (const o of outs.filter(x => x.image_gen)) {
      console.log(`        ${(o.key || o.name).padEnd(22)} ${textoDeCuenta(o)} págs → ${o.image_gen_model}`)
    }
  }
})()
