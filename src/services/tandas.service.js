// ─── Un output largo en tandas paralelas ─────────────────────────────────────
//
// asset_briefs del 3.9 es un YAML de ~60 ítems y ~87.000 caracteres. MiMo no hace streaming y escribe a
// ~50 tokens/s, así que una sola llamada tarda lo que tarde su salida: 482 s medidos en Wort. La
// duración la pone la salida, no la entrada, y la salida se puede repartir.
//
// Cómo, sin que nadie aguas abajo note el cambio:
//   1. Una pasada CORTA fija el inventario: id, categoría, nombre y scope_ref de cada ítem. Ahí se
//      decide la regla «briefed once» y ahí quedan fijados los ids que van a citar los demás outputs.
//   2. N tandas en paralelo (N y los pesos los declara la DNA) escriben los ítems completos sobre esa
//      lista fija, cada una su parte.
//   3. El motor las une en el MISMO bloque YAML de hoy — mismo orden, mismo texto del modelo, una línea
//      en blanco entre ítems — y completa los campos que la DNA le encarga (status).
//
// Todo lo específico vive en la DNA, en el campo `batches` del output; este servicio no sabe qué es un
// asset. Un output sin `batches` no pasa por aquí y corre exactamente como antes.
//
// Las llamadas reales las hace quien llama (`llamar`), para que este servicio no sepa de proveedores, de
// sesiones ni de logs: recibe una función, y avisa de cada llamada por `alLlamar` para que el log tenga
// una fila por llamada.

const YAML = require('yaml')

const DEFECTOS = {
  max_batches:      4,
  max_retries:      1,
  default_weight:   1450,     // caracteres esperados por ítem cuando la categoría no tiene peso propio
  split_over:       1.15,     // una categoría sola que pasa el ideal en más de un 15 % se parte por ítems
  list_key:         'asset_id',
}

/** El campo `batches` del output, con sus defectos, o null si el output no corre en tandas. */
function configDe(outputDef) {
  const b = outputDef && typeof outputDef === 'object' ? outputDef.batches : null
  if (!b || typeof b !== 'object') return null
  return { ...DEFECTOS, ...b }
}

/** El output del nodo que corre en tandas, si lo hay. */
const outputEnTandas = outputDefs => (Array.isArray(outputDefs) ? outputDefs : []).find(o => configDe(o)) || null
/** Todos los que corren en tandas (Engine v1.8: un nodo puede tener uno por ítems y otro por secciones). */
const outputsEnTandas = outputDefs => (Array.isArray(outputDefs) ? outputDefs : []).filter(o => configDe(o))
/** Modo por SECCIONES (Engine v1.8): el output es un documento con encabezados canónicos, no una lista. */
const esPorSecciones = cfg => !!cfg && cfg.mode === 'sections'

/**
 * El output en tandas cuyo inventario ESTE output tiene que usar (ui_screens, scene_manifest, ADIs…),
 * según `batches.inventory_for` de aquel. Admite comodín al final: «ADI_*».
 */
function proveedorDeInventario(outputDefs, outputKey) {
  if (!outputKey) return null
  const casa = (patron, k) => patron.endsWith('*') ? k.startsWith(patron.slice(0, -1)) : patron === k
  return (Array.isArray(outputDefs) ? outputDefs : []).find(o => {
    const c = configDe(o)
    return c && (o.key || o.name) !== outputKey && (c.inventory_for || []).some(p => casa(p, outputKey))
  }) || null
}

// ── YAML ─────────────────────────────────────────────────────────────────────

/** El primer bloque ```yaml (o ``` a secas) de un texto; sin vallas, el texto entero. */
function bloqueYaml(texto) {
  const t = String(texto || '').replace(/\r\n/g, '\n')
  const m = t.match(/```(?:ya?ml)?[ \t]*\n([\s\S]*?)(?:\n```|$)/)
  return m ? m[1] : t
}

/**
 * Los tramos de una lista YAML de primer nivel, por su clave: cada uno desde «- <key>:» hasta el
 * siguiente. Se trabaja con el TEXTO del modelo, no con una reserialización: así la unión deja cada
 * ítem tal como se escribió (comillas, orden de campos, listas en línea).
 */
function tramos(yamlTexto, key) {
  const t = String(yamlTexto || '').replace(/\r\n/g, '\n')
  const re = new RegExp(`^- ${key}:`, 'gm')
  const ini = [...t.matchAll(re)].map(m => m.index)
  return ini.map((p, i) => t.slice(p, ini[i + 1] ?? t.length).replace(/\s+$/, ''))
}

/** El id de un tramo, leído del propio YAML del tramo. */
function idDe(tramo, key) {
  try {
    const v = YAML.parse(tramo)
    const o = Array.isArray(v) ? v[0] : v
    return o && o[key] != null ? String(o[key]) : null
  } catch { return null }
}

// ── Inventario ───────────────────────────────────────────────────────────────

/**
 * La salida de la pasada de inventario: `asset_inventory:` con una lista de { <key>, category, name,
 * scope_ref }. Devuelve los ítems y los errores que encuentre; no lanza.
 */
function leerInventario(texto, cfg, { encabezadosDeInputs = [] } = {}) {
  const key = cfg.list_key
  const errores = []
  let lista = null
  try {
    const v = YAML.parse(bloqueYaml(texto))
    lista = Array.isArray(v?.asset_inventory) ? v.asset_inventory : Array.isArray(v) ? v : null
  } catch (e) { errores.push(`the inventory is not valid YAML: ${e.message.split('\n')[0]}`) }
  if (!lista && !errores.length) errores.push('the inventory has no `asset_inventory` list')
  const items = []
  const vistos = new Set()
  const patron = cfg.id_pattern ? new RegExp(cfg.id_pattern) : null
  const categorias = Array.isArray(cfg.categories) ? cfg.categories : null
  for (const x of lista || []) {
    const id = x && x[key] != null ? String(x[key]).trim() : ''
    if (!id) { errores.push(`an entry has no ${key}`); continue }
    if (vistos.has(id)) { errores.push(`${id} appears twice (one asset, one entry)`); continue }
    vistos.add(id)
    if (patron && !patron.test(id)) errores.push(`${id} does not match ${cfg.id_pattern}`)
    const category = x.category != null ? String(x.category) : ''
    if (categorias && !categorias.includes(category)) errores.push(`${id}: category «${category}» is not in the closed list`)
    const pref = id.split('_')[0]
    const permitidas = cfg.prefix_categories?.[pref]
    if (permitidas && category && !permitidas.includes(category)) errores.push(`${id}: prefix ${pref} cannot have category «${category}»`)
    items.push({ [key]: id, category, name: x.name != null ? String(x.name) : '', scope_ref: x.scope_ref ?? null })
  }
  if (lista && !items.length) errores.push('the inventory is empty')
  // Cobertura mínima: si llega un input, tiene que haber al menos un ítem de las categorías que exige.
  for (const r of cfg.required_categories || []) {
    const llega = encabezadosDeInputs.some(h => new RegExp(r.when_input, 'i').test(h))
    if (llega && !items.some(i => (r.categories || []).includes(i.category))) {
      errores.push(`no ${r.categories.join(' / ')} in the inventory, although ${r.when_input} is an input`)
    }
  }
  return { items, errores }
}

