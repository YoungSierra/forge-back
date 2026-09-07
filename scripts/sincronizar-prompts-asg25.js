// Sincroniza los prompts del ASG-25 desde el export del EDITOR hacia el workflow API registrado.
//
// Por qué existe: ComfyUI solo acepta el export de API, pero Miguel trabaja en el editor y cuando
// corrige una frase manda el export del editor. Pedirle un reexport de API por cada cambio de
// texto es un viaje de ida y vuelta por algo que no toca el grafo.
//
// Esto NO reemplaza el workflow: copia únicamente el campo `prompt` de cada página, emparejando
// por id de nodo —que es el mismo en los dos formatos—. Si cambiara la forma del grafo (nodos,
// enlaces, cuántas páginas), se niega y pide el export de API, porque eso ya no es un cambio de
// texto y copiar prompts sobre un grafo viejo dejaría el workflow mintiendo sobre sí mismo.
//
// Uso:  node scripts/sincronizar-prompts-asg25.js <export_editor.json>            (simula)
//       node scripts/sincronizar-prompts-asg25.js <export_editor.json> --apply
require('dotenv').config()
const fs = require('fs')
const { db } = require('../src/services/supabase.service')

const RUTA = process.argv[2]
const APLICAR = process.argv.includes('--apply')
const NOMBRE = process.env.ASG25_NOMBRE || 'V57_STUDIO_ArtStyleGuide_Template_25'
if (!RUTA) { console.error('uso: node scripts/sincronizar-prompts-asg25.js <export_editor.json> [--apply]'); process.exit(1) }

const RX_FUENTE = /IMAGE 2 = [^\n]*coming from ([^.]+)\./

;(async () => {
  const ui = JSON.parse(fs.readFileSync(RUTA, 'utf8'))
  if (!Array.isArray(ui.nodes)) { console.error('*** eso no es el export del editor (no tiene `nodes`) ***'); process.exit(1) }

  const { data: reg } = await db().from('comfyui_workflows')
    .select('id,workflow_json,inject_config').eq('name', NOMBRE).maybeSingle()
  if (!reg) { console.error(`*** no hay ningún workflow registrado como ${NOMBRE} ***`); process.exit(1) }
  const api = typeof reg.workflow_json === 'string' ? JSON.parse(reg.workflow_json) : reg.workflow_json
  const cfg = typeof reg.inject_config === 'string' ? JSON.parse(reg.inject_config) : reg.inject_config

  // Puerta: la forma del grafo tiene que ser la misma. Un prompt copiado sobre un grafo distinto
  // es peor que no copiar nada — el workflow diría una cosa y renderizaría otra.
  const tiposUi = {}
  for (const n of ui.nodes) tiposUi[n.type] = (tiposUi[n.type] || 0) + 1
  const tiposApi = {}
  for (const n of Object.values(api)) tiposApi[n.class_type] = (tiposApi[n.class_type] || 0) + 1
  const forma = JSON.stringify(Object.entries(tiposUi).sort()) === JSON.stringify(Object.entries(tiposApi).sort())
  if (!forma) {
    console.error('*** el grafo cambió, no solo los prompts — hace falta un export de API ***')
    console.error(`   editor: ${JSON.stringify(tiposUi)}`)
    console.error(`   registrado: ${JSON.stringify(tiposApi)}`)
    process.exit(1)
  }

  const promptUi = n => (n.widgets_values || []).find(v => typeof v === 'string' && v.length > 40) || ''
  const uiPorId = Object.fromEntries(ui.nodes.map(n => [String(n.id), n]))

  const cambios = []
  const faltan = []
  for (const p of cfg.pages) {
    const viejo = String(api[p.prompt_node]?.inputs?.prompt ?? '')
    const nuevo = promptUi(uiPorId[p.prompt_node] || {})
    if (!nuevo) { faltan.push(p.name); continue }
    if (viejo.trim() === nuevo.trim()) continue
    cambios.push({ pagina: p.name, nodo: p.prompt_node, viejo, nuevo, conHueco: !!p.image_input })
  }

  if (faltan.length) {
    console.error(`*** ${faltan.length} página(s) sin prompt en el export: ${faltan.join(', ')} ***`)
    process.exit(1)
  }

  console.log(`${NOMBRE}: ${cfg.pages.length} páginas · cambian ${cambios.length}\n`)
  for (const c of cambios) {
    const fv = RX_FUENTE.exec(c.viejo)?.[1]?.trim()
    const fn = RX_FUENTE.exec(c.nuevo)?.[1]?.trim()
    console.log(`  ${c.pagina.padEnd(26)} nodo ${c.nodo}  ${c.viejo.length} → ${c.nuevo.length} chars`)
    if (fv !== fn) console.log(`        fuente de la referencia: «${fv ?? '—'}» → «${fn ?? '—'}»`)
  }

  // Puerta: ninguna página con hueco puede quedarse sin declarar su fuente. El motor la lee de
  // ahí; sin la frase, la página se renderiza solo con la plantilla y avisa.
  const rotas = cfg.pages.filter(p => {
    if (!p.image_input) return false
    const t = promptUi(uiPorId[p.prompt_node] || {})
    return !RX_FUENTE.exec(t)
  })
  if (rotas.length) {
    console.error(`\n*** ${rotas.map(r => r.name).join(', ')} tienen hueco de referencia pero ya no dicen de dónde sale ***`)
    process.exit(1)
  }

  if (!cambios.length) return console.log('nada que sincronizar: los prompts ya coinciden.')
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  for (const c of cambios) api[c.nodo].inputs.prompt = c.nuevo
  const { error } = await db().from('comfyui_workflows').update({ workflow_json: api }).eq('id', reg.id)
  if (error) { console.error(error.message); process.exit(1) }

  const { data: r } = await db().from('comfyui_workflows').select('workflow_json').eq('id', reg.id).single()
  const escrito = typeof r.workflow_json === 'string' ? JSON.parse(r.workflow_json) : r.workflow_json
  const ok = cambios.every(c => String(escrito[c.nodo]?.inputs?.prompt).trim() === c.nuevo.trim())
  console.log(`\n=== verificación ===\n  ${cambios.length} prompt(s) escritos · coinciden: ${ok}`)
  console.log('  fuentes de las 8 páginas con hueco:')
  for (const p of cfg.pages.filter(x => x.image_input)) {
    console.log(`    ${p.name.padEnd(26)} ${RX_FUENTE.exec(String(escrito[p.prompt_node]?.inputs?.prompt || ''))?.[1]?.trim()}`)
  }
})()
