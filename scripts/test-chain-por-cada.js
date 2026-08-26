// ─── Prueba del paso «una vez por cada parte», SIN gastar ────────────────────
//
// ComfyUI y la base son de mentira: `avanzar` recibe `db` por parámetro y el proveedor se
// reemplaza antes de cargar el servicio. Valida en un segundo lo que la corrida real del
// Environment costaría 21 despachos en descubrir — y esos despachos no son reproducibles, así que
// un error encontrado ahí ya está pago.
//
// Cubre: que el tope recorte solo ese paso, que las 20 salidas se mapeen a sus partes, que los
// intermedios no se publiquen, y que cada modelo cuelgue de SU parte y no del origen.
//
// Uso:  node scripts/test-chain-por-cada.js
const path = require('path')

// ── ComfyUI simulado ─────────────────────────────────────────────────────────
const prov = require('../src/services/providers/comfyui.provider')
const despachos = []
prov.uploadImageToComfyUI = async url => `subida:${url.split('/').pop()}`
prov.submitWorkflow = async (wf, prompt, w, h, extras) => {
  despachos.push({ wf, entradas: { ...extras } })
  return `job${String(despachos.length).padStart(3, '0')}-xxxx`
}
prov.pollUntilDone = async () => {}
prov.downloadOutputsByNode = async (jobId, base) => {
  // El paso 1 emite 22 nodos (20 partes + 2 intermedios); el 3D emite el SaveGLB y el Preview3D.
  const esConcept = despachos[despachos.length - 1].wf.includes('ConceptArt_Environments')
  if (esConcept) {
    const out = { 269: { url: `${base}_269.png`, kind: 'image', size_bytes: 1 },
                  284: { url: `${base}_284.png`, kind: 'image', size_bytes: 1 } }
    for (let i = 1; i <= 20; i++) out[String(400 + i)] = { url: `${base}_${400 + i}.png`, kind: 'image', size_bytes: 1 }
    return out
  }
  return { 32: { url: `${base}_32.glb`, kind: 'model', size_bytes: 1 },
           46: { url: `${base}_46.glb`, kind: 'model', size_bytes: 1 } }
}

// El registro de workflows también se simula: son los mismos mapas que quedaron en la base.
const cfg = require('../src/services/config.service')
const partes = {}
for (let i = 1; i <= 20; i++) partes[String(400 + i)] = `parte_${String(i).padStart(2, '0')}`
cfg.getWorkflowByName = async name => ({
  name,
  inject_config: name.includes('ConceptArt_Environments')
    ? { seed: { node: '268', field: 'seed' }, extra: { image: { node: '272', type: 'image', field: 'image' } }, salidas: partes }
    : { seed: { node: '48', field: 'model_seed' }, extra: { image: { node: '45', type: 'image', field: 'image' } }, salidas: { 32: 'glb' } },
})
require('../src/services/execution-log.service').logExecution = () => {}

// ── Base de datos simulada ───────────────────────────────────────────────────
const ORIGEN = {
  id: 'origen-0000', project_id: 'proj', node_id: 'nodo', session_id: 'ses',
  name: 'Art Style Guide — 29_EnvironmentSheet', storage_url: 'https://r2/hoja.png', metadata: {},
}
const insertados = []
let seq = 0
const stub = tabla => {
  const q = {
    select: () => q, eq: () => q, in: () => q, not: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: null }),
    single: async () => {
      if (q._insert) {
        const fila = { id: `${tabla}-${++seq}`, ...q._insert }
        if (tabla === 'forge_assets') insertados.push(fila)
        return { data: fila, error: null }
      }
      if (tabla === 'forge_assets') return { data: ORIGEN, error: null }
      return { data: { id: 'ses-1' }, error: null }
    },
    insert: fila => { q._insert = fila; return q },
    then: undefined,
  }
  // Las lecturas sin `.single()` (hermanos del mismo job) devuelven vacío.
  q.then = (res) => res({ data: [], error: null })
  return q
}

const { avanzar } = require('../src/services/chain.service')

;(async () => {
  const r = await avanzar({
    db: () => ({ from: stub }), project_id: 'proj', asset_id: 'origen-0000',
    pasos: 2, member_id: null, limitePorCada: 1,
  })

  console.log('despachos:', despachos.length, '(esperado 2: el concept art + UNA parte)')
  for (const d of despachos) console.log('   ', d.wf.replace('V57_STUDIO_', '').padEnd(34), JSON.stringify(d.entradas))

  const porPaso = {}
  for (const a of insertados) {
    const p = a.metadata?.cadena?.paso
    porPaso[p] = (porPaso[p] || 0) + 1
  }
  console.log('\nactivos creados por paso:', JSON.stringify(porPaso), '(esperado concept_art:20, 3d:1)')

  const modelo = insertados.find(a => a.metadata?.cadena?.paso === '3d')
  const parte01 = insertados.find(a => a.metadata?.cadena?.rol === 'parte_01')
  console.log('\nel modelo se llama :', modelo?.name)
  console.log('cuelga de          :', modelo?.derived_from_id)
  console.log('parte_01 es        :', parte01?.id, '→', modelo?.derived_from_id === parte01?.id ? '✔ cuelga de SU parte' : '✘ cuelga de otra cosa')
  console.log('formato del modelo :', modelo?.format, modelo?.format === 'glb' ? '✔' : '✘')
  const dup = insertados.filter(a => a.metadata?.cadena?.rol === '46' || a.metadata?.cadena?.rol === '269')
  console.log('intermedios/Preview publicados:', dup.length, dup.length === 0 ? '✔ ninguno' : '✘')
})().catch(e => { console.error('✘', e.message); process.exit(1) })