/** El inventario como bloque YAML para inyectarlo en un prompt (tandas, respuesta principal, consumidores). */
function inventarioComoYaml(items, cfg) {
  const key = cfg.list_key
  const q = v => (v == null ? 'null' : JSON.stringify(String(v)))
  return '```yaml\nasset_inventory:\n' + items.map(i =>
    `  - { ${key}: ${q(i[key])}, category: ${q(i.category)}, name: ${q(i.name)}, scope_ref: ${q(i.scope_ref)} }`).join('\n') + '\n```'
}

/**
 * El inventario vigente sacado de un YAML ya escrito (la última pieza aprobada del output en tandas):
 * lo que necesitan los consumidores cuando corren solos, en A o en B.
 */
function inventarioDeYaml(texto, cfg) {
  const key = cfg.list_key
  return tramos(bloqueYaml(texto), key).map(tr => {
    try {
      const v = YAML.parse(tr); const o = Array.isArray(v) ? v[0] : v
      return o && o[key] ? { [key]: String(o[key]), category: o.category ?? '', name: o.name ?? '', scope_ref: o.scope_ref ?? null } : null
    } catch { return null }
  }).filter(Boolean)
}

const sustituir = (plantilla, vars) => String(plantilla || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m))

// ── Reparto ──────────────────────────────────────────────────────────────────

/**
 * Las tandas: categorías enteras repartidas por peso esperado (LPT: la más pesada primero, a la tanda
 * más ligera). Una categoría que sola pasa el ideal en más de `split_over` se parte por ítems. Dentro
 * de cada tanda se respeta el orden del inventario. Devuelve listas de ids y su peso esperado.
 */
function repartir(items, cfg) {
  const key = cfg.list_key
  const N = Math.max(1, Math.min(Number(cfg.max_batches) || DEFECTOS.max_batches, items.length))
  const peso = i => Number(cfg.weight_by_category?.[i.category]) || Number(cfg.default_weight) || DEFECTOS.default_weight
  const total = items.reduce((s, i) => s + peso(i), 0)
  const ideal = total / N
  const grupos = []
  const porCat = new Map()
  for (const i of items) { if (!porCat.has(i.category)) porCat.set(i.category, []); porCat.get(i.category).push(i) }
  for (const [cat, lista] of porCat) {
    const p = lista.reduce((s, i) => s + peso(i), 0)
    if (p > ideal * (Number(cfg.split_over) || DEFECTOS.split_over) && lista.length > 1) {
      const partes = Math.ceil(p / ideal)
      const tam = Math.ceil(lista.length / partes)
      for (let k = 0; k < lista.length; k += tam) grupos.push({ etiqueta: `${cat} ${k / tam + 1}`, items: lista.slice(k, k + tam) })
    } else grupos.push({ etiqueta: cat, items: lista })
  }
  const tandas = Array.from({ length: N }, () => ({ grupos: [], peso: 0 }))
  for (const g of grupos.map(g => ({ ...g, peso: g.items.reduce((s, i) => s + peso(i), 0) })).sort((a, b) => b.peso - a.peso)) {
    const t = tandas.reduce((a, b) => (a.peso <= b.peso ? a : b))
    t.grupos.push(g); t.peso += g.peso
  }
  const orden = new Map(items.map((i, n) => [i[key], n]))
  return tandas.filter(t => t.grupos.length).map((t, n) => ({
    numero: n + 1,
    etiqueta: t.grupos.map(g => g.etiqueta).join(' + '),
    ids: t.grupos.flatMap(g => g.items.map(i => i[key])).sort((a, b) => orden.get(a) - orden.get(b)),
    peso: Math.round(t.peso),
  }))
}

// ── Una tanda ────────────────────────────────────────────────────────────────

/**
 * Lo que devolvió una tanda, contra su subconjunto: tramos válidos por id, y los que faltan, sobran o
 * se repiten. Un tramo que no se lee (p. ej. el último de una respuesta truncada) cuenta como faltante.
 */
function leerTanda(texto, ids, cfg) {
  const key = cfg.list_key
  const pedidos = new Set(ids)
  const porId = new Map()
  const ajenos = [], duplicados = [], ilegibles = [], incompletos = []
  const obligatorios = Array.isArray(cfg.required_fields) ? cfg.required_fields : []
  for (const tr of tramos(bloqueYaml(texto), key)) {
    const id = idDe(tr, key)
    if (!id) { ilegibles.push(tr.slice(0, 60)); continue }
    if (!pedidos.has(id)) { ajenos.push(id); continue }
    if (porId.has(id)) { duplicados.push(id); continue }
    let o = null
    try { const v = YAML.parse(tr); o = Array.isArray(v) ? v[0] : v } catch { }
    const falta = obligatorios.filter(f => !(o && f in o))
    if (falta.length) { incompletos.push(`${id} (${falta.join(', ')})`); continue }
    porId.set(id, tr)
  }
  const faltan = ids.filter(id => !porId.has(id))
  return { porId, faltan, ajenos, duplicados, ilegibles, incompletos }
}

// ── Campos que completa el motor ─────────────────────────────────────────────

const REGLAS = {
  // provisional mientras un frame de evento siga en null o un valor diga DRAFT; si no, final.
  provisional_if_null_frame_or_draft: tramo => (/\bframe:\s*null\b/.test(tramo) || /DRAFT/.test(tramo) ? 'provisional' : 'final'),
}

/**
 * Los campos que la DNA encarga al motor (`computed_fields`), en un tramo. Si el modelo NO escribió el
 * campo, se añade como último campo del ítem; si lo escribió y cuadra con la regla, no se toca; si lo
 * escribió y NO cuadra, se corrige en su línea. Devuelve el tramo y lo que hizo, para la fila de log de
 * la llamada que produjo el ítem.
 */
