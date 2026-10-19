// ─── Registra los dos workflows de la cadena de Tile Textures ────────────────
//
// Del handoff de Miguel del 19-10 (ASG de 34 páginas, p.34 Tile Textures Sheet). Dos pasos con la
// revisión en medio: la hoja → la textura base, y la base → los cuatro mapas PBR en una corrida.
//
// Los JSON se leen de la unidad compartida de Drive y no de una copia local: la instrucción de
// repeticiones lo pide así («las locales varían entre ajustes»). Otra carpeta se pasa con --dir.
//
// Uso:  node scripts/register-tile-textures.js [--dir <carpeta>] [--apply]

require('dotenv').config()
const fs   = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APPLY = process.argv.includes('--apply')
const iDir  = process.argv.indexOf('--dir')
const DIR   = iDir > -1 ? process.argv[iDir + 1]
  : 'G:/Unidades compartidas/FORGE PLATFORM/V57_Studio_Official Docs/Forge_ComfyUICloud_Workflows/Blueprint_Vertical Slice'

const PLAN = [
  {
    name: 'V57_STUDIO_2D_Tile_Texture_Creator',
    file: 'V57_STUDIO_2D_Tile_Texture_Creator.json',
    description: 'Tile Textures Sheet, paso 1: de la hoja (panel BASE SURFACE SAMPLE) a la textura base sin costuras.',
    // 279 recibe la hoja; 287 es el GPT Image que la lee, 288 el refinado del interior. El 290
    // (Claude) escribe el brief de material desde la misma hoja.
    inject_config: {
      seed: { node: '287', field: 'seed' },
      extra: {
        image:       { node: '279', type: 'image', field: 'image' },
        seed_refine: { node: '288', type: 'int', field: 'seed' },
      },
    },
    salidas: { '296': 'base_color' },
  },
  {
    name: 'V57_STUDIO_2D_Seamless_PBR_Textures',
    file: 'V57_STUDIO_2D_Seamless_PBR Textures.json',
    description: 'Tile Textures Sheet, paso 2: de la textura base a Normal, AO, Height y MetallicSmoothness, en una corrida.',
    // Cinco ramas en paralelo, una semilla por rama: con la misma en todas, los mapas salen
    // parecidos entre sí en vez de cada uno a su función.
    inject_config: {
      seed: { node: '321', field: 'seed' },
      extra: {
        image:          { node: '316', type: 'image', field: 'image' },
        seed_ao:        { node: '324', type: 'int', field: 'seed' },
        seed_height:    { node: '327', type: 'int', field: 'seed' },
        seed_metallic:  { node: '330', type: 'int', field: 'seed' },
        seed_roughness: { node: '333', type: 'int', field: 'seed' },
      },
    },
    // 330 (metallic) y 333 (roughness) son intermedios: se empaquetan en el 342.
    salidas: { '322': 'normal', '325': 'ao', '328': 'height', '342': 'metallic_smoothness' },
  },
]

;(async () => {
  for (const p of PLAN) {
    const ruta = path.join(DIR, p.file)
    if (!fs.existsSync(ruta)) { console.error('ABORTA: no existe', ruta); process.exit(1) }
    const wf = JSON.parse(fs.readFileSync(ruta, 'utf-8'))

    // Cada punto de inyección se verifica contra el JSON: uno que apunte a un nodo inexistente no
    // falla, solo avisa por consola — y el workflow correría con el placeholder que trae.
    for (const pt of [p.inject_config.seed, ...Object.values(p.inject_config.extra || {})]) {
      if (!wf[pt.node]) { console.error(`ABORTA: ${p.name} — no existe el nodo "${pt.node}"`); process.exit(1) }
      if (!(pt.field in (wf[pt.node].inputs || {}))) {
        console.error(`ABORTA: ${p.name} — el nodo "${pt.node}" (${wf[pt.node].class_type}) no tiene "${pt.field}"`)
        process.exit(1)
      }
    }
    for (const nodo of Object.keys(p.salidas)) {
      if (!wf[nodo]) { console.error(`ABORTA: ${p.name} — no existe la salida "${nodo}"`); process.exit(1) }
      if (!/^Save/.test(wf[nodo].class_type)) {
        console.error(`ABORTA: ${p.name} — la salida "${nodo}" es ${wf[nodo].class_type}, no un Save*`)
        process.exit(1)
      }
    }
    // El placeholder de la entrada tiene que ser el del handoff: si no, se registró otro JSON.
    const entrada = wf[p.inject_config.extra.image.node].inputs.image
    if (!/^REPLACE_WITH__/.test(entrada)) console.warn(`  ⚠ ${p.name}: la entrada trae «${entrada}», no un REPLACE_WITH__`)

    const { data: ya } = await db().from('comfyui_workflows').select('id').eq('name', p.name).maybeSingle()
    const roles = Object.values(p.salidas)
    console.log(`\n### ${p.name}  (${Object.keys(wf).length} nodos)  ${ya ? '→ ACTUALIZA' : '→ CREA'}`)
    console.log('    ', p.description)
    console.log(`     salidas: ${roles.length} → ${roles.join(', ')}`)
    for (const [k, pt] of Object.entries(p.inject_config.extra || {})) console.log(`     entrada ${k.padEnd(14)} → [${pt.node}] ${wf[pt.node].class_type}.${pt.field}`)

    if (!APPLY) continue
    const fila = { name: p.name, description: p.description, workflow_json: wf,
                   inject_config: { ...p.inject_config, salidas: p.salidas }, is_active: true }
    const r = ya
      ? await db().from('comfyui_workflows').update(fila).eq('id', ya.id)
      : await db().from('comfyui_workflows').insert(fila)
    if (r.error) { console.error('ERR', p.name, r.error.message); process.exit(1) }
    console.log('     ✔ escrito')
  }
  console.log(APPLY ? '\n✔ aplicado' : '\n→ correr con --apply')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
