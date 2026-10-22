// Prueba sin red de Design Edits V2 (v2.9.61) — condición de despliegue de Pedro.
//
// Corre la RUTA REAL `POST /assets/:id/design-edit` (router montado en un express pelado, sin auth) contra la base
// viva SOLO LEYENDO y captura el grafo que despacharía a ComfyUI. No sale nada:
//   · toda escritura en la base (insert/update/upsert/delete/rpc) lanza;
//   · `fetch` solo deja pasar GET/HEAD al host de SUPABASE_URL y el propio express local; el POST a `/api/prompt`
//     se CAPTURA y se corta ahí; cualquier otra salida cuenta como intento bloqueado;
//   · la subida a ComfyUI es un doble determinista (nombre = sha de la URL) y la semilla, fija.
//
// La fila V2 (`V57_STUDIO_Moodboard_Iteration_V2`, la del paquete) se AÑADE a lo que devuelve la base, al lado de la
// V1 viva, con el `created_at` que se le pida: anterior al proyecto = proyecto nuevo; posterior = proyecto viejo.
//
// Casos:
//   A  V2, página fija sin referencia            → prompt = prompt_sin_referencia.txt byte a byte, sin image_2 ni nodo 30
//   B  V2, página con referencia + «What it shows» → image_2 = la referencia, alcance DESIGN; resto del grafo = registro
//   C  V2, misma + «How it looks»                 → alcance LOOK
//   D  V2, con referencia pero apagada en la corrida → = A
//   E  V2, con referencia y sin chip              → 400 FALTA_CHIP y NADA despachado
//   F  V2, instancia de hoja: referencia de OTRA instancia → = A; la SUYA → image_2 = la suya
//   G  V2, referencia recién subida (modo nueva)  → image_2 = esa
//   R  enrutamiento (`workflowDeDesignEdit`), con referencias en el registro y comparado con el motor de hoy byte a byte:
//      R1 imagen que no es del ASG, proyecto nuevo → V1 · R2 página del ASG, proyecto viejo → V1 ·
//      R3 sin la fila V2 registrada → V1; y GET /referencia: `aplica` y `workflow` en cada caso
//   I  V1 vivo (3 nodos): motor nuevo = motor de hoy, byte a byte, con y sin referencias en el registro
//   J  New Art Style vivo: motor nuevo = motor de hoy
//
// Uso (desde forge-back):
//   node scripts/prueba-design-edits-v2.js --delta <PKG/delta> --ref-engine <carpeta con src/ del motor de hoy> [--project <id>]
// (el motor de hoy se saca con `git archive b8f2090 src | tar -x -C <carpeta>`)
'use strict'
const path = require('path'), fs = require('fs'), crypto = require('crypto'), { execFileSync } = require('child_process')

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const RAIZ = path.resolve(__dirname, '..')
const WF = 'V57_STUDIO_Moodboard_Iteration', WF2 = 'V57_STUDIO_Moodboard_Iteration_V2'