function completar(tramo, cfg) {
  let t = tramo
  const cambios = []
  for (const [campo, regla] of Object.entries(cfg.computed_fields || {})) {
    const f = REGLAS[regla]
    if (!f) continue
    const valor = f(t)
    const re = new RegExp(`^  ${campo}:[ \\t]*(.*)$`, 'm')
    const m = t.match(re)
    if (!m) { t = `${t}\n  ${campo}: ${JSON.stringify(valor)}`; cambios.push({ campo, accion: 'completado', a: valor }); continue }
    const actual = String(m[1]).trim().replace(/^["']|["']$/g, '')
    if (actual === valor) continue
    t = t.replace(re, `  ${campo}: ${JSON.stringify(valor)}`)
    cambios.push({ campo, accion: 'corregido', de: actual, a: valor })
  }
  return { texto: t, cambios }
}

/**
 * Los campos del motor sobre un output escrito ENTERO por una sola llamada (un turno de edición en Focus,
 * o una sección que el modelo emitió igual): el mismo `completar`, ítem por ítem, sin partir ni reordenar
 * nada; lo que no es la lista (prosa, vallas) queda tal cual. Devuelve el texto y lo hecho, para la fila
 * de log de esa llamada.
 */
function completarTexto(texto, cfg) {
  const key = cfg.list_key
  const t = String(texto || '').replace(/\r\n/g, '\n')
  const valla = t.match(/```(?:ya?ml)?[ \t]*\n([\s\S]*?)(?:\n```|$)/)
  const cuerpo = valla ? valla[1] : t
  const ini = [...cuerpo.matchAll(new RegExp(`^- ${key}:`, 'gm'))].map(m => m.index)
  const completados = [], corregidos = []
  if (!ini.length) return { texto, completados, corregidos }
  let nuevo = cuerpo.slice(0, ini[0])
  for (let i = 0; i < ini.length; i++) {
    const tramo = cuerpo.slice(ini[i], ini[i + 1] ?? cuerpo.length)
    const sinCola = tramo.replace(/\s+$/, ''), cola = tramo.slice(sinCola.length)
    const c = completar(sinCola, cfg)
    const id = idDe(sinCola, key) || `#${i + 1}`
    for (const x of c.cambios) (x.accion === 'completado' ? completados : corregidos).push(x.accion === 'completado' ? id : `${id} ${x.campo} ${x.de}→${x.a}`)
    nuevo += c.texto + cola
  }
  if (!completados.length && !corregidos.length) return { texto, completados, corregidos }
  const salida = valla ? t.replace(valla[0], () => valla[0].replace(valla[1], () => nuevo)) : nuevo
  return { texto: salida, completados, corregidos }
}

/** El YAML final: un bloque, ítems en el orden del inventario, una línea en blanco entre ítems. Los
 *  tramos llegan ya completados (correrTanda). */
function unir(items, porId, cfg) {
  const key = cfg.list_key
  const faltan = items.map(i => i[key]).filter(id => !porId.has(id))
  if (faltan.length) { const e = new Error(`merge without ${faltan.join(', ')}`); e.code = 'BATCH_FAILED'; throw e }
  const cuerpo = items.map(i => porId.get(i[key])).join('\n\n')
  const texto = '```yaml\n' + cuerpo + '\n```'
  // Lo unido tiene que leerse y tener exactamente los ítems del inventario.
  const v = YAML.parse(cuerpo)
  if (!Array.isArray(v) || v.length !== items.length) { const e = new Error(`the merged YAML has ${Array.isArray(v) ? v.length : 0} entries, the inventory ${items.length}`); e.code = 'BATCH_FAILED'; throw e }
  return texto
}

// ── Orquestación ─────────────────────────────────────────────────────────────

/** Ejecuta funciones async con a lo sumo `n` a la vez. */
async function conLimite(n, tareas) {
  const res = new Array(tareas.length)
  let siguiente = 0
  const trabajador = async () => { while (siguiente < tareas.length) { const k = siguiente++; res[k] = await tareas[k]() } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tareas.length)) }, trabajador))
  return res
}

// motivo del corte interno cuando una tanda cae del todo (filas de log: metadata.motivo)
const POR_HERMANA = 'aborted_by_sibling'
const abortado = signal => { if (signal?.aborted) { const e = new Error('cancelado por el usuario'); e.code = 'ABORTED'; throw e } }
const esperar = (ms, signal) => new Promise((ok, mal) => {
  const t = setTimeout(ok, ms)
  signal?.addEventListener?.('abort', () => { clearTimeout(t); const e = new Error('cancelado por el usuario'); e.code = 'ABORTED'; mal(e) }, { once: true })
})

/**
 * Una llamada con su fila de log. `llamar(system, user, {signal})` devuelve { texto, meta }.
 * `alLlamar(fila)` recibe { etapa, tanda, intento, ids, meta, status, error_code, duration_ms }.
 */
async function llamada({ llamar, alLlamar, signal }, { etapa, tanda = null, intento, ids = null, system, user, diferir = false }) {
  abortado(signal)
  const t0 = Date.now()
  try {
    const r = await llamar(system, user, { signal })
    const fila = extra => alLlamar?.({ etapa, tanda, intento, ids, meta: r.meta, status: 'success', duration_ms: r.meta?.duration_ms ?? (Date.now() - t0), ...(extra ? { extra } : {}) })
    // Una tanda deja su fila DESPUÉS de leerse, para que lleve lo que el motor corrigió en sus ítems.
    if (diferir) return { ...r, registrar: fila }
    fila()
    return r
  } catch (err) {
    // una tanda cortada porque cayó una hermana: mismo status que hoy, el motivo va en la metadata
    const porHermana = err?.code === 'ABORTED' && signal?.reason === POR_HERMANA
    alLlamar?.({ etapa, tanda, intento, ids, meta: null, status: err?.code === 'TIMEOUT' ? 'timeout' : 'error', error_code: err?.code || 'ERROR', error: err?.message, duration_ms: Date.now() - t0, ...(porHermana ? { extra: { motivo: POR_HERMANA } } : {}) })
    throw err
  }
}

/**
 * La pasada de inventario. `armado` = { system, user } del output en tandas (el mismo armado de una
 * corrida de ese output). Un reintento con la lista de errores; si vuelve a fallar, lanza
 * INVENTORY_FAILED y no se lanza ninguna tanda.
 */
async function pasadaInventario({ cfg, armado, llamar, alLlamar, signal, encabezadosDeInputs = [] }) {
  const base = `${armado.system}\n\n## Inventory pass\n${cfg.inventory_prompt || ''}`
  let errores = []
  for (let intento = 1; intento <= 1 + cfg.max_retries; intento++) {
    const system = errores.length ? `${base}\n\nYour previous inventory was rejected for these reasons — fix every one:\n- ${errores.join('\n- ')}` : base
    let r
    try {
      r = await llamada({ llamar, alLlamar, signal }, { etapa: 'inventory', intento, system, user: armado.user, diferir: true })
    } catch (err) {
      if (err?.code === 'ABORTED') throw err
      errores = [`the call failed: ${err?.code || err?.message}`]
      if (err?.code === 'RATE_LIMIT' && intento <= cfg.max_retries) await esperar(Math.min(Number(err.retry_after_ms) || 60000, 60000), signal)
      continue
    }
    const { items, errores: e } = leerInventario(r.texto, cfg, { encabezadosDeInputs })
    r.registrar(e.length ? { resultado: 'rechazado', errores: e.slice(0, 6) } : { resultado: 'ok', items: items.length })
    if (!e.length) return { items, meta: r.meta }
    errores = e
  }
  const err = new Error(`The inventory pass failed twice: ${errores.slice(0, 6).join('; ')}`)
  err.code = 'INVENTORY_FAILED'; err.publico = true
  throw err
}

/**
 * Una tanda con su reintento: faltantes → se piden solo esos; YAML roto, duplicados o error de la
 * llamada → la tanda entera otra vez (un 429 espera lo que diga el proveedor, hasta 60 s). Los ajenos se
 * descartan con aviso. Devuelve los tramos por id; si tras el reintento falta algo, lanza BATCH_FAILED.
 */
