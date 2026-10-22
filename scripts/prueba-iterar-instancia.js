// Prueba sin red de New Iteration sobre una hoja instanciada: tiene que volver a producirla con LOS MISMOS datos de
// instancia que la primera vez (instanciarHojas): id estable, fila (`fields`), anfitrión (`host`) y entorno padre.
//
// Base viva SOLO LEYENDO (toda escritura lanza; `fetch` solo GET/HEAD a Supabase y el express local) y dos casos:
//   1. Con el alcance y el manifiesto simulados con fila y padre para un ítem: lo que /iterate le pasa a
//      `generateDeck` como `instancia` es idéntico a lo que le pasa `instanciarHojas` para el mismo ítem.
//   2. Con los datos reales (hoy ningún proyecto trae fila ni padre): el grafo que /iterate despacharía es idéntico,
//      byte a byte, al del motor de referencia.
//
// Uso (desde forge-back):
//   node scripts/prueba-iterar-instancia.js --ref-engine <carpeta con src/ del motor publicado> [--project <id>]
'use strict'
const path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process')
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const RAIZ = path.resolve(__dirname, '..')
const sha = s => crypto.createHash('sha256').update(s).digest('hex')

// ─── Modo hijo ───────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--correr')) {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') })
  const E = arg('--engine'), PROY = arg('--project'), ASSET = arg('--asset'), MODO = arg('--modo')
  const SIM = arg('--simular') ? JSON.parse(arg('--simular')) : null   // { pagina, item, fields, host, parent }
  const bloqueos = []
  let capturado = null
  const hostSb = new URL(process.env.SUPABASE_URL).host
  const fetchReal = globalThis.fetch
  globalThis.fetch = async (url, opt = {}) => {
    const u = new URL(String(url)), m = String(opt.method || 'GET').toUpperCase()
    if (u.hostname === '127.0.0.1') return fetchReal(url, opt)
    if (u.host === hostSb && (m === 'GET' || m === 'HEAD')) return fetchReal(url, opt)
    if (/\/api\/prompt$/.test(u.pathname) && m === 'POST') { capturado = JSON.parse(opt.body).prompt; throw new Error('CAPTURADO') }
    bloqueos.push(`${m} ${u.host}${u.pathname}`)
    throw new Error(`RED BLOQUEADA: ${m} ${u.host}${u.pathname}`)
  }
  Math.random = () => 0.5

  const sup = require(path.join(E, 'src/services/supabase.service'))
  const ESCRIBE = new Set(['insert', 'update', 'upsert', 'delete'])
  const envolver = b => new Proxy(b, { get(t, k) {
    if (ESCRIBE.has(k)) throw new Error(`ESCRITURA BLOQUEADA: ${String(k)}`)
    // Al instanciar, la hoja del ítem ya existe y se saltaría: para el instanciador se esconde, como si fuera la primera vez.
    if (k === 'then' && MODO === 'instanciar' && SIM) return (ok, ko) => t.then(r => (Array.isArray(r?.data)
      ? { ...r, data: r.data.filter(x => x?.metadata?.instancia?.item !== SIM.item) } : r)).then(ok, ko)
    const v = t[k]
    if (typeof v !== 'function') return v
    return (...a) => { const o = v.apply(t, a); return o && typeof o.then === 'function' ? envolver(o) : o }
  } })
  const cliente = sup.db()
  sup.db = () => new Proxy(cliente, { get(t, k) { return k === 'from' ? tabla => envolver(t.from(tabla)) : k === 'rpc' ? () => { throw new Error('RPC BLOQUEADA') } : t[k] } })
  const prov = require(path.join(E, 'src/services/providers/comfyui.provider'))
  prov.uploadImageToComfyUI = async url => `up_${sha(String(url)).slice(0, 16)}.png`

  // Caso 1: el alcance y el manifiesto traen fila y padre para el ítem; se captura la `instancia` de generateDeck.
  const instancias = []
  if (SIM) {
    const clave = (p, i) => `${String(p).replace(/^\d+[_\s-]*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '')}::${String(i).trim().toLowerCase()}`
    const conDatos = porHoja => {
      for (const [hoja, items] of Object.entries(porHoja || {})) for (const i of items) {
        if (clave(hoja, i.nombre) !== clave(SIM.pagina, SIM.item)) continue
        Object.assign(i, { instancia_id: SIM.id, parent_environment_id: SIM.parent, fields: SIM.fields, host: SIM.host })
      }
      return porHoja
    }
    const alc = require(path.join(E, 'src/services/alcance-vs.service'))
    const alcReal = alc.itemsDelAlcance
    alc.itemsDelAlcance = async (...a) => { const r = await alcReal(...a); conDatos(r.porHoja); return r }
    const man = require(path.join(E, 'src/services/manifiesto-hojas.service'))
    const manReal = man.itemsDelManifiesto
    man.itemsDelManifiesto = async (...a) => { const r = await manReal(...a); conDatos(r.porHoja); return { ...r, hay: true } }
    const ig = require(path.join(E, 'src/services/image-gen.service'))
    ig.generateDeck = async o => { instancias.push(o.instancia || null); throw new Error('CAPTURADO') }
  }

  ;(async () => {
    let status = null, cuerpo = null
    if (MODO === 'instanciar') {
      const { instanciarHojas, planDeInstancias } = require(path.join(E, 'src/services/instanciar-hojas.service'))
      const { data: n } = await sup.db().from('forge_nodes').select('id').eq('node_key', '3.20').single()
      // La página tal como la manda el recuadro: la del plan, con solo este ítem.
      const sinNum = s => String(s).replace(/^\d+[_\s-]*/, '').toLowerCase()
      const plan = await planDeInstancias({ db: sup.db, project_id: PROY })
      const pag = plan.paginas.find(p => sinNum(p.pagina) === sinNum(SIM.pagina))
      const paginas = pag ? [{ ...pag, items: pag.items.filter(i => i.nombre === SIM.item) }] : []
      const r = await instanciarHojas({ db: sup.db, project_id: PROY, node_id: n.id, node_key: '3.20', output_key: 'prueba',
        image_gen_model: 'comfyui:V57_STUDIO_ArtStyleGuide_Template_25', paginas, limite: 0 }).catch(e => ({ error: e.message }))
      cuerpo = { fallos: (r.fallos || []).length, error: r.error || null }
    } else {
      const express = require('express')
      const app = express()
      app.use(express.json())
      app.use((req, _r, next) => { req.auth = { memberId: null, token: null }; next() })
      app.use('/api/projects/:id/canvas', require(path.join(E, 'src/routes/forge-canvas.routes')))
      app.use((err, _q, res, _n) => res.status(err.status || 500).json({ success: false, error: err.message }))
      await new Promise(ok => { const srv = app.listen(0, '127.0.0.1', async () => {
        const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/projects/${PROY}/canvas/assets/${ASSET}/iterate`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        status = r.status; cuerpo = await r.json().catch(() => null)
        srv.close(); ok()
      }) })
    }
    console.log(JSON.stringify({ wf: capturado, instancias, status, cuerpo, bloqueos }))
    process.exit(0)
  })().catch(e => { console.log(JSON.stringify({ error: e.message, bloqueos })); process.exit(0) })
  return
}

// ─── Modo principal ──────────────────────────────────────────────────────────────────────────────────────────────
const REF = arg('--ref-engine')
const PROY = arg('--project', '0bf15e1d-a570-45c5-add2-1a14b99b64eb')   // Professor_Wort_&_Sprat_world: manifiesto con ids
if (!REF) { console.error('uso: --ref-engine <carpeta con src/ del motor publicado> [--project <id>]'); process.exit(1) }
const correr = o => {
  const a = [__filename, '--correr', '--engine', o.engine || RAIZ, '--project', PROY, '--modo', o.modo || 'iterar']
  if (o.asset) a.push('--asset', o.asset)
  if (o.simular) a.push('--simular', JSON.stringify(o.simular))
  const s = execFileSync(process.execPath, a, { encoding: 'utf8', maxBuffer: 1 << 27, env: { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(process.cwd(), 'node_modules') } })
  return JSON.parse(s.split('\n').filter(l => l.startsWith('{')).pop())
}
let fallos = 0, bloqueos = 0
const linea = (ok, t) => { if (!ok) fallos++; console.log(`${ok ? '✔' : '✖'} ${t}`) }

;(async () => {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') })
  const { db } = require(path.join(RAIZ, 'src/services/supabase.service'))
  const { data: hojas } = await db().from('forge_assets').select('id, name, metadata').eq('project_id', PROY)
    .not('metadata->instancia', 'is', null).order('created_at', { ascending: false })
  const hoja = (hojas || []).find(h => /EnvironmentSheet/.test(h.metadata.instancia.pagina)) || hojas?.[0]
  if (!hoja) { console.error('el proyecto no tiene hojas instanciadas'); process.exit(1) }
  const { pagina, item } = hoja.metadata.instancia
  console.log(`Proyecto ${PROY} · hoja «${hoja.name}»\n`)

  // 1 · Con fila y padre: /iterate pasa la misma instancia que instanciarHojas.
  const SIM = { pagina, item, id: 'env_prueba', parent: 'ENV-PADRE-01', host: 'Sector anfitrión',
    fields: { 'LEVEL NAME': 'Prueba', 'GRID SIZE': '12 × 8', 'MOOD': 'flooded' } }
  const it = correr({ asset: hoja.id, simular: SIM }); bloqueos += it.bloqueos.length
  const ins = correr({ modo: 'instanciar', simular: SIM }); bloqueos += ins.bloqueos.length
  const a = it.instancias[0], b = ins.instancias[0]
  const orden = o => o && JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]))
  linea(!!a && !!b && orden(a) === orden(b), `1 /iterate pasa a generateDeck la misma instancia que instanciarHojas: ${orden(a)}`)
  linea(!!a && a.fields?.['LEVEL NAME'] === 'Prueba' && a.parent_environment_id === 'ENV-PADRE-01' && a.host === 'Sector anfitrión' && a.id === 'env_prueba',
    '1 lleva la fila, el anfitrión, el entorno padre y el id estable')

  // 2 · Con los datos reales: el grafo es el de hoy byte a byte.
  const nuevo = correr({ asset: hoja.id }); bloqueos += nuevo.bloqueos.length
  const hoy = correr({ engine: path.resolve(REF), asset: hoja.id }); bloqueos += hoy.bloqueos.length
  linea(!!nuevo.wf && JSON.stringify(nuevo.wf) === JSON.stringify(hoy.wf), `2 datos reales: el grafo de /iterate es idéntico al del motor publicado (${Object.keys(nuevo.wf || {}).length} nodos)`)

  console.log(`\n${fallos ? `✖ ${fallos} comprobación(es) fallaron` : '✔ todas las comprobaciones como deben'}`)
  console.log(`[red] intentos de salida bloqueados: ${bloqueos} (permitido: GET/HEAD al host de SUPABASE_URL)`)
  process.exit(fallos || bloqueos ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
