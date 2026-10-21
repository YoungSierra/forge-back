// Prueba sin red del USERREF del maestro de 34 (v2.9.60) — condición de despliegue de Pedro.
//
// Corre `generateDeck` REAL de dos motores contra la base viva SOLO LEYENDO y compara, byte a byte, el grafo que
// cada uno despacharía a ComfyUI (después de la poda). No sale nada:
//   · toda escritura en la base (insert/update/upsert/delete/rpc) lanza;
//   · `fetch` solo deja pasar GET/HEAD al host de SUPABASE_URL; el POST a `/api/prompt` se CAPTURA y se corta ahí,
//     y cualquier otra salida cuenta como intento bloqueado;
//   · la subida a ComfyUI es un doble determinista (nombre = sha de la URL) o, en el modo «sin REF», falla siempre.
//
// Casos (en cada uno, motor de referencia = el de hoy con el `_31` vivo de 136 nodos):
//   1-2  motor nuevo + `_31` vivo de 136, con REF / sin REF          → idéntico (compatibilidad hacia atrás)
//   3-4  motor nuevo + `_31` de 170 (USERREF), con REF / sin REF      → idéntico (página sin USERREF = hoy)
//   5    hoja instanciada (23_CharacterSheet · una instancia) con 170, sin USERREF → idéntico
//   6    con USERREF en el registro compartido: la página y la instancia que lo tienen llevan image_3 y la cláusula,
//        las demás (incluida OTRA instancia de la misma hoja) salen idénticas a hoy  → `referenciaDeInstancia`
//
// Uso (desde forge-back):
//   node scripts/prueba-userref-34.js --delta <PKG/delta> --ref-engine <carpeta con src/ del motor de hoy> [--project <id>]
// (lee `.env` y `node_modules` del directorio actual; el motor de hoy se saca con `git archive ed6999d src | tar -x -C <carpeta>`)
'use strict'
const path = require('path'), fs = require('fs'), crypto = require('crypto'), { execFileSync } = require('child_process')

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const RAIZ = path.resolve(__dirname, '..')

