'use strict'
// ─── Engine v1.9 · lo que el deck cinematográfico toma del proyecto cuando el modelo no lo pasa ──
//
// `doc_gen_pptx` recibe el deck (JSON con `meta` y `slides`) y una lista `images` de URLs por
// posición —image_wide, image_interior, image_object—. Las imágenes dependían de que el MODELO las
// pasara: en «Smack Surface Rush» (08-10) el modelo escribió «3 images placed» y no pasó ninguna, y
// el deck salió con cero imágenes mientras el proyecto tenía seis aprobadas en concept_data. La
// paleta igual: `meta.palette` la copia el modelo, o no.
//
// Este servicio solo RELLENA lo que falta, con reglas deterministas y desde datos que ya están en la
// corrida: el `concept_data` resuelto en los inputs (el mismo bloque que lee anclaIdentidad), las
// imágenes aprobadas del proyecto, y los ids que el propio deck cite en `meta.images`. Lo que el
// modelo trae no se toca.

const POSICIONES = ['image_wide', 'image_interior', 'image_object']
const PISTAS = {
  image_wide:     /\b(wide|establishing|key[- ]?art|splash|panorama|hero|cover)\b/i,
  image_interior: /\b(close|interior|medium|character|moment|action|gameplay|screenshot|portrait)\b/i,
  image_object:   /\b(object|prop|detail|material|study|item|editorial|cross[- ]section)\b/i,
}

/** El concept_data de la corrida: el primer bloque JSON de los inputs resueltos que trae título y paleta o imágenes. */
function conceptDataDe(resolvedInputs) {
  for (const bloque of (resolvedInputs || [])) {
    const s = String(bloque || '')
    for (const m of s.matchAll(/\{[\s\S]*\}/g)) {
      let o = null
      try { o = JSON.parse(m[0]) } catch { continue }
      if (o && typeof o === 'object' && (o.title || o.one_liner) && (Array.isArray(o.palette) || Array.isArray(o.approved_images))) return o
    }
    // el bloque entero puede ser «título\ncontenido» con el JSON cercado: se intenta el primer cercado
    const f = /```(?:json)?\s*\n([\s\S]*?)```/.exec(s)
    if (f) { try { const o = JSON.parse(f[1]); if (o && typeof o === 'object' && (o.title || o.one_liner) && (Array.isArray(o.palette) || Array.isArray(o.approved_images))) return o } catch { /* no */ } }
  }
  return null
}