// ─── Modo hijo: un Design Edit con UN motor; devuelve el grafo capturado o la respuesta ─────────────────────────
if (process.argv.includes('--correr')) {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') })
  const E = arg('--engine'), REG = arg('--registro'), PROY = arg('--project'), ASSET = arg('--asset')
  const CUERPO = JSON.parse(arg('--cuerpo')), REFS = JSON.parse(arg('--refs', '[]')), RUTA = arg('--ruta', 'design-edit')
  const METODO = arg('--metodo', 'POST'), CORTE = arg('--corte', '2000-01-01T00:00:00+00:00')
  // `--simular`: ComfyUI «contesta» (prompt_id fijo y n imágenes falsas) y las escrituras en la base NO se hacen: se
  // anotan y devuelven filas inventadas. Es lo que deja probar qué escribe el motor después de generar, sin red.
  const SIMULAR = process.argv.includes('--simular'), VERS = JSON.parse(arg('--versiones', '[]'))
  const escrituras = []
  const OBJECT_INFO = fs.readFileSync(path.join(__dirname, 'fixtures', 'object_info_design_edits.json'), 'utf8')
  const bloqueos = []
  let capturado = null
  const hostSb = new URL(process.env.SUPABASE_URL).host
  const fetchReal = globalThis.fetch
  globalThis.fetch = async (url, opt = {}) => {
    const u = new URL(String(url)), m = String(opt.method || 'GET').toUpperCase()
    if (u.hostname === '127.0.0.1') return fetchReal(url, opt)
    if (u.host === hostSb && (m === 'GET' || m === 'HEAD')) return fetchReal(url, opt)
    // El catálogo de opciones sale de object_info: se sirve la copia guardada del 22-10 (scripts/fixtures).
    if (/\/api\/object_info$/.test(u.pathname) && m === 'GET') return new Response(OBJECT_INFO, { status: 200, headers: { 'content-type': 'application/json' } })
    if (/\/api\/prompt$/.test(u.pathname) && m === 'POST') {
      capturado = JSON.parse(opt.body).prompt
      if (SIMULAR) return new Response(JSON.stringify({ prompt_id: 'job-prueba' }), { status: 200 })
      throw new Error('CAPTURADO')
    }
    bloqueos.push(`${m} ${u.host}${u.pathname}`)
    throw new Error(`RED BLOQUEADA: ${m} ${u.host}${u.pathname}`)
  }
  Math.random = () => 0.5   // la semilla: el motor la sortea en cada edición

  const sup = require(path.join(E, 'src/services/supabase.service'))
  const comoJsonb = v => Array.isArray(v) ? v.map(comoJsonb) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))).map(k => [k, comoJsonb(v[k])]))
    : v
  const leer = f => comoJsonb(JSON.parse(fs.readFileSync(path.join(REG, f), 'utf8')))
  const filaV2 = REG ? {
    id: '00000000-0000-0000-0000-0000000000v2', name: WF2, description: 'prueba', is_active: true,
    workflow_json: leer('workflow_json_design_edits_v2.json'), inject_config: leer('inject_config_design_edits_v2.json'),
    created_at: CORTE, updated_at: CORTE, refinement_capable: false, mask_capable: false,
  } : null
  const ESCRIBE = new Set(['insert', 'update', 'upsert', 'delete'])
  const envolver = (b, tabla, llamadas = []) => new Proxy(b, {
    get(t, k) {
      if (ESCRIBE.has(k)) {
        if (SIMULAR) return (...a) => escrituraAnotada(tabla, k, a)
        throw new Error(`ESCRITURA BLOQUEADA: ${String(k)} en ${tabla}`)
      }
      if (k === 'then') return (ok, ko) => t.then(r => {
        if (tabla === 'comfyui_workflows' && filaV2 && !r?.error) {
          const nombre = llamadas.find(c => c[0] === 'eq' && c[1][0] === 'name')?.[1][1]
          const uno = llamadas.some(c => c[0] === 'single' || c[0] === 'maybeSingle')
          if (nombre === WF2) r = { ...r, data: uno ? filaV2 : [filaV2] }
          else if (!nombre && Array.isArray(r.data)) r = { ...r, data: [...r.data, filaV2] }
        }
        if (tabla === 'forge_assets' && REFS.length && Array.isArray(r?.data)
            && llamadas.some(c => c[0] === 'not' && c[1][0] === 'metadata->contexto')) r.data = [...REFS, ...r.data]
        // Versiones inventadas (las candidatas de un lote), filtradas por los `eq` de la consulta.
        if (tabla === 'forge_asset_versions' && VERS.length && !llamadas.some(c => ESCRIBE.has(c[0]))) {
          const eqs = llamadas.filter(c => c[0] === 'eq').map(c => c[1])
          const suyas = VERS.filter(v => eqs.every(([col, val]) => v[col] === val))
          const uno = llamadas.some(c => c[0] === 'single' || c[0] === 'maybeSingle')
          if (uno) { if (suyas.length) r = { data: suyas[0], error: null } }
          else r = { ...r, data: [...(Array.isArray(r.data) ? r.data : []), ...suyas] }
        }
        return r
      }).then(ok, ko)
      const v = t[k]
      if (typeof v !== 'function') return v
      return (...a) => { const o = v.apply(t, a); return o && typeof o.then === 'function' ? envolver(o, tabla, [...llamadas, [k, a]]) : o }
    },
  })
  const cliente = sup.db()
  const falso = new Proxy(cliente, { get(t, k) {
    if (k === 'from') return tabla => envolver(t.from(tabla), tabla)
    if (k === 'rpc') throw new Error('RPC BLOQUEADA')
    return t[k]
  } })
  sup.db = () => falso
  const prov = require(path.join(E, 'src/services/providers/comfyui.provider'))
  prov.uploadImageToComfyUI = async url => `up_${sha(String(url)).slice(0, 16)}.png`
  if (SIMULAR) {
    // Lo que ComfyUI habría devuelto: tantas imágenes como pidió el `n` del grafo despachado.
    const nDe = () => Number(Object.values(capturado || {}).find(x => x?.inputs?.n != null)?.inputs?.n) || 1
    prov.pollUntilDone = async () => ({})
    prov.downloadOutput = async () => ({ url: 'https://example.invalid/salida_1.png' })
    prov.downloadImages = async () => Array.from({ length: nDe() }, (_, i) => ({ url: `https://example.invalid/salida_${i + 1}.png` }))
  }
  // Una escritura anotada: encadenable como la de supabase-js, y devuelve filas inventadas con id.
  function escrituraAnotada(tabla, op, args) {
    const reg = { tabla, op, valor: JSON.parse(JSON.stringify(args[0] ?? null)), filtros: [] }
    escrituras.push(reg)
    let uno = false
    const b = new Proxy({}, { get(_, k) {
      if (k === 'then') return (ok, ko) => {
        const filas = op === 'insert' ? [].concat(reg.valor).map((f, i) => ({ id: `00000000-0000-0000-0000-${String(escrituras.length).padStart(6, '0')}${String(i).padStart(6, '0')}`, ...f })) : []
        return Promise.resolve({ data: uno ? (filas[0] ?? null) : filas, error: null }).then(ok, ko)
      }
      if (k === 'single' || k === 'maybeSingle') return () => { uno = true; return b }
      if (['eq', 'neq', 'in', 'is', 'match'].includes(k)) return (...a) => { reg.filtros.push([k, ...a]); return b }
      return () => b
    } })
    return b
  }

  const express = require('express')
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use((req, _res, next) => { req.auth = { memberId: null, token: null }; next() })
  app.use('/api/projects/:id/canvas', require(path.join(E, 'src/routes/forge-canvas.routes')))
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, error: err.message, code: err.code }))
  const srv = app.listen(0, '127.0.0.1', async () => {
    let status = null, cuerpo = null
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/projects/${PROY}/canvas/assets/${ASSET}/${RUTA}`,
        METODO === 'GET' ? {} : { method: METODO, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CUERPO) })
      status = r.status; cuerpo = await r.json()
    } catch (e) { cuerpo = { error: e.message } }
    console.log(JSON.stringify({ wf: capturado, status, cuerpo, bloqueos, escrituras }))
    srv.close(); process.exit(0)
  })
  return
}

// ─── Modo principal ────────────────────────────────────────────────────────────────────────────────────────────
const DELTA = arg('--delta'), REF_ENGINE = arg('--ref-engine')
const PROY = arg('--project', 'f84d5601-dcff-4efb-8784-510a8e2f2fb2')   // Smack The Coral Wish: maestro de 34, sin Add Context
if (!DELTA || !REF_ENGINE) { console.error('uso: --delta <PKG/delta> --ref-engine <carpeta con src/ del motor de hoy> [--project <id>]'); process.exit(1) }
const REG = path.join(path.resolve(DELTA), 'registro')
const SIN_REF = fs.readFileSync(path.join(REG, 'prompt_sin_referencia.txt'), 'utf8')
const V2 = JSON.parse(fs.readFileSync(path.join(REG, 'workflow_json_design_edits_v2.json'), 'utf8'))
const IC = JSON.parse(fs.readFileSync(path.join(REG, 'inject_config_design_edits_v2.json'), 'utf8'))

const correr = o => {
  const a = [__filename, '--correr', '--engine', o.engine || RAIZ, '--project', PROY, '--asset', o.asset,
    '--cuerpo', JSON.stringify(o.cuerpo), '--refs', JSON.stringify(o.refs || [])]
  if (o.v2 !== false) a.push('--registro', REG)
  if (o.ruta) a.push('--ruta', o.ruta)
  if (o.metodo) a.push('--metodo', o.metodo)
  if (o.corte) a.push('--corte', o.corte)
  if (o.simular) a.push('--simular')
  if (o.versiones) a.push('--versiones', JSON.stringify(o.versiones))
  const salida = execFileSync(process.execPath, a, { encoding: 'utf8', maxBuffer: 1 << 26, cwd: process.cwd(),
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(process.cwd(), 'node_modules') } })
  return JSON.parse(salida.split('\n').filter(l => l.startsWith('{"wf"')).pop())
}

let fallos = 0, bloqueos = 0
const linea = (ok, t) => { if (!ok) fallos++; console.log(`${ok ? '✔' : '✖'} ${t}`) }
const subida = url => `up_${sha(String(url)).slice(0, 16)}.png`

;(async () => {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') })
  const { db } = require(path.join(RAIZ, 'src/services/supabase.service'))
  // Los activos de la prueba: una página fija, dos instancias de la misma hoja y una pieza que no es página.
  const { data: assets } = await db().from('forge_assets').select('id, name, storage_url, metadata')
    .eq('project_id', PROY).like('name', 'Art Style Guide%').not('storage_url', 'is', null)
    .order('created_at', { ascending: false })
  const tramos = a => a.name.split(/\s+[—–]\s+/)
  const fija = assets.find(a => !a.metadata?.instancia && tramos(a).length === 2 && /^\d+_KeyArt$/.test(tramos(a)[1]))
  const porHoja = {}
  for (const a of assets.filter(a => a.metadata?.instancia)) (porHoja[a.metadata.instancia.pagina] ||= []).push(a)
  const [hoja, insts] = Object.entries(porHoja).find(([, xs]) => xs.length >= 2) || []
  const { data: otras } = await db().from('forge_assets').select('id, name, storage_url, metadata')
    .eq('project_id', PROY).not('storage_url', 'is', null).not('name', 'like', 'Art Style Guide%').like('format', '%png%').limit(1)
  const noPagina = (otras || [])[0]
  if (!fija || !insts || !noPagina) { console.error('faltan activos de prueba en el proyecto', { fija: !!fija, insts: !!insts, noPagina: !!noPagina }); process.exit(1) }
  const [i1, i2] = insts
  console.log(`Proyecto ${PROY}\n  página fija «${fija.name}»\n  instancias «${i1.name}» y «${i2.name}»\n  no-página «${noPagina.name}»\n`)

  const PEDIDO = 'Make the hero wear a red scarf'
  const refFalsa = (id, pagina, instancia = null, extra = {}) => ({
    id, name: `ref ${id}`, storage_url: `https://example.invalid/${id}.png`, status: 'approved', created_at: '2026-10-22T00:00:00Z',
    metadata: { contexto: { rol: 'referencia_aprobada', estado: 'approved', primary: true, pagina_destino: pagina,
      canal: 'add_context', inbound: [{ en: '2026-10-22T00:00:00Z', via: 'add_context' }], ...(instancia ? { instancia } : {}), ...extra } },
  })
  const pagFija = tramos(fija)[1]
  const REFS = [
    refFalsa('ref-fija', pagFija),
    refFalsa('ref-i1', hoja, { pagina: hoja, item: i1.metadata.instancia.item }),
  ]
  const contar = r => { bloqueos += r.bloqueos.length; return r }
  const n25 = IC.prompt.node, n30 = IC.image_inputs[0].node, n29 = IC.image.node
  const esperadoSin = SIN_REF.split('{{USER_PROMPT}}').join(PEDIDO)
  const sinRefOk = (r, quien) => {
    const g = r.wf?.[n25]?.inputs
    linea(!!g && g.prompt === esperadoSin, `${quien}: prompt = prompt_sin_referencia.txt byte a byte (${Buffer.byteLength(g?.prompt || '')} B)`)
    linea(!!g && !('model.images.image_2' in g) && !r.wf[n30], `${quien}: sin image_2 y sin nodo ${n30}`)
    const resto = { ...g }; delete resto.prompt; delete resto.seed
    const reg = { ...V2[n25].inputs }; delete reg.prompt; delete reg.seed; delete reg['model.images.image_2']
    linea(JSON.stringify(Object.keys(resto).sort().map(k => [k, resto[k]])) === JSON.stringify(Object.keys(reg).sort().map(k => [k, reg[k]])),
      `${quien}: el resto del nodo ${n25} = registro (sin mask, gpt-image-2.5-sunburst, 1536×1024)`)
  }
  const conRefOk = (r, quien, url, scope) => {
    const g = r.wf?.[n25]?.inputs
    const esperado = V2[n25].inputs.prompt.split(IC.reference_scope.token).join(IC.reference_scope.values[scope].text).split('{{USER_PROMPT}}').join(PEDIDO)
    linea(!!g && g.prompt === esperado, `${quien}: prompt = plantilla §2.4 con alcance ${scope.toUpperCase()}`)
    linea(!!g && JSON.stringify(g['model.images.image_2']) === JSON.stringify([n30, 0]) && r.wf[n30]?.inputs?.image === subida(url),
      `${quien}: image_2 = nodo ${n30} = la referencia (${url.split('/').pop()})`)
    linea(r.wf?.[n29]?.inputs?.image === subida(fija.id === r._asset ? fija.storage_url : r._url), `${quien}: image_1 = la página a editar`)
  }
  const de = (asset, cuerpo, refs = [], extra = {}) => { const r = contar(correr({ asset: asset.id, cuerpo: { prompt: PEDIDO, ...cuerpo }, refs, ...extra })); r._asset = asset.id; r._url = asset.storage_url; return r }

  sinRefOk(de(fija, { cambio: 'sujeto' }), 'A  página fija sin referencia')
  conRefOk(de(fija, { cambio: 'sujeto' }, REFS), 'B  página fija + What it shows', 'https://example.invalid/ref-fija.png', 'design')
  conRefOk(de(fija, { cambio: 'tratamiento' }, REFS), 'C  página fija + How it looks', 'https://example.invalid/ref-fija.png', 'look')
  sinRefOk(de(fija, { cambio: 'sujeto', referencia: { modo: 'ninguna' } }, REFS), 'D  referencia apagada en la corrida')
  {
    const r = de(fija, { cambio: null }, REFS)
    linea(r.status === 400 && r.cuerpo?.code === 'FALTA_CHIP' && !r.wf, `E  con referencia y sin chip: ${r.status} ${r.cuerpo?.code} y nada despachado`)
  }
  sinRefOk(de(i2, { cambio: 'sujeto' }, REFS), `F1 instancia «${i2.metadata.instancia.item}» con la referencia de OTRA`)
  conRefOk(de(i1, { cambio: 'sujeto' }, REFS), `F2 instancia «${i1.metadata.instancia.item}» con la SUYA`, 'https://example.invalid/ref-i1.png', 'design')
  conRefOk(de(fija, { cambio: 'sujeto', referencia: { modo: 'nueva', url: 'https://example.invalid/nueva.png', nombre: 'nueva.png' } }, REFS),
    'G  referencia recién subida', 'https://example.invalid/nueva.png', 'design')
  {
    // Una referencia retirada no carga: la página vuelve a ir sin referencia.
    const ret = [refFalsa('ref-fija', pagFija, null, { retirada: true })]
    sinRefOk(de(fija, { cambio: 'sujeto' }, ret), 'G2 referencia quitada del registro')
  }
  // R · el enrutamiento: fuera de la V2, el grafo es el de hoy byte a byte (aun con referencias en el registro).
  const VIEJO = '2100-01-01T00:00:00+00:00'
  const igualAHoy = (a, extra, quien) => {
    const cuerpo = { prompt: PEDIDO, cambio: 'sujeto' }
    const nuevo = contar(correr({ asset: a.id, cuerpo, refs: REFS, ...extra }))
    const hoy = contar(correr({ engine: path.resolve(REF_ENGINE), asset: a.id, cuerpo, refs: REFS, ...extra }))
    linea(!!nuevo.wf && JSON.stringify(nuevo.wf) === JSON.stringify(hoy.wf) && nuevo.wf[n25]?.class_type === 'OpenAIGPTImage1',
      `${quien}: va la V1, grafo idéntico al de hoy byte a byte`)
  }
  igualAHoy(noPagina, {}, `R1 «${noPagina.name.slice(0, 45)}» (no es del ASG), proyecto nuevo`)
  igualAHoy(fija, { corte: VIEJO }, 'R2 página del ASG, proyecto viejo')
  igualAHoy(i1, { corte: VIEJO }, 'R2 instancia de hoja, proyecto viejo')
  igualAHoy(fija, { v2: false }, 'R3 página del ASG, sin la fila V2 registrada')
  for (const [quien, a, extra, aplica, wf] of [
    ['página del ASG, proyecto nuevo', fija, {}, true, 'V57_STUDIO_Moodboard_Iteration_V2'],
    ['instancia, proyecto nuevo', i1, {}, true, 'V57_STUDIO_Moodboard_Iteration_V2'],
    ['página del ASG, proyecto viejo', fija, { corte: VIEJO }, false, 'V57_STUDIO_Moodboard_Iteration'],
    ['no es del ASG', noPagina, {}, false, 'V57_STUDIO_Moodboard_Iteration'],
    ['sin la fila V2', fija, { v2: false }, false, 'V57_STUDIO_Moodboard_Iteration'],
  ]) {
    const r = contar(correr({ asset: a.id, cuerpo: {}, refs: REFS, ruta: 'referencia', metodo: 'GET', ...extra }))
    const vig = r.cuerpo?.vigente?.id || null
    linea(r.status === 200 && r.cuerpo.aplica === aplica && r.cuerpo.workflow === wf && (aplica ? !!vig : !vig),
      `R  GET /referencia, ${quien}: aplica ${r.cuerpo?.aplica} · ${r.cuerpo?.workflow}${vig ? ` · vigente ${vig}` : ''}`)
  }

  // N · Generation options de la V2 y n > 1 (rev. 4 de Art Direction).
  {
    const ops = { n: 3, seed: 123, 'model.background': 'opaque' }
    let r = de(fija, { cambio: 'sujeto', opciones: ops })
    let g = r.wf?.[n25]?.inputs
    linea(!!g && g.n === 3 && g.seed === 123 && g['model.background'] === 'opaque',
      `N1 opciones n=3, seed=123, background=opaque llegan al nodo ${n25} (la semilla elegida no se sortea)`)
    r = de(fija, { cambio: 'sujeto', opciones: { n: 9 } })
    linea(r.status === 400 && !r.wf, `N2 n=9 (fuera de 1–8): ${r.status} «${r.cuerpo?.error}» y nada despachado`)
    r = contar(correr({ asset: fija.id, cuerpo: { prompt: PEDIDO, cambio: 'sujeto', opciones: { n: 3 } }, refs: REFS, v2: false }))
    linea(r.status === 400 && !r.wf, 'N3 en la V1 (proyecto viejo / sin V2) n no es una opción: 400 y nada despachado')

    // N4 · simulado: con n=3 la página NO cambia; quedan 3 candidatas fuera de la vigente.
    r = contar(correr({ asset: fija.id, cuerpo: { prompt: PEDIDO, cambio: 'sujeto', opciones: { n: 3 } }, refs: REFS, simular: true }))
    const ins = r.escrituras.filter(e => e.tabla === 'forge_asset_versions' && e.op === 'insert').flatMap(e => [].concat(e.valor))
    const cands = ins.filter(v => v.metadata?.candidato)
    linea(r.status === 200 && r.cuerpo?.candidatos?.length === 3 && r.cuerpo.version === null,
      `N4 n=3: responde 3 candidatas y ninguna versión vigente (${r.status})`)
    linea(cands.length === 3 && cands.every(v => v.is_current === false && v.metadata.candidato.lote === 'job-prueba' && v.metadata.candidato.de === 3)
      && cands.map(v => v.metadata.candidato.indice).join() === '1,2,3' && cands.every(v => v.metadata.reference_scope === 'design'),
      'N4 las 3 versiones: no vigentes, mismo lote, índices 1-3, con la referencia y el alcance')
    linea(!r.escrituras.some(e => e.tabla === 'forge_assets' && e.op === 'update') && !r.escrituras.some(e => e.tabla === 'forge_asset_versions' && e.op === 'update' && e.valor?.is_current === false),
      'N4 la página no se toca: ni el asset ni la vigente cambian hasta elegir')

    // N5 · simulado: con n=1 todo sigue como siempre (reemplaza la página).
    r = contar(correr({ asset: fija.id, cuerpo: { prompt: PEDIDO, cambio: 'sujeto' }, refs: REFS, simular: true }))
    const ins1 = r.escrituras.filter(e => e.tabla === 'forge_asset_versions' && e.op === 'insert').flatMap(e => [].concat(e.valor)).filter(v => v.metadata?.job)
    linea(r.status === 200 && r.cuerpo?.version && !r.cuerpo.candidatos && ins1.length === 1 && ins1[0].is_current === true && !ins1[0].metadata.candidato
      && r.escrituras.some(e => e.tabla === 'forge_assets' && e.op === 'update' && e.valor?.storage_url === 'https://example.invalid/salida_1.png'),
      'N5 n=1: una versión vigente y la página la muestra, como hoy')

    // N6 · elegir la 2 de un lote de 3.
    const lote = [1, 2, 3].map(i => ({
      id: `00000000-0000-0000-0000-00000000c00${i}`, asset_id: fija.id, version_number: 900 + i, is_current: false,
      storage_url: `https://example.invalid/cand_${i}.png`,
      metadata: { job: 'job-x', design_edit: PEDIDO, design_edit_cambio: 'sujeto', editor: 'design', candidato: { lote: 'job-x', indice: i, de: 3 } },
    }))
    r = contar(correr({ asset: fija.id, cuerpo: { version_id: lote[1].id }, ruta: 'design-edit/elegir', simular: true, versiones: lote }))
    const metas = r.escrituras.filter(e => e.tabla === 'forge_asset_versions' && e.op === 'update' && e.valor?.metadata?.candidato)
    const de2 = id => metas.find(e => e.filtros.some(f => f[0] === 'eq' && f[1] === 'id' && f[2] === id))?.valor.metadata.candidato
    linea(r.status === 200 && r.cuerpo?.version?.id === lote[1].id, `N6 elegir la 2: ${r.status}, vigente = v${r.cuerpo?.version?.version_number}`)
    linea(de2(lote[1].id)?.elegido === true && de2(lote[0].id)?.no_elegido === true && de2(lote[2].id)?.no_elegido === true,
      'N6 la 2 queda «elegida» y la 1 y la 3 «no elegidas» (siguen en el historial)')
    linea(r.escrituras.some(e => e.tabla === 'forge_asset_versions' && e.valor?.is_current === true && e.filtros.some(f => f[1] === 'id' && f[2] === lote[1].id))
      && r.escrituras.some(e => e.tabla === 'forge_assets' && e.op === 'update' && e.valor?.storage_url === lote[1].storage_url),
      'N6 la 2 pasa a ser la vigente y la página la muestra')
    r = contar(correr({ asset: fija.id, cuerpo: { version_id: '00000000-0000-0000-0000-000000000bad' }, ruta: 'design-edit/elegir', simular: true, versiones: lote }))
    linea(r.status === 400 && !r.escrituras.length, 'N7 elegir algo que no es candidata: 400 y nada escrito')
  }

  // I · el registro V1 vivo: el motor nuevo despacha exactamente lo mismo que el de hoy.
  for (const [quien, refs] of [['sin referencias', []], ['con referencias en el registro', REFS]]) {
    for (const a of [fija, i1, noPagina]) {
      const nuevo = contar(correr({ asset: a.id, cuerpo: { prompt: PEDIDO, cambio: 'sujeto' }, refs, v2: false }))
      const hoy = contar(correr({ engine: path.resolve(REF_ENGINE), asset: a.id, cuerpo: { prompt: PEDIDO, cambio: 'sujeto' }, refs, v2: false }))
      linea(!!nuevo.wf && JSON.stringify(nuevo.wf) === JSON.stringify(hoy.wf), `I  V1 vivo, ${quien}, «${a.name.slice(0, 45)}»: grafo idéntico al de hoy byte a byte`)
    }
  }
  // J · New Art Style (no tiene ranura de referencia): idéntico al de hoy.
  {
    const nuevo = contar(correr({ asset: fija.id, cuerpo: { prompt: 'cel-shaded' }, refs: REFS, ruta: 'new-art-style' }))
    const hoy = contar(correr({ engine: path.resolve(REF_ENGINE), asset: fija.id, cuerpo: { prompt: 'cel-shaded' }, refs: REFS, ruta: 'new-art-style' }))
    linea(!!nuevo.wf && JSON.stringify(nuevo.wf) === JSON.stringify(hoy.wf), 'J  New Art Style: grafo idéntico al de hoy byte a byte')
  }

  console.log(`\n${fallos ? `✖ ${fallos} comprobación(es) fallaron` : '✔ todas las comprobaciones como deben'}`)
  console.log(`[red] intentos de salida bloqueados: ${bloqueos} (permitido: GET/HEAD al host de SUPABASE_URL)`)
  process.exit(fallos || bloqueos ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