// ─── Modo hijo: una corrida de UN motor, devuelve el grafo capturado ───────────────────────────────────────────
if (process.argv.includes('--correr')) {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') })
  const E = arg('--engine'), REG = arg('--registro'), SIN_REF = process.argv.includes('--sin-ref')
  const PROY = arg('--project'), SOLO = arg('--solo'), INST = arg('--instancia'), REFS = arg('--refs')
  const bloqueos = []
  const hostSb = new URL(process.env.SUPABASE_URL).host
  const fetchReal = globalThis.fetch
  globalThis.fetch = async (url, opt = {}) => {
    const u = new URL(String(url)), m = String(opt.method || 'GET').toUpperCase()
    if (u.host === hostSb && (m === 'GET' || m === 'HEAD')) return fetchReal(url, opt)
    if (/\/api\/prompt$/.test(u.pathname) && m === 'POST') {
      const e = new Error('CAPTURADO'); e.capturado = JSON.parse(opt.body).prompt; throw e
    }
    bloqueos.push(`${m} ${u.host}${u.pathname}`)
    throw new Error(`RED BLOQUEADA: ${m} ${u.host}${u.pathname}`)
  }

  const sup = require(path.join(E, 'src/services/supabase.service'))
  const dbReal = sup.db
  // Como lo devolverá la base: la columna es jsonb, y jsonb reordena las claves (más cortas primero, luego por
  // bytes). El archivo del paquete trae el orden del autor; sin esto la prueba compararía un orden que nunca se despacha.
  const comoJsonb = v => Array.isArray(v) ? v.map(comoJsonb) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))).map(k => [k, comoJsonb(v[k])]))
    : v
  const leer = f => comoJsonb(JSON.parse(fs.readFileSync(path.join(REG, f), 'utf8')))
  const registro = REG ? { workflow_json: leer('workflow_json_userref.json'), inject_config: leer('inject_config_userref.json') } : null
  const refsFalsas = REFS ? JSON.parse(REFS) : []
  const ESCRIBE = new Set(['insert', 'update', 'upsert', 'delete'])
  const envolver = (b, tabla, llamadas = []) => new Proxy(b, {
    get(t, k) {
      if (ESCRIBE.has(k)) throw new Error(`ESCRITURA BLOQUEADA: ${String(k)} en ${tabla}`)
      if (k === 'then') return (ok, ko) => t.then(r => {
        if (tabla === 'comfyui_workflows' && registro && r?.data) {
          const p = f => (f?.name === 'V57_STUDIO_ArtStyleGuide_Template_31' && 'workflow_json' in f ? Object.assign(f, registro) : f)
          if (Array.isArray(r.data)) r.data.forEach(p); else p(r.data)
        }
        if (tabla === 'forge_assets' && refsFalsas.length && Array.isArray(r?.data)
            && llamadas.some(c => c[0] === 'not' && c[1][0] === 'metadata->contexto')) r.data = [...refsFalsas, ...r.data]
        return r
      }).then(ok, ko)
      const v = t[k]
      if (typeof v !== 'function') return v
      return (...a) => { const o = v.apply(t, a); return o && typeof o.then === 'function' ? envolver(o, tabla, [...llamadas, [k, a]]) : o }
    },
  })
  const cliente = dbReal()
  const falso = new Proxy(cliente, { get(t, k) {
    if (k === 'from') return tabla => envolver(t.from(tabla), tabla)
    if (k === 'rpc') throw new Error('RPC BLOQUEADA')
    return t[k]
  } })
  sup.db = () => falso

  const prov = require(path.join(E, 'src/services/providers/comfyui.provider'))
  prov.uploadImageToComfyUI = async url => { if (SIN_REF) throw new Error('subida apagada (modo sin REF)'); return `up_${sha(String(url)).slice(0, 16)}.png` }
  prov.uploadBufferToComfyUI = async () => { throw new Error('subida de buffer no prevista en la prueba') }

  ;(async () => {
    const { generateDeck } = require(path.join(E, 'src/services/image-gen.service'))
    const { data: n } = await sup.db().from('forge_nodes').select('id').eq('node_key', '3.20').single()
    let wf = null, avisos = null
    try {
      await generateDeck({ db: sup.db, project_id: PROY, node_id: n.id, session_id: null, node_key: '3.20', output_key: 'prueba',
        image_gen_model: 'comfyui:V57_STUDIO_ArtStyleGuide_Template_25', deck: 'asg', member_id: null,
        solo: SOLO ? SOLO.split(',').map(Number) : null, instancia: INST ? JSON.parse(INST) : null })
    } catch (e) { if (!e.capturado) { console.log(JSON.stringify({ error: e.message, bloqueos })); process.exit(0) } wf = e.capturado }
    console.log(JSON.stringify({ wf, bloqueos }))
    process.exit(0)
  })().catch(e => { console.log(JSON.stringify({ error: e.message, bloqueos })); process.exit(0) })
  return
}

// ─── Modo principal ────────────────────────────────────────────────────────────────────────────────────────────
const DELTA = arg('--delta'), REF_ENGINE = arg('--ref-engine')
const PROY = arg('--project', 'f84d5601-dcff-4efb-8784-510a8e2f2fb2')   // Smack The Coral Wish: maestro de 34, sin Add Context
if (!DELTA || !REF_ENGINE) { console.error('uso: --delta <PKG/delta> --ref-engine <carpeta con src/ del motor de hoy> [--project <id>]'); process.exit(1) }
const REG = path.join(path.resolve(DELTA), 'registro')
const correr = o => {
  const a = [__filename, '--correr', '--engine', o.engine, '--project', PROY]
  if (o.registro) a.push('--registro', REG)
  if (o.sinRef) a.push('--sin-ref')
  if (o.solo) a.push('--solo', o.solo)
  if (o.instancia) a.push('--instancia', JSON.stringify(o.instancia))
  if (o.refs) a.push('--refs', JSON.stringify(o.refs))
  const r = JSON.parse(execFileSync(process.execPath, a, { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(process.cwd(), 'node_modules') } })
    .split('\n').filter(l => l.startsWith('{')).pop())
  if (r.error) throw new Error(`${o.etiqueta}: ${r.error}`)
  return r
}
const ic = JSON.parse(fs.readFileSync(path.join(REG, 'inject_config_userref.json'), 'utf8'))
const gptDe = Object.fromEntries(ic.pages.map(p => [p.save_node, p]))
let fallos = 0, bloqueos = 0
const linea = (ok, t) => { if (!ok) fallos++; console.log(`${ok ? '✔' : '✖'} ${t}`) }