// ── paleta ──
const hex6 = h => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); return m ? m[1].toUpperCase() : null }
const rgb = h => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
const luminancia = h => { const [r, g, b] = rgb(h).map(v => v / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const saturacion = h => { const [r, g, b] = rgb(h).map(v => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx }
const aclarar = (h, f) => rgb(h).map(v => Math.min(255, Math.round(v + (255 - v) * f))).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()

/**
 * { bg, surface, card, accent } (hex sin «#») a partir de la lista de hex del concept_data (dominante
 * primero): bg = el más oscuro; surface = el siguiente; card = el tercero oscuro, o bg aclarado un 12 %
 * cuando hay menos de tres oscuros; accent = el de mayor 0,7·saturación + 0,3·luminancia entre los demás.
 */
function paletaDesde(lista) {
  const hexes = [...new Set((Array.isArray(lista) ? lista : []).map(hex6).filter(Boolean))]
  if (hexes.length < 2) return null
  const porOscuridad = [...hexes].sort((a, b) => luminancia(a) - luminancia(b))
  const oscuros = porOscuridad.filter(h => luminancia(h) < 0.35)
  const bg = porOscuridad[0]
  const surface = porOscuridad[1]
  const card = oscuros.length >= 3 ? porOscuridad[2] : aclarar(bg, 0.12)
  const usados = new Set([bg, surface, card])
  const candidatos = hexes.filter(h => !usados.has(h))
  const puntaje = h => 0.7 * saturacion(h) + 0.3 * luminancia(h)
  const accent = (candidatos.length ? candidatos : hexes).sort((a, b) => puntaje(b) - puntaje(a))[0]
  return { bg, surface, card, accent }
}

// ── imágenes ──
/** Las pistas de una imagen aprobada: su rol, su tipo de plano, lo que muestra. */
const pistasDe = it => `${it?.role || ''} ${it?.shot_type || ''} ${it?.depicts || ''} ${it?.placement || ''} ${it?.id || ''}`

/**
 * Resuelve el id de una imagen aprobada a una URL: `url` del propio ítem, o la pieza png del proyecto cuyo
 * nombre termina en «— <id>». `piezasPng` = [{ name, storage_url }] del proyecto, ya leídas.
 */
function urlDe(id, aprobadas, piezasPng) {
  const it = (aprobadas || []).find(x => x && x.id === id)
  if (it?.url && /^https?:\/\//.test(it.url)) return it.url
  const fin = ` — ${id}`
  const p = (piezasPng || []).find(a => String(a.name || '').endsWith(fin) && a.storage_url)
  return p ? p.storage_url : null
}

/**
 * Las tres posiciones del deck desde `meta.images` (ids citados por el modelo) y, para las que queden
 * vacías, desde las imágenes aprobadas por sus pistas; sin pista, por orden. Devuelve [wide, interior, object]
 * con null en lo que no se pudo resolver, y las notas de qué se usó.
 */
function imagenesDesde({ conceptData, metaImages, piezasPng, png24 = [] }) {
  const aprobadas = Array.isArray(conceptData?.approved_images) ? conceptData.approved_images.filter(x => x && typeof x === 'object' && x.id) : []
  const urls = [null, null, null], notas = [], usados = new Set()
  // 1 · lo que el deck cita
  if (metaImages && typeof metaImages === 'object') {
    POSICIONES.forEach((pos, i) => {
      const id = metaImages[pos]
      if (typeof id !== 'string' || !id.trim()) return
      const u = urlDe(id.trim(), aprobadas, piezasPng)
      if (u) { urls[i] = u; usados.add(id.trim()); notas.push(`${pos} ← ${id.trim()} (cited by the deck)`) }
      else notas.push(`${pos}: '${id.trim()}' cited by the deck has no resolvable image`)
    })
  }
  // 2 · las aprobadas por pistas, en su orden
  const libres = aprobadas.filter(it => !usados.has(it.id)).map(it => ({ it, url: urlDe(it.id, aprobadas, piezasPng) })).filter(x => x.url)
  for (const pos of POSICIONES) {
    const i = POSICIONES.indexOf(pos)
    if (urls[i]) continue
    const j = libres.findIndex(x => PISTAS[pos].test(pistasDe(x.it)))
    if (j >= 0) { urls[i] = libres[j].url; notas.push(`${pos} ← ${libres[j].it.id} (approved image, by its role)`); libres.splice(j, 1) }
  }
  // 3 · sin pista, por orden
  for (const pos of POSICIONES) {
    const i = POSICIONES.indexOf(pos)
    if (urls[i] || !libres.length) continue
    const x = libres.shift(); urls[i] = x.url; notas.push(`${pos} ← ${x.it.id} (approved image, by order)`)
  }
  // 4 · Engine v1.10 — B: las png APROBADAS del 2.4 (Visual Convergence) cuando approved_images no cubre los huecos. El
  //     concept_data del 2.2 se escribe antes de que exista el 2.4, así que su inventario nunca las lista; sin esto el
  //     deck solo las usaba si el modelo las citaba. Por pista (el id del nombre «… — orient_NN_…») y luego por orden.
  const libres24 = (Array.isArray(png24) ? png24 : []).filter(p => p?.storage_url && !urls.includes(p.storage_url))
    .map(p => ({ id: String(p.name || '').split(' — ').pop(), url: p.storage_url }))
  for (const pos of POSICIONES) {
    const i = POSICIONES.indexOf(pos)
    if (urls[i]) continue
    const j = libres24.findIndex(x => PISTAS[pos].test(x.id.replace(/[_-]+/g, ' ')))
    if (j >= 0) { urls[i] = libres24[j].url; notas.push(`${pos} ← ${libres24[j].id} (2.4 approved image, by its role)`); libres24.splice(j, 1) }
  }
  for (const pos of POSICIONES) {
    const i = POSICIONES.indexOf(pos)
    if (urls[i] || !libres24.length) continue
    const x = libres24.shift(); urls[i] = x.url; notas.push(`${pos} ← ${x.id} (2.4 approved image, by order)`)
  }
  return { urls, notas, aprobadas: aprobadas.length }
}

/** Engine v1.10 — B: las png aprobadas del 2.4 del proyecto, de la más nueva a la más vieja. Vacío si no hay base. */
async function pngsAprobadasDel24(db, projectId) {
  if (!db || !projectId) return []
  try {
    const { data: n } = await db().from('forge_nodes').select('id').eq('node_key', '2.4').maybeSingle()
    if (!n?.id) return []
    const { data } = await db().from('forge_assets').select('name, storage_url').eq('project_id', projectId).eq('node_id', n.id)
      .in('format', ['png', 'image']).eq('status', 'approved').not('storage_url', 'is', null).order('created_at', { ascending: false })
    return data || []
  } catch { return [] }
}

/** Las piezas png del proyecto, para resolver ids sin url. Una lectura; vacío si no hay base. */
async function piezasPngDe(db, projectId) {
  if (!db || !projectId) return []
  try {
    const { data } = await db().from('forge_assets').select('name, storage_url').eq('project_id', projectId)
      .in('format', ['png', 'image']).not('storage_url', 'is', null).order('created_at', { ascending: false })
    return data || []
  } catch { return [] }
}

/**
 * Completa el deck antes de `doc_gen_pptx`: `content` (string JSON, objeto, o markdown) e `images` (URLs por
 * posición). Si el contenido es un deck JSON sin `meta.palette`, la deriva del concept_data; si `images` viene
 * vacío, las resuelve desde `meta.images` y las aprobadas. Markdown: solo las imágenes. Lo que ya viene no se toca.
 * Devuelve { content, images, notas }.
 */
async function completarDeck({ content, images, resolvedInputs, db = null, projectId = null }) {
  const notas = []
  let deck = null, eraTexto = typeof content === 'string'
  if (eraTexto) { try { const d = JSON.parse(content); if (d && typeof d === 'object' && Array.isArray(d.slides)) deck = d } catch { /* markdown */ } }
  else if (content && typeof content === 'object' && Array.isArray(content.slides)) deck = content
  const cd = conceptDataDe(resolvedInputs)
  let imgs = Array.isArray(images) ? images.filter(u => typeof u === 'string' && /^https?:\/\//.test(u)) : []

  if (deck) {
    deck.meta = deck.meta && typeof deck.meta === 'object' ? deck.meta : {}
    if (!deck.meta.palette || typeof deck.meta.palette !== 'object' || !Object.keys(deck.meta.palette).length) {
      const p = paletaDesde(cd?.palette)
      if (p) { deck.meta.palette = p; notas.push(`palette from concept_data (${Object.values(p).join(' ')})`) }
    }
  }
  if (!imgs.length && (cd || deck?.meta?.images || (db && projectId))) {
    const piezasPng = await piezasPngDe(db, projectId)
    const png24 = await pngsAprobadasDel24(db, projectId)
    const r = imagenesDesde({ conceptData: cd, metaImages: deck?.meta?.images, piezasPng, png24 })
    if (r.urls.some(Boolean)) {
      // la lista va por posición: una posición sin imagen queda como cadena vacía para no correr las demás
      const ultima = r.urls.map((u, i) => (u ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
      imgs = r.urls.slice(0, ultima + 1).map(u => u || '')
      notas.push(`images completed from approved_images (${r.urls.filter(Boolean).length} of ${POSICIONES.length}${r.aprobadas ? ', ' + r.aprobadas + ' approved' : ''})`, ...r.notas)
    } else if (r.notas.length) notas.push(...r.notas)
  }
  const salida = deck ? (eraTexto ? JSON.stringify(deck) : deck) : content
  return { content: salida, images: imgs, notas }
}

module.exports = { completarDeck, conceptDataDe, paletaDesde, imagenesDesde, pngsAprobadasDel24, urlDe, POSICIONES }
