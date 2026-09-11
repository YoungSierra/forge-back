// Sube las láminas maestras de un deck a ComfyUI y apunta el workflow registrado a ellas.
//
// Los archivos de entrada de ComfyUI son POR CUENTA: los que sube el equipo de arte en su propia
// instancia no existen en la que usa Forge. Por eso un workflow exportado con sus plantillas
// asignadas igual falla acá — medido el 11-09 con el ASG de 25: las 25 `TEMPLATE_ASG_*.png` no
// estaban entre los 1.533 archivos de nuestra instancia, y ComfyUI rechaza el trabajo entero
// («the input file … doesn't exist»), no la página que falta.
//
// El marcador `REPLACE_WITH__TEMPLATE_<nombre>` dice qué lámina va en cada nodo. Este script sube
// el PNG que coincide con ese nombre y reemplaza el marcador por el archivo ya subido.
//
// Uso:  node scripts/subir-plantillas-deck.js <carpeta_png> <nombre_del_workflow> [--apply]
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const [, , CARPETA, WORKFLOW] = process.argv
const APLICAR = process.argv.includes('--apply')
if (!CARPETA || !WORKFLOW) {
  console.error('uso: node scripts/subir-plantillas-deck.js <carpeta_png> <nombre_del_workflow> [--apply]')
  process.exit(1)
}

const BASE = () => (process.env.COMFYUI_BASE_URL || '').replace(/\/$/, '')
const KEY = () => process.env.COMFYUI_API_KEY

// El nombre del archivo se conserva: así el workflow queda legible y el export que el equipo de
// arte haga desde su propia instancia sigue coincidiendo con lo que hay acá.
async function subir(ruta, nombre) {
  const form = new FormData()
  form.append('image', new Blob([fs.readFileSync(ruta)], { type: 'image/png' }), nombre)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const r = await fetch(`${BASE()}/api/upload/image`, { method: 'POST', headers: { 'X-API-Key': KEY() }, body: form })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`)
  const j = await r.json()
  return j.name || j.filename || nombre
}

// Se empata por TEMA, no por nombre literal: el marcador del workflow dice
// `TEMPLATE_ASG_ShapeLanguage.png` y el archivo que manda el equipo es
// `TEMPLATE_ASG_04_ShapeLanguage.png`. El número es la posición en el maestro y cambia con cada
// restructura —el ASG pasó de 34 a 25 en septiembre—, así que emparejar por él es volver a atar
// todo a una numeración que ya demostró que se mueve.
const norm = s => String(s)
  .toLowerCase()
  .replace(/\.[a-z]+$/, '')
  .replace(/(^|_)\d+(_|$)/g, '_')   // fuera el número de página, venga donde venga
  .replace(/[^a-z0-9]+/g, '')
const sinMarcador = s => String(s).replace(/^REPLACE_WITH__/i, '')

;(async () => {
  const pngs = fs.readdirSync(CARPETA).filter(f => /\.png$/i.test(f))
  console.log(`láminas en la carpeta: ${pngs.length}`)
  const porNombre = new Map(pngs.map(f => [norm(f), path.join(CARPETA, f)]))

  const { data: w } = await db().from('comfyui_workflows').select('id,name,workflow_json').eq('name', WORKFLOW).single()
  const wf = typeof w.workflow_json === 'string' ? JSON.parse(w.workflow_json) : w.workflow_json

  const pendientes = Object.entries(wf).filter(([, n]) =>
    /^LoadImage/i.test(n.class_type || '') && /^REPLACE_WITH__TEMPLATE/i.test(String(n.inputs?.image || '')))
  console.log(`nodos con el marcador de plantilla: ${pendientes.length}\n`)

  let hechos = 0, sinArchivo = []
  for (const [id, n] of pendientes) {
    const pedido = sinMarcador(n.inputs.image)
    const ruta = porNombre.get(norm(pedido))
    if (!ruta) { sinArchivo.push(pedido); console.log(`✗ ${id.padEnd(5)} ${pedido} — no está en la carpeta`); continue }
    if (!APLICAR) { console.log(`· ${id.padEnd(5)} ${pedido} → ${path.basename(ruta)} (${(fs.statSync(ruta).size / 1024).toFixed(0)} KB)`); hechos++; continue }
    try {
      const nombre = await subir(ruta, pedido)
      wf[id].inputs.image = nombre
      hechos++
      console.log(`✓ ${id.padEnd(5)} ${pedido} → subida como «${nombre}»`)
    } catch (e) { console.log(`✗ ${id.padEnd(5)} ${pedido} — ${e.message}`) }
  }

  console.log(`\n${hechos}/${pendientes.length} resueltas${sinArchivo.length ? ` · faltan en la carpeta: ${sinArchivo.join(', ')}` : ''}`)
  if (!APLICAR) return console.log('\n(simulación — usar --apply para subir y escribir)')
  if (sinArchivo.length) { console.error('*** no se escribe el workflow: faltan láminas ***'); process.exit(1) }

  const { error } = await db().from('comfyui_workflows').update({ workflow_json: wf }).eq('id', w.id)
  if (error) { console.error(error.message); process.exit(1) }

  // Verificación contra la instancia, no contra lo que acabamos de escribir.
  const info = await (await fetch(`${BASE()}/api/object_info`, { headers: { Authorization: `Bearer ${KEY()}` } })).json()
  const juego = new Set(info?.LoadImage?.input?.required?.image?.[0] || [])
  const { data: post } = await db().from('comfyui_workflows').select('workflow_json').eq('id', w.id).single()
  const wf2 = typeof post.workflow_json === 'string' ? JSON.parse(post.workflow_json) : post.workflow_json
  const cargas = Object.values(wf2).filter(n => /^LoadImage/i.test(n.class_type || ''))
  const marcador = cargas.filter(n => /^REPLACE_WITH__TEMPLATE/i.test(String(n.inputs?.image || ''))).length
  const existen = cargas.filter(n => juego.has(String(n.inputs?.image || ''))).length
  console.log(`\n=== verificación ===`)
  console.log(`  LoadImage: ${cargas.length} · con marcador de plantilla: ${marcador} · existen en la instancia: ${existen}`)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