async function correrTanda({ cfg, armado, items, tanda, llamar, alLlamar, signal, avisos }) {
  const inventario = inventarioComoYaml(items, cfg)
  const porId = new Map()
  let pendientes = tanda.ids
  let ultimoError = null
  for (let intento = 1; intento <= 1 + cfg.max_retries && pendientes.length; intento++) {
    const system = `${armado.system}\n\n## Batch ${tanda.numero}\n` + sustituir(cfg.batch_prompt, {
      ids: pendientes.map(id => `- ${id}`).join('\n'), inventory: inventario, count: String(pendientes.length),
    })
    let r
    try {
      r = await llamada({ llamar, alLlamar, signal }, { etapa: 'batch', tanda: tanda.numero, intento, ids: pendientes, system, user: armado.user, diferir: true })
    } catch (err) {
      if (err?.code === 'ABORTED') throw err
      ultimoError = err
      if (err?.code === 'RATE_LIMIT' && intento <= cfg.max_retries) await esperar(Math.min(Number(err.retry_after_ms) || 60000, 60000), signal)
      continue
    }
    const l = leerTanda(r.texto, pendientes, cfg)
    if (l.ajenos.length) avisos.push(`batch ${tanda.numero} returned entries outside its list, dropped: ${l.ajenos.join(', ')}`)
    if (l.duplicados.length || (l.porId.size === 0 && pendientes.length)) {
      ultimoError = new Error(l.duplicados.length ? `duplicated ${l.duplicados.join(', ')}` : 'no readable entry')
      r.registrar({ resultado: 'rechazada', motivo: ultimoError.message, ajenos: l.ajenos.length })
      continue   // la tanda entera otra vez
    }
    // Los campos del motor, ítem por ítem; lo corregido va en la fila de ESTA llamada.
    const completados = [], corregidos = []
    for (const [id, tr] of l.porId) {
      const c = completar(tr, cfg)
      porId.set(id, c.texto)
      for (const x of c.cambios) (x.accion === 'completado' ? completados : corregidos).push(x.accion === 'completado' ? id : `${id} ${x.campo} ${x.de}→${x.a}`)
    }
    r.registrar({
      resultado: l.faltan.length ? 'incompleta' : 'ok', items: l.porId.size,
      ...(l.faltan.length ? { faltan: l.faltan.length } : {}), ...(l.ajenos.length ? { ajenos: l.ajenos.length } : {}),
      ...(completados.length ? { status_completados: completados.length } : {}),
      ...(corregidos.length ? { status_corregidos: corregidos } : {}),
    })
    pendientes = l.faltan
    if (pendientes.length) ultimoError = new Error(`missing ${pendientes.join(', ')}${l.incompletos.length ? ` (incomplete: ${l.incompletos.join('; ')})` : ''}`)
  }
  if (pendientes.length) {
    const e = new Error(`Batch ${tanda.numero} (${tanda.etiqueta}) failed after its retry: ${ultimoError?.message || 'no output'} — ids: ${pendientes.join(', ')}`)
    e.code = 'BATCH_FAILED'; e.publico = true; e.tanda = tanda.numero; e.ids = pendientes
    throw e
  }
  return porId
}

/**
 * Todo el output en tandas: inventario (o el que llegue ya fijado), reparto, tandas en paralelo con
 * límite, unión. Devuelve { texto, items, tandas, avisos, meta } — meta suma tokens y duración de
 * pared, con la forma de la meta de un proveedor, para quien hoy guarda la meta de una sola llamada.
 */
async function generarEnTandas({ cfg, armado, llamar, alLlamar, signal, inventario = null, encabezadosDeInputs = [], espina = null, alcance = null }) {
  // Engine v1.8: un documento por secciones va por su propio camino (espina + grupos + unión canónica)
  if (esPorSecciones(cfg)) return generarPorSecciones({ cfg, armado, llamar, alLlamar, signal, espina, alcance })
  const t0 = Date.now()
  const metas = []
  const anotar = f => { if (f.meta) metas.push(f.meta); alLlamar?.(f) }
  const inv = inventario || (await pasadaInventario({ cfg, armado, llamar, alLlamar: anotar, signal, encabezadosDeInputs })).items
  const plan = repartir(inv, cfg)
  const avisos = []
  // Una tanda que falla del todo tumba el output: las que siguen en vuelo se cortan, para no pagar
  // trabajo que no se va a usar. El Stop del usuario llega por la misma señal.
  const corte = new AbortController()
  const alParar = () => corte.abort()
  signal?.addEventListener?.('abort', alParar, { once: true })
  if (signal?.aborted) corte.abort()
  let partes
  try {
    partes = await conLimite(Number(cfg.max_concurrency) || plan.length, plan.map(t => () =>
      correrTanda({ cfg, armado, items: inv, tanda: t, llamar, alLlamar: anotar, signal: corte.signal, avisos })
        .catch(err => { if (err?.code !== 'ABORTED') corte.abort(POR_HERMANA); throw err })))
  } catch (err) {
    // si fue el Stop, que suba ABORTED; si fue una tanda, que suba su error y no el corte de las demás
    if (signal?.aborted) { const e = new Error('cancelado por el usuario'); e.code = 'ABORTED'; throw e }
    throw err
  } finally { signal?.removeEventListener?.('abort', alParar) }
  const porId = new Map()
  for (const p of partes) for (const [id, tr] of p) porId.set(id, tr)
  const texto = unir(inv, porId, cfg)
  const suma = k => metas.reduce((s, m) => s + (m?.tokens_used?.[k] || 0), 0)
  const m0 = metas[0] || {}
  return {
    texto, items: inv, tandas: plan, avisos,
    meta: { provider: m0.provider || null, model: m0.model || null, tokens_used: { input: suma('input'), output: suma('output'), cached: suma('cached') }, duration_ms: Date.now() - t0, finish_reason: 'stop', truncated: false, llamadas: metas.length },
  }
}

/**
 * El bloque que se añade al prompt de un consumidor (y de la respuesta principal de un nodo entero):
 * la lista fija de ids que tiene que usar. Si la DNA no da texto propio, uno genérico.
 */
function bloqueParaConsumidor(items, cfg) {
  const inv = inventarioComoYaml(items, cfg)
  return cfg.consumer_prompt
    ? sustituir(cfg.consumer_prompt, { inventory: inv })
    : `## Fixed asset inventory\nUse these ids exactly as written whenever this output names an asset:\n${inv}`
}

/** Para el nodo entero: el output en tandas lo escribe el motor; la respuesta principal no lo emite. */
function notaNodoEntero(outputKey, cfg) {
  return cfg.whole_node_prompt
    ? sustituir(cfg.whole_node_prompt, { key: outputKey })
    : `## Section written by the engine\nDo NOT emit the '## ${outputKey}' section: the engine writes it from parallel batches over the fixed inventory above.`
}

/**
 * Coser la sección del output en tandas en el documento de un nodo entero, en su sitio del contrato:
 * antes de la primera sección de un output POSTERIOR que esté presente; si no hay ninguna, al final.
 * Si el modelo la emitió igual, se reemplaza.
 */
function coserSeccion(replyText, outputKey, texto, outputDefs, extractSection) {
  const claves = (outputDefs || []).map(o => o.key || o.name).filter(Boolean)
  const seccion = `## ${outputKey}\n\n${texto}\n`
  const t = String(replyText || '')
  const re = new RegExp(`^##\\s+${outputKey}\\s*$`, 'm')
  if (re.test(t) && extractSection) {
    const actual = extractSection(t, outputKey, claves.filter(k => k !== outputKey))
    if (actual != null) {
      const i = t.search(re)
      const j = i + t.slice(i).indexOf(actual) + actual.length
      return t.slice(0, i) + seccion + t.slice(j).replace(/^\n+/, '\n')
    }
  }
  const despues = claves.slice(claves.indexOf(outputKey) + 1)
  let corte = -1
  for (const k of despues) {
    const m = t.search(new RegExp(`^##\\s+${k}\\s*$`, 'm'))
    if (m >= 0 && (corte < 0 || m < corte)) corte = m
  }
  return corte >= 0 ? `${t.slice(0, corte)}${seccion}\n${t.slice(corte)}` : `${t.replace(/\s+$/, '')}\n\n${seccion}`
}