/** Compara dos grafos despachados página por página (prompt + entradas del nodo GPT) y entero. */
function comparar(etq, a, b) {
  const paginas = Object.keys(a).filter(id => a[id].class_type === 'SaveImage')
  const distintas = []
  for (const s of paginas) {
    const g = a[s].inputs.images[0], p = gptDe[s]?.name || s
    if (JSON.stringify(a[g]?.inputs) !== JSON.stringify(b[g]?.inputs)) distintas.push(p)
  }
  const conRef = paginas.filter(s => { const g = a[s].inputs.images[0]; return Object.keys(a[g].inputs).some(k => /image_2|reference/.test(k)) }).length
  const entero = JSON.stringify(a) === JSON.stringify(b)
  // La primera diferencia, para que un ✖ diga dónde mirar.
  let detalle = ''
  if (distintas.length) {
    const s = paginas.find(x => gptDe[x]?.name === distintas[0] || x === distintas[0]), g = a[s].inputs.images[0]
    for (const k of new Set([...Object.keys(a[g].inputs), ...Object.keys(b[g]?.inputs || {})])) {
      const x = JSON.stringify(a[g].inputs[k]), y = JSON.stringify(b[g]?.inputs?.[k])
      if (x === y) continue
      let i = 0; while (x && y && x[i] === y[i]) i++
      detalle = `\n    ${distintas[0]}.${k}: nuevo «${(x || '').slice(Math.max(0, i - 60), i + 120)}»\n    ${' '.repeat(distintas[0].length + k.length + 1)}  hoy  «${(y || '').slice(Math.max(0, i - 60), i + 120)}»`
      break
    }
  }
  linea(entero && !distintas.length && paginas.length === Object.keys(b).filter(id => b[id].class_type === 'SaveImage').length,
    `${etq}: ${paginas.length} páginas (${conRef} con REF, ${paginas.length - conRef} solo plantilla) · grafo ${entero ? 'idéntico byte a byte' : 'DISTINTO'}${distintas.length ? ` · distintas: ${distintas.join(', ')}` : ''}${detalle}`)
}

const NUEVO = RAIZ
console.log(`Proyecto ${PROY} · motor de referencia ${REF_ENGINE} · motor nuevo ${NUEVO}\n`)
const casos = []
for (const sinRef of [false, true]) {
  const etq = sinRef ? 'sin REF' : 'con REF'
  const hoy = correr({ engine: REF_ENGINE, sinRef, etiqueta: `hoy ${etq}` })
  const compat = correr({ engine: NUEVO, sinRef, etiqueta: `nuevo 136 ${etq}` })
  const u = correr({ engine: NUEVO, registro: true, sinRef, etiqueta: `nuevo 170 ${etq}` })
  casos.push(hoy, compat, u)
  comparar(`[136] motor nuevo vs hoy, ${etq}`, compat.wf, hoy.wf)
  comparar(`[170] motor nuevo sin USERREF vs hoy, ${etq}`, u.wf, hoy.wf)
}

// Hoja instanciada: la Character Sheet, una instancia.
const nCS = ic.pages.findIndex(p => p.name === '23_CharacterSheet') + 1
const instA = { pagina: '18_CharacterSheet', item: 'Lumen-Vael (CHAR-02)' }, instB = { pagina: '18_CharacterSheet', item: 'Otra instancia' }
{
  const hoy = correr({ engine: REF_ENGINE, solo: String(nCS), instancia: instA, etiqueta: 'hoy instancia' })
  const u = correr({ engine: NUEVO, registro: true, solo: String(nCS), instancia: instA, etiqueta: 'nuevo instancia' })
  casos.push(hoy, u)
  comparar('[170] hoja instanciada 23_CharacterSheet sin USERREF vs hoy', u.wf, hoy.wf)
}

