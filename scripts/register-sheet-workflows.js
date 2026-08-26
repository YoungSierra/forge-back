// ─── Registra los workflows de producción por página «Sheet» ─────────────────
//
// Del documento de Miguel del 26-08. Todas las páginas Sheet funcionan igual que Character Sheet:
// Design Edits ajusta la página en su sitio, y Run la avanza por su cadena.
//
// Acá entran Prop y Environment. Marketing (imagen y video) NO: sus prompts son un formulario que
// hay que rellenar con el ADI —«GAME TITLE (S1.1) ->», «VISUAL KEYWORDS (S2.3) ->»— así que
// necesitan un ensamblador, no un cable. Registrarlos sin eso produciría un prompt con los campos
// vacíos, que es peor que no tenerlos.
//
// Uso:  node scripts/register-sheet-workflows.js [--apply]

require('dotenv').config()
const fs   = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APPLY = process.argv.includes('--apply')
const DIR   = path.join(__dirname, '..', '..', 'P-26082026', 'x_wf')

// Las 20 partes del escenario: `env_asset_01`..`20` en los nodos 401..420.
const partesEnv = {}
for (let i = 1; i <= 20; i++) partesEnv[String(400 + i)] = `parte_${String(i).padStart(2, '0')}`

const PLAN = [
  {
    name: 'V57_STUDIO_ConceptArt_Props',
    file: 'V57_STUDIO_Vertical Slice_Concept Art_Props.json',
    description: 'Prop Sheet, paso 1: de la página del prop a su concept art.',
    inject_config: { seed: { node: '268', field: 'seed' }, extra: { image: { node: '272', type: 'image', field: 'image' } } },
    salidas: { '269': 'concept' },
  },
  {
    name: 'V57_STUDIO_3D_Production_Props',
    file: 'V57_STUDIO_Vertical Slice_3D_Production_Props.json',
    description: 'Prop Sheet, paso 2: del concept art al modelo 3D. Tripo, una sola imagen.',
    // El `Preview3D` publica el MISMO .glb que el `SaveGLB`; solo se declara el segundo.
    inject_config: { seed: { node: '48', field: 'model_seed' }, extra: { image: { node: '45', type: 'image', field: 'image' } } },
    salidas: { '32': 'glb' },
  },
  {
    name: 'V57_STUDIO_ConceptArt_Environments',
    file: 'V57_STUDIO_Vertical Slice_Concept Art_Environments.json',
    description: 'Environment Sheet, paso 1: de la página del escenario a sus 20 partes. Una sola corrida.',
    // Los nodos 269 y 284 son intermedios sin nombre propio (`gpt-image-2`): alimentan a los 20 y
    // no se publican. Solo se declaran las partes.
    inject_config: { seed: { node: '268', field: 'seed' }, extra: { image: { node: '272', type: 'image', field: 'image' } } },
    salidas: partesEnv,
  },
  {
    name: 'V57_STUDIO_3D_Production_Environment',
    file: 'V57_STUDIO_Vertical Slice_3D_Production_Environment.json',
    description: 'Environment Sheet, paso 2: cada parte del paso 1 a su modelo 3D. Corre una vez por parte.',
    inject_config: { seed: { node: '48', field: 'model_seed' }, extra: { image: { node: '45', type: 'image', field: 'image' } } },
    salidas: { '32': 'glb' },
  },
]

;(async () => {
  for (const p of PLAN) {
    const ruta = path.join(DIR, p.file)
    if (!fs.existsSync(ruta)) { console.error('ABORTA: no existe', ruta); process.exit(1) }
    const wf = JSON.parse(fs.readFileSync(ruta, 'utf-8'))

    // Cada punto de inyección se verifica contra el JSON: uno que apunte a un nodo inexistente no
    // falla, solo avisa por consola — y el workflow correría con la imagen de ejemplo que trae.
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

    const { data: ya } = await db().from('comfyui_workflows').select('id').eq('name', p.name).maybeSingle()
    const roles = Object.values(p.salidas)
    console.log(`\n### ${p.name}  (${Object.keys(wf).length} nodos)  ${ya ? '→ ACTUALIZA' : '→ CREA'}`)
    console.log('    ', p.description)
    console.log(`     salidas: ${roles.length} → ${roles.slice(0, 4).join(', ')}${roles.length > 4 ? `, … ${roles[roles.length - 1]}` : ''}`)
    for (const [k, pt] of Object.entries(p.inject_config.extra || {})) console.log(`     entrada ${k.padEnd(11)} → [${pt.node}] ${wf[pt.node].class_type}.${pt.field}`)

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