// ── El pegamento con el motor (los tres caminos lo usan igual) ───────────────

/**
 * `llamar` y `alLlamar` con el proveedor y el log de verdad. Una fila de log POR LLAMADA (inventario,
 * cada tanda, cada reintento), con `metadata.corrida_id` para agrupar las llamadas de una misma corrida
 * — el panel cuenta filas como «calls», y así siguen siendo llamadas; quien quiera corridas agrupa por
 * ese campo o por session_id.
 */
function enganche({ callLLM, logExecution, executorStr, ctx }) {
  const corrida_id = ctx.corrida_id || `${ctx.session_id || 'sin-sesion'}:${Date.now()}`
  const llamar = async (system, user, { signal }) => {
    const r = await callLLM(system, user, { signal, model: executorStr, rawText: true, temperature: 0.7, maxOutputTokens: 64000 })
    return { texto: typeof r.data === 'string' ? r.data : JSON.stringify(r.data), meta: r.meta }
  }
  const alLlamar = f => {
    try {
      logExecution({
        project_id: ctx.project_id, node_id: ctx.node_id, session_id: ctx.session_id || null,
        triggered_by: ctx.member_id || null, trigger_type: ctx.trigger_type, executor_type: 'llm',
        provider: f.meta?.provider || null, model: f.meta?.model || null, tokens: f.meta?.tokens_used || null,
        duration_ms: f.duration_ms ?? null, started_at: new Date(Date.now() - (f.duration_ms || 0)).toISOString(),
        status: f.status, error_code: f.error_code || null, ...(f.status === 'success' ? {} : { cost_usd: 0 }),
        metadata: {
          node_key: ctx.node_key, output_key: ctx.output_key, corrida_id, etapa: f.etapa,
          ...(f.tanda != null ? { tanda: f.tanda } : {}), intento: f.intento,
          ...(f.ids ? { ids: f.ids.length } : {}),
          ...(f.meta?.finish_reason ? { finish_reason: f.meta.finish_reason } : {}), ...(f.meta?.truncated ? { truncated: true } : {}),
          ...(f.error ? { message: String(f.error).slice(0, 300) } : {}),
          ...(f.extra || {}),
        },
      })
    } catch (e) { console.error('[tandas] logExecution falló (no fatal):', e.message) }
    console.log(`[tandas] ${ctx.node_key}/${ctx.output_key} ${f.etapa}${f.tanda != null ? ' ' + f.tanda : ''} intento ${f.intento}: ${f.status}${f.error_code ? ' ' + f.error_code : ''} · ${f.duration_ms} ms`)
  }
  return { llamar, alLlamar, corrida_id }
}

/**
 * El inventario que ya existe para un output en tandas: el de su última pieza aprobada en el proyecto
 * (por la clave de su sesión, o por el nombre «<título> — <label>»). Lo usan los consumidores que corren
 * solos (A o B). Sin pieza, null: el consumidor corre como hoy.
 */
async function inventarioVigente(db, { project_id, node_id, nodeTitle, outputDef, cfg }) {
  const key = outputDef.key || outputDef.name
  const { data } = await db().from('forge_assets')
    .select('name, content, created_at, output_key, forge_sessions!session_id(output_key)')
    .eq('project_id', project_id).eq('node_id', node_id)
    .in('status', ['approved', 'auto_approved']).not('content', 'is', null)
    .order('created_at', { ascending: false })
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const nombre = norm(`${nodeTitle} — ${outputDef.label || key}`)
  const pieza = (data || []).find(a => (a.output_key ?? a.forge_sessions?.output_key) === key)
    || (data || []).find(a => norm(a.name) === nombre)
  if (!pieza) return null
  const items = inventarioDeYaml(pieza.content, cfg)
  return items.length ? items : null
}

/**
 * ¿El prompt ya lleva el inventario completo? Sí cuando aparecen TODOS sus ids: el asset_briefs entero
 * llega como hermano (ui_screens, scene_manifest) o dentro de un documento que lo trae. Entonces no se
 * inyecta nada y el prompt queda como hoy, byte a byte.
 */
function inventarioYaPresente(prompt, items, cfg) {
  const t = String(prompt || '')
  return items.length > 0 && items.every(i => t.includes(String(i[cfg.list_key])))
}

/**
 * C · Las tandas de un nodo entero corren DESPUÉS de la respuesta principal y usan los hermanos de ESA
 * corrida (style_guide, visual_targets), no los aprobados antes. El armado del output (buildSystemPrompt)
 * trae los aprobados como bloques «### <título> — <label> (this node — declared dependency)»: se
 * reconstruyen igual que allí (mismas piezas, mismo tope) y se sustituyen por la sección recién escrita.
 * Un hermano sin pieza aprobada se añade; uno que la respuesta principal no emitió se deja como estaba y
 * se avisa.
 */
const TOPE_HERMANO = 120000   // = INPUT_CAP de canvas-chat.service
async function armadoConHermanosDeLaCorrida(db, { project_id, node_id, nodeTitle, outputDefs, outputDef, armado, replyText, extractSection }) {
  const hermanos = outputDef.uses?.siblings_if_present ?? outputDef.uses?.siblings ?? []
  if (!hermanos.length) return { armado, usados: [], faltan: [] }
  const claves = outputDefs.map(o => o.key || o.name).filter(Boolean)
  const labelDe = k => { const od = outputDefs.find(o => (o.key || o.name) === k); return od ? (od.label || od.name || od.key) : k }
  const corte = c => c.slice(0, TOPE_HERMANO) + (c.length > TOPE_HERMANO ? '\n[truncated]' : '')
  const { data } = await db().from('forge_assets')
    .select('name, content, format')
    .eq('project_id', project_id).eq('node_id', node_id)
    .in('status', ['approved', 'auto_approved']).neq('format', 'png')
    .order('created_at', { ascending: false })
  let system = armado.system
  const usados = [], faltan = [], nuevos = []
  for (const k of hermanos) {
    const fresco = extractSection(replyText, k, claves.filter(x => x !== k))
    if (!fresco) { faltan.push(k); continue }
    const nombre = `${nodeTitle} — ${labelDe(k)}`
    const bloque = `### ${nombre} (this node — declared dependency, this run)\n${corte(fresco)}`
    let puestos = 0
    for (const a of data || []) {
      if ((a.name || '').toLowerCase().trim() !== nombre.toLowerCase().trim() || !a.content) continue
      const viejo = `### ${a.name} (this node — declared dependency)\n${corte(a.content)}`
      if (!system.includes(viejo)) continue
      system = system.replace(viejo, () => (puestos === 0 ? bloque : `### ${a.name} (this node — older version, superseded by this run)`))
      puestos++
    }
    if (!puestos) nuevos.push(bloque)
    usados.push(k)
  }
  if (nuevos.length) {
    const h = '## Existing outputs from this node\n'
    system = system.includes(h) ? system.replace(h, () => h + nuevos.join('\n\n') + '\n\n') : `${system}\n\n${h}${nuevos.join('\n\n')}`
  }
  return { armado: { ...armado, system }, usados, faltan }
}