// Con USERREF en el registro compartido: una de página (01_KeyArt) y una de instancia (Character Sheet · instA).
{
  const ahora = new Date().toISOString()
  const refs = [
    { id: 'prueba-1', name: 'REF de página', storage_url: 'https://prueba.invalid/keyart.png', status: 'approved', created_at: ahora,
      metadata: { contexto: { pagina_destino: '01_KeyArt', estado: 'approved' } } },
    { id: 'prueba-2', name: 'REF de instancia', storage_url: 'https://prueba.invalid/lumen.png', status: 'approved', created_at: ahora,
      metadata: { contexto: { pagina_destino: '23_CharacterSheet', estado: 'approved', instancia: { pagina: '23_CharacterSheet', item: 'Lumen-Vael (CHAR-02)' } } } },
  ]
  const imagen3 = (wf, pagina) => { const p = ic.pages.find(x => x.name === pagina); const g = wf[p.prompt_node]; const h = p.image_inputs.find(x => x.slot === '3')
    return { conecta: JSON.stringify(g?.inputs?.['model.images.image_3']) === JSON.stringify([h.node, 0]), archivo: wf[h.node]?.inputs?.image, clausula: /^IMAGE 3 = /m.test(g?.inputs?.prompt || ''), three: /THREE input images/.test(g?.inputs?.prompt || '') } }
  const esperado = url => `up_${sha(url).slice(0, 16)}.png`

  const deck = correr({ engine: NUEVO, registro: true, refs, etiqueta: 'deck con USERREF' })
  const hoy = casos[0].wf
  const ka = imagen3(deck.wf, '01_KeyArt')
  linea(ka.conecta && ka.archivo === esperado(refs[0].storage_url) && ka.clausula && ka.three,
    `[170] deck con USERREF de página: 01_KeyArt lleva image_3 = su referencia, la cláusula y «THREE»`)
  const cs = imagen3(deck.wf, '23_CharacterSheet')
  linea(!cs.conecta && !cs.clausula, '[170] deck: la Character Sheet SIN instancia no toma la referencia de una instancia')
  const otras = Object.keys(deck.wf).filter(id => deck.wf[id].class_type === 'SaveImage' && gptDe[id]?.name !== '01_KeyArt')
  const igualHoy = otras.filter(s => { const g = deck.wf[s].inputs.images[0]; return JSON.stringify(deck.wf[g].inputs) === JSON.stringify(hoy[g]?.inputs) })
  linea(igualHoy.length === otras.length, `[170] deck: las otras ${otras.length} páginas idénticas a hoy (${igualHoy.length}/${otras.length})`)

  const a = correr({ engine: NUEVO, registro: true, refs, solo: String(nCS), instancia: instA, etiqueta: 'instancia A con USERREF' })
  const ia = imagen3(a.wf, '23_CharacterSheet')
  linea(ia.conecta && ia.archivo === esperado(refs[1].storage_url) && ia.clausula,
    '[170] instancia «Lumen-Vael (CHAR-02)»: lleva image_3 = SU referencia y la cláusula')
  const b = correr({ engine: NUEVO, registro: true, refs, solo: String(nCS), instancia: instB, etiqueta: 'instancia B con USERREF' })
  const hoyB = correr({ engine: REF_ENGINE, solo: String(nCS), instancia: instB, etiqueta: 'hoy instancia B' })
  casos.push(deck, a, b, hoyB)
  comparar('[170] OTRA instancia de la misma hoja (la referencia no se cuela) vs hoy', b.wf, hoyB.wf)
}

bloqueos = casos.reduce((s, c) => s + (c.bloqueos || []).length, 0)
console.log(`\n${fallos ? `✖ ${fallos} comprobación(es) fallida(s)` : '✔ todas las comprobaciones como deben'}`)
console.log(`[red] intentos de salida bloqueados: ${bloqueos} (permitido: GET/HEAD al host de SUPABASE_URL)`)
process.exit(fallos || bloqueos ? 1 : 0)