// ═══ Engine v1.8 · modo `sections`: un DOCUMENTO largo en tandas por grupos de encabezados ═══════════
//
// `batches: { mode: 'sections', spine: [...], groups: [{ label, sections }], gate: [...], spine_prompt,
// batch_prompt, max_concurrency, max_retries }`. El output no es una lista de ítems sino un documento con
// encabezados canónicos (el ADD en Framework 11.0 v6.0). Tres pasos, como por ítems:
//   1. ESPINA: una llamada corta escribe las secciones que todas las demás necesitan para no contradecirse
//      (identidad, pilares, estilo aprobado, paleta). Se reutilizan tal cual y no se vuelven a pedir.
//   2. GRUPOS: cada grupo de la DNA es una tanda con su lista de encabezados; recibe la espina. Lectura por
//      el índice de encabezados (extraccion.service): faltantes → se piden solo esos; ajenos → se descartan
//      con aviso; un encabezado repetido → la tanda entera otra vez.
//   3. UNIÓN en orden canónico (por número, la espina incluida) y Gate final: si tras los reintentos falta
//      un encabezado de `gate`, el output falla con BATCH_FAILED, como por ítems.
// Pesos y grupos viven en la DNA: cambiar el reparto no toca el motor.

const X = require('./extraccion.service')

/** Lee de una respuesta las secciones pedidas: { porNum: Map n→texto, faltan, ajenos, duplicados }. */
function leerSecciones(texto, pedidas, cfg) {
  const canon = X.bloqueCanonico(texto)
  const encs = X.indice(canon)
  const porNum = new Map(), faltan = [], duplicados = []
  for (const n of pedidas) {
    const s = X.extraerSeccion(canon, n, encs, { propio: true })   // cada encabezado por su número, sin arrastrar hijos
    if (s.estado === 'ausente' || s.estado === 'fusionado') { faltan.push(n); continue }
    if (s.estado === 'duplicado') duplicados.push(n)
    porNum.set(n, s.texto)
  }
  // ajenos: encabezados de primer nivel de la respuesta que no desciendan de ninguna sección pedida
  const todas = (cfg.gate && cfg.gate.length ? cfg.gate : []).concat(pedidas)
  const ajenos = [...new Set(encs.flatMap(e => e.numeros).filter(n => !pedidas.some(p => X.desciende(n, p)) && todas.some(t => X.desciende(n, t) || X.desciende(t, n))))]
  return { porNum, faltan, ajenos, duplicados }
}

/** Las secciones de un mapa n→texto, unidas en orden canónico. */
function unirSecciones(porNum) {
  return [...porNum.keys()].sort(X.porNumero).map(n => porNum.get(n)).join('\n\n')
}

/** La pasada de espina: las secciones comunes; un reintento con lo que faltó. Lanza SPINE_FAILED. */
async function pasadaEspina({ cfg, armado, llamar, alLlamar, signal }) {
  const pedidas = [...new Set((cfg.spine || []).map(String))]
  const plantilla = cfg.spine_prompt || 'Write ONLY these sections of the document, at their canonical numbers and in this order, nothing else:\n{{headings}}'
  let faltan = pedidas, errores = [], porNum = new Map()
  for (let intento = 1; intento <= 1 + cfg.max_retries && faltan.length; intento++) {
    // el reintento pide SOLO lo que faltó: la lista de encabezados es la de este intento
    const base = `${armado.system}\n\n## Spine pass\n${sustituir(plantilla, { headings: faltan.map(n => `- §${n}`).join('\n'), count: String(faltan.length) })}`
    const system = errores.length ? `${base}\n\nYour previous reply was incomplete: the sections above are the ones still missing — write them now, each under its own numbered heading.` : base
    let r
    try { r = await llamada({ llamar, alLlamar, signal }, { etapa: 'spine', intento, ids: faltan, system, user: armado.user, diferir: true }) }
    catch (err) { if (err?.code === 'ABORTED') throw err; errores = faltan.map(n => `§${n}`); if (err?.code === 'RATE_LIMIT' && intento <= cfg.max_retries) await esperar(Math.min(Number(err.retry_after_ms) || 60000, 60000), signal); continue }
    const l = leerSecciones(r.texto, faltan, cfg)
    for (const [n, t] of l.porNum) porNum.set(n, t)
    r.registrar({ resultado: l.faltan.length ? 'incompleta' : 'ok', secciones: l.porNum.size, ...(l.faltan.length ? { faltan: l.faltan.length } : {}) })
    faltan = l.faltan; errores = faltan.map(n => `§${n}`)
  }
  if (faltan.length) { const e = new Error(`The spine pass failed twice: missing §${faltan.join(', §')}`); e.code = 'SPINE_FAILED'; e.publico = true; throw e }
  return { porNum, texto: unirSecciones(porNum) }
}

/**
 * Un grupo con su reintento. Devuelve Map n→texto; lanza BATCH_FAILED si tras el reintento falta algo.
 * `extras`: bloques que van después del prompt de la tanda (secciones de contexto ya escritas, alcance del
 * slice); `etiqueta`: campos que lleva la metadata de sus filas de log (p. ej. regeneration: 'slice').
 */
async function correrGrupo({ cfg, armado, espinaTexto, grupo, llamar, alLlamar, signal, avisos, extras = [], etiqueta = null }) {
  const pedidas = [...new Set((grupo.sections || []).map(String))].filter(n => !(cfg.spine || []).map(String).includes(n))
  const porNum = new Map()
  const marca = etiqueta || {}
  let pendientes = pedidas, ultimoError = null
  for (let intento = 1; intento <= 1 + cfg.max_retries && pendientes.length; intento++) {
    const system = `${armado.system}\n\n## Section batch ${grupo.numero}${grupo.label ? ` — ${grupo.label}` : ''}\n` + sustituir(cfg.batch_prompt || 'The sections below were already written (the spine); keep every decision in them. Write ONLY these sections, at their canonical numbers and in this order, nothing else:\n{{headings}}\n\n## Spine (already written — do not repeat)\n{{spine}}', {
      headings: pendientes.map(n => `- §${n}`).join('\n'), spine: espinaTexto, count: String(pendientes.length), label: grupo.label || '',
    }) + (extras.length ? '\n\n' + extras.join('\n\n') : '')
    let r
    try { r = await llamada({ llamar, alLlamar, signal }, { etapa: 'batch', tanda: grupo.numero, intento, ids: pendientes, system, user: armado.user, diferir: true }) }
    catch (err) { if (err?.code === 'ABORTED') throw err; ultimoError = err; if (err?.code === 'RATE_LIMIT' && intento <= cfg.max_retries) await esperar(Math.min(Number(err.retry_after_ms) || 60000, 60000), signal); continue }
    const l = leerSecciones(r.texto, pendientes, cfg)
    if (l.ajenos.length) avisos.push(`section batch ${grupo.numero} wrote sections outside its list, dropped: §${l.ajenos.join(', §')}`)
    if (l.duplicados.length || (l.porNum.size === 0 && pendientes.length)) {
      ultimoError = new Error(l.duplicados.length ? `duplicated §${l.duplicados.join(', §')}` : 'no readable section')
      r.registrar({ resultado: 'rechazada', motivo: ultimoError.message, ajenos: l.ajenos.length, ...marca })
      continue
    }
    for (const [n, t] of l.porNum) porNum.set(n, t)
    r.registrar({ resultado: l.faltan.length ? 'incompleta' : 'ok', secciones: l.porNum.size, ...(l.faltan.length ? { faltan: l.faltan.length } : {}), ...(l.ajenos.length ? { ajenos: l.ajenos.length } : {}), ...marca })
    pendientes = l.faltan
    if (pendientes.length) ultimoError = new Error(`missing §${pendientes.join(', §')}`)
  }
  if (pendientes.length) {
    const e = new Error(`Section batch ${grupo.numero} (${grupo.label || pedidas.join(', ')}) failed after its retry: ${ultimoError?.message || 'no output'} — sections: §${pendientes.join(', §')}`)
    e.code = 'BATCH_FAILED'; e.publico = true; e.tanda = grupo.numero; e.ids = pendientes
    throw e
  }
  return porNum
}

/**
 * Los bloques extra de un grupo: sus secciones `context` ya escritas (de la espina o de la ola anterior) y, si
 * es `slice_dependent`, el alcance del Vertical Slice (o la constancia de que no hay). Se evalúa al lanzar el
 * grupo, no al planificar: así ve lo que la primera ola ya escribió.
 */
function extrasDe(grupo, porNum, alcance, avisos) {
  const extras = []
  const ctx = [...new Set((grupo.context || []).map(String))]
  if (ctx.length) {
    const presentes = ctx.filter(n => porNum.has(n)), faltan = ctx.filter(n => !porNum.has(n))
    if (faltan.length) avisos?.push(`section batch ${grupo.numero}${grupo.label ? ' (' + grupo.label + ')' : ''} could not see §${faltan.join(', §')}: not written`)
    if (presentes.length) extras.push(`## Sections already written that this batch depends on (keep every decision in them — do not repeat them)\n${unirSecciones(new Map(presentes.map(n => [n, porNum.get(n)])))}`)
  }
  if (grupo.slice_dependent) extras.push(bloqueSlice(alcance))
  return extras
}
/** El alcance del slice como bloque del prompt; sin alcance, la constancia de que el proyecto no lo tiene. */
const bloqueSlice = alcance => alcance
  ? `## Vertical Slice scope (approved Vertical Slice Specification — node ${alcance.node_key}, ${alcance.output_key}${alcance.truncado ? ', truncated' : ''})\n${alcance.texto}`
  : '## Vertical Slice scope\nNot defined yet: this project has no approved Vertical Slice Specification.'

/**
 * El alcance del Vertical Slice para los grupos `slice_dependent`: la pieza aprobada más reciente de las claves
 * de `cfg.slice_scope.outputs` (en ese orden) del nodo `from_node` en este proyecto, o la pieza de nodo entero
 * de ese nodo. Null si la DNA no declara `slice_scope` o el proyecto no tiene el documento aprobado.
 */
async function alcanceDelSlice(db, { project_id, cfg }) {
  const sc = cfg?.slice_scope
  if (!sc || !sc.from_node) return null
  // el mismo buscador que los requisitos de un nodo (`metadata.requires`): pieza por clave, o la de nodo entero
  const { piezaAprobada } = require('./requisitos.service')
  const pieza = await piezaAprobada(db, { project_id, node_key: sc.from_node, outputs: sc.outputs || [] })
  if (!pieza) return null
  const tope = Number(sc.max_chars) || 60000
  const truncado = pieza.content.length > tope
  return { node_key: String(sc.from_node), output_key: pieza.output_key, chars: pieza.content.length, truncado, texto: truncado ? pieza.content.slice(0, tope) + '\n[truncated]' : pieza.content }
}

/**
 * Todo el documento por secciones: espina (o la que llegue), grupos en paralelo, unión canónica, Gate.
 * Dos olas: los grupos con `context` (secciones de otros grupos que tienen que ver escritas) corren después de
 * los demás, con esas secciones y, si son `slice_dependent`, el alcance del slice (`alcance`).
 */
async function generarPorSecciones({ cfg, armado, llamar, alLlamar, signal, espina = null, alcance = null }) {
  const t0 = Date.now()
  const metas = []
  const anotar = f => { if (f.meta) metas.push(f.meta); alLlamar?.(f) }
  const esp = espina || await pasadaEspina({ cfg, armado, llamar, alLlamar: anotar, signal })
  const grupos = (cfg.groups || []).map((g, i) => ({ ...g, numero: i + 1 }))
  const olas = [grupos.filter(g => !(g.context || []).length), grupos.filter(g => (g.context || []).length)].filter(o => o.length)
  const avisos = []
  const corte = new AbortController()
  const alParar = () => corte.abort()
  signal?.addEventListener?.('abort', alParar, { once: true })
  if (signal?.aborted) corte.abort()
  const porNum = new Map(esp.porNum)
  try {
    for (const ola of olas) {
      const partes = await conLimite(Number(cfg.max_concurrency) || ola.length, ola.map(g => () =>
        correrGrupo({ cfg, armado, espinaTexto: esp.texto, grupo: g, llamar, alLlamar: anotar, signal: corte.signal, avisos, extras: extrasDe(g, porNum, alcance, avisos) })
          .catch(err => { if (err?.code !== 'ABORTED') corte.abort(POR_HERMANA); throw err })))
      for (const p of partes) for (const [n, t] of p) if (!porNum.has(n)) porNum.set(n, t)
    }
  } catch (err) {
    if (signal?.aborted) { const e = new Error('cancelado por el usuario'); e.code = 'ABORTED'; throw e }
    throw err
  } finally { signal?.removeEventListener?.('abort', alParar) }
  const texto = unirSecciones(porNum)
  // Gate final: el documento unido tiene que traer cada encabezado obligatorio
  const g = X.verificarGate(X.indice(texto), cfg.gate || [])
  if (!g.ok) { const e = new Error(`The merged document fails the Conformance Gate: missing §${g.faltan.join(', §')}${g.fusionados.length ? '; fused ' + g.fusionados.join(', ') : ''}`); e.code = 'BATCH_FAILED'; e.publico = true; throw e }
  const suma = k => metas.reduce((s, m) => s + (m?.tokens_used?.[k] || 0), 0)
  const m0 = metas[0] || {}
  return {
    texto, secciones: [...porNum.keys()].sort(X.porNumero), tandas: grupos.map(x => ({ numero: x.numero, label: x.label, sections: x.sections, ...(x.context ? { context: x.context } : {}), ...(x.slice_dependent ? { slice_dependent: true } : {}) })), avisos, espina: esp, slice: alcance ? alcance.output_key : null,
    meta: { provider: m0.provider || null, model: m0.model || null, tokens_used: { input: suma('input'), output: suma('output'), cached: suma('cached') }, duration_ms: Date.now() - t0, finish_reason: 'stop', truncated: false, llamadas: metas.length },
  }
}

/**
 * Regenera SOLO los grupos `slice_dependent` sobre el documento aprobado: lee cada sección del maestro por su
 * número, corre esos grupos (con la espina y sus secciones `context` leídas del maestro, y el alcance del slice),
 * sustituye sus secciones y vuelve a unir en orden canónico con el Gate final. Lo demás queda tal cual (solo se
 * normaliza el espacio entre secciones). Lanza GATE_FAILED si el maestro no pasa el Gate —no se regenera sobre un
 * documento fuera de plantilla—, NO_SLICE_GROUPS si ningún grupo depende del slice, BATCH_FAILED como los grupos.
 */
async function regenerarGruposDelSlice({ cfg, armado, maestro, llamar, alLlamar, signal, alcance = null, soloSecciones = null }) {
  const t0 = Date.now()
  const publico = (code, msg) => { const e = new Error(msg); e.code = code; e.publico = true; e.status = 422; return e }
  if (!maestro || !String(maestro).trim()) throw publico('NO_MASTER', 'There is no approved document to regenerate: generate the output first')
  const todos = (cfg.groups || []).map((g, i) => ({ ...g, numero: i + 1 })).filter(g => g.slice_dependent)
  if (!todos.length) throw publico('NO_SLICE_GROUPS', 'No section group of this output is marked slice_dependent')
  // `soloSecciones`: con la fase sellada solo se COMPLETA lo que sigue en N/A (Pedro, 21-10). Rehacer los ocho
  // desgloses cuando faltaban dos cambiaba los nombres de las instancias ya escritas y dejaba a las hojas del
  // Moodboard apuntando a instancias viejas. Corren solo los grupos con alguna sección pendiente, y de lo que
  // devuelven solo se sustituyen esas secciones.
  const pendientes = soloSecciones ? new Set(soloSecciones.map(String)) : null
  const grupos = pendientes ? todos.filter(g => (g.sections || []).some(n => pendientes.has(String(n)))) : todos
  if (!grupos.length) throw publico('NOTHING_PENDING', 'Every slice breakdown of this document is already written')
  const canon = X.bloqueCanonico(maestro)
  const encs = X.indice(canon)
  // Lo que falta y es de un grupo del slice no tumba la regeneración: es justo lo que se va a escribir. Desde el
  // v2.9.59 el Gate pide §7.3.2 y §7.5.2, y los ADD aprobados antes traen 51 encabezados — sin esto, «Regenerate
  // slice breakdowns» los rechazaba por no tener las dos secciones que venía a crear (opción (a) de Pedro, 20-10).
  // Una fusión o un duplicado sí siguen frenando: eso es un documento fuera de plantilla.
  const delSlice = new Set(todos.flatMap(g => (g.sections || []).map(String)))
  const g0 = X.verificarGate(encs, (cfg.gate || []).filter(n => !delSlice.has(String(n)) || encs.some(e => e.numeros.includes(n))))
  if (!g0.ok) throw publico('GATE_FAILED', `The approved document fails the Conformance Gate (missing §${g0.faltan.join(', §')}${g0.fusionados.length ? '; fused ' + g0.fusionados.join(', ') : ''}${g0.duplicados.length ? '; duplicated §' + g0.duplicados.join(', §') : ''}): regenerate the whole document instead`)
  // cada encabezado por su número y con su cuerpo propio: la unión devuelve el documento tal cual
  const porNum = new Map()
  for (const n of [...new Set(encs.flatMap(e => e.numeros))]) { const s = X.extraerSeccion(canon, n, encs, { propio: true }); if (s.estado !== 'ausente') porNum.set(n, s.texto) }
  const espinaTexto = unirSecciones(new Map((cfg.spine || []).map(String).filter(n => porNum.has(n)).map(n => [n, porNum.get(n)])))
  const metas = [], avisos = []
  const anotar = f => { if (f.meta) metas.push(f.meta); alLlamar?.(f) }
  const corte = new AbortController()
  const alParar = () => corte.abort()
  signal?.addEventListener?.('abort', alParar, { once: true })
  if (signal?.aborted) corte.abort()
  let partes
  try {
    partes = await conLimite(Number(cfg.max_concurrency) || grupos.length, grupos.map(g => () =>
      correrGrupo({ cfg, armado, espinaTexto, grupo: g, llamar, alLlamar: anotar, signal: corte.signal, avisos, extras: extrasDe(g, porNum, alcance, avisos), etiqueta: { regeneration: 'slice' } })
        .catch(err => { if (err?.code !== 'ABORTED') corte.abort(POR_HERMANA); throw err })))
  } catch (err) {
    if (signal?.aborted) { const e = new Error('cancelado por el usuario'); e.code = 'ABORTED'; throw e }
    throw err
  } finally { signal?.removeEventListener?.('abort', alParar) }
  const regeneradas = []
  for (const p of partes) for (const [n, t] of p) { if (pendientes && !pendientes.has(String(n))) continue; porNum.set(n, t); regeneradas.push(n) }
  const texto = unirSecciones(porNum)
  const g = X.verificarGate(X.indice(texto), cfg.gate || [])
  if (!g.ok) { const e = new Error(`The regenerated document fails the Conformance Gate: missing §${g.faltan.join(', §')}${g.fusionados.length ? '; fused ' + g.fusionados.join(', ') : ''}`); e.code = 'BATCH_FAILED'; e.publico = true; throw e }
  const suma = k => metas.reduce((s, m) => s + (m?.tokens_used?.[k] || 0), 0)
  const m0 = metas[0] || {}
  return {
    texto, regeneradas: regeneradas.sort(X.porNumero), secciones: [...porNum.keys()].sort(X.porNumero), tandas: grupos.map(x => ({ numero: x.numero, label: x.label, sections: x.sections, context: x.context || [], slice_dependent: true })), avisos, slice: alcance ? alcance.output_key : null,
    meta: { provider: m0.provider || null, model: m0.model || null, tokens_used: { input: suma('input'), output: suma('output'), cached: suma('cached') }, duration_ms: Date.now() - t0, finish_reason: 'stop', truncated: false, llamadas: metas.length, regeneration: 'slice' },
  }
}

/** La espina ya escrita, para la respuesta principal de un nodo entero (C): que lo demás no la contradiga. */
const bloqueEspina = (clave, esp) => `## Spine of ${clave} (written by the engine's first pass — keep every decision in it)\n${esp.texto}`
/** La nota de nodo entero para un output por secciones. */
const notaNodoEnteroSecciones = clave => `## Section written by the engine\nDo NOT emit the '## ${clave}' section: the engine writes it in section batches over the spine above.`

module.exports = {
  enganche, inventarioVigente, inventarioYaPresente, armadoConHermanosDeLaCorrida,
  configDe, outputEnTandas, outputsEnTandas, esPorSecciones, proveedorDeInventario,
  leerSecciones, unirSecciones, pasadaEspina, correrGrupo, generarPorSecciones, bloqueEspina, notaNodoEnteroSecciones,
  extrasDe, bloqueSlice, alcanceDelSlice, regenerarGruposDelSlice,
  bloqueYaml, tramos, leerInventario, inventarioComoYaml, inventarioDeYaml,
  repartir, leerTanda, completar, completarTexto, unir, conLimite,
  pasadaInventario, correrTanda, generarEnTandas,
  bloqueParaConsumidor, notaNodoEntero, coserSeccion, REGLAS, DEFECTOS,
}
