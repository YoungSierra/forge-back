// Referencias VISUALES para el modelo.
//
// Hasta ahora, cuando se conectaba una imagen a un nodo se le mandaba al modelo un enlace
// markdown —`![nombre](url)`— con una bandera `isImage: true` que NADIE leía. El modelo recibía
// una URL, no una imagen, y respondía como si la hubiera visto porque el texto decía que ahí
// había una. Lo mismo con los PDF: se mandaba su texto y sus imágenes embebidas se perdían.
//
// Acá se convierten en bloques de visión de verdad. Cubre los cuatro caminos por los que hoy
// entra una referencia visual a un nodo:
//   · un activo de imagen de la librería, conectado
//   · un PNG de un output de otro nodo, conectado
//   · un activo de la librería referenciado sin cable
//   · las imágenes EMBEBIDAS en un documento (PDF), que antes no llegaban de ninguna forma

// Se reescala, y el motivo NO son los tokens.
//
// La versión anterior no reescalaba, con este razonamiento: el proveedor reescala de su lado a
// 1568 px y cobra tokens sobre esa medida, así que achicar acá no ahorra ni un token. Eso sigue
// siendo cierto — y es irrelevante. El tope que se cruzó el 08-09 no es de tokens sino de BYTES:
// la Messages API rechaza con 413 cualquier petición de más de 32 MB, y eso se mide sobre el
// payload en el cable, ANTES de que el proveedor reescale nada.
//
// Lo que pasó: el 2.5 recibió 12 imágenes de `orientation_images`. Cada una pasa el tope por
// archivo sin despeinarse —la mayor pesa 3,79 MB— pero sumadas dan 37,7 MB crudos, que en base64
// son ~50 MB. Los dos guardas que había —4 MB por imagen y 12 imágenes— no miran el total, así
// que dejaron pasar un mensaje del doble del límite. El usuario vio «Internal server error».
//
// Tres medidas, en este orden, porque cada una hace que la siguiente descarte menos:
//   1 · no bajar dos veces la misma URL   — 3 de esas 12 eran la misma imagen repetida
//   2 · reescalar a 1568 px               — es la medida a la que el proveedor iba a reescalar
//                                           igual, así que el modelo ve EXACTAMENTE lo mismo
//   3 · presupuesto en bytes del mensaje  — el que garantiza que no vuelva a haber un 413
//
// El reescalado va con `pngjs`, que ya estaba en las dependencias. `sharp` daría mejor calidad y
// más formatos, pero es módulo nativo y compilarlo en Render es un riesgo de build que no hace
// falta correr: todo lo que produce ComfyUI es PNG. Lo que no sea PNG viaja tal cual y se apoya
// en el presupuesto.

// PENDIENTE — PREGUNTAR AL EQUIPO: ¿cuántas imágenes por documento es razonable?
// Provisorio en 7. El PDF de SMACK trae 2 en 4 páginas y sobra, pero un pitch deck de 40 slides
// con una foto por página se comería el contexto sin avisar: una imagen de 738x1600 cuesta
// ~1.600 tokens. Cuando haya criterio del equipo, se cambia acá y nada más.
const MAX_POR_DOC = 7
const MAX_TOTAL   = 12                 // techo del mensaje entero, sin importar de dónde vengan
const BYTES_MAX   = 4 * 1024 * 1024    // tope duro del proveedor por imagen

// El lado largo al que reescala el proveedor. Bajar de acá SÍ perdería detalle que el modelo
// habría visto; quedarse por encima solo paga transporte.
const LADO_MAX = 1568

// Techo del payload de imágenes, ya en base64 (que es como viajan y como las cuenta el límite).
//
// Este es el corte BLANDO: evita bajar y codificar de más, pero no puede garantizar nada, porque
// acá no se sabe cuánto van a pesar el system prompt y el texto del nodo con sus inputs resueltos
// —en el 3.12 pasan del megabyte—. El corte DURO, el que impide el 413, vive en el proveedor, que
// es el único punto donde las tres partes del mensaje existen a la vez.
//
// 26 MB es holgado a propósito: con 20 MB se descartaban 3 de las 9 referencias del 2.5 que sí
// entraban en el límite real. Descartar de menos y que el proveedor recorte con el número exacto
// es mejor que descartar de más adivinando acá.
const PRESUPUESTO_B64 = 26 * 1024 * 1024

// El tipo sale de los bytes, no de la extensión ni del content-type: un `.png` que en realidad
// es JPEG hace fallar la llamada con un error del proveedor que no dice qué archivo fue.
function mimeDe(b) {
  if (b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)                  return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)                  return 'image/gif'
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

/**
 * Achica un PNG a `LADO_MAX` de lado largo. Devuelve el buffer original si no hay nada que ganar
 * —ya es chico, no es PNG, o el reencodeado salió más pesado que la fuente—.
 *
 * El promedio por caja (y no tomar 1 de cada N píxeles) importa: las imágenes de ComfyUI tienen
 * detalle fino y el submuestreo crudo lo convierte en ruido, que además comprime PEOR. Sale más
 * grande y se ve peor, las dos cosas a la vez.
 */
function achicarPng(buffer, nombre) {
  const { PNG } = require('pngjs')

  let png
  try {
    png = PNG.sync.read(buffer)
  } catch (err) {
    console.warn(`[vision] "${nombre}": no se pudo decodificar el PNG (${err.message}) — va sin reescalar`)
    return buffer
  }

  const { width: w, height: h, data } = png
  if (Math.max(w, h) <= LADO_MAX) return buffer

  const escala = LADO_MAX / Math.max(w, h)
  const w2 = Math.max(1, Math.round(w * escala))
  const h2 = Math.max(1, Math.round(h * escala))

  const out = new PNG({ width: w2, height: h2 })
  for (let y = 0; y < h2; y++) {
    const y0 = Math.floor(y * h / h2), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / h2))
    for (let x = 0; x < w2; x++) {
      const x0 = Math.floor(x * w / w2), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / w2))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) << 2
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++
        }
      }
      // Redondeo, no truncado: el Buffer trunca solo y eso oscurece la imagen medio nivel por
      // canal en cada píxel. Es poco, pero es un sesgo sistemático sobre el material que el
      // director de arte va a comparar contra el original.
      const o = (y * w2 + x) << 2
      out.data[o]     = Math.round(r / n)
      out.data[o + 1] = Math.round(g / n)
      out.data[o + 2] = Math.round(b / n)
      out.data[o + 3] = Math.round(a / n)
    }
  }

  let salida
  try {
    salida = PNG.sync.write(out)
  } catch (err) {
    console.warn(`[vision] "${nombre}": no se pudo reencodear (${err.message}) — va sin reescalar`)
    return buffer
  }
  if (salida.length >= buffer.length) {
    console.warn(`[vision] "${nombre}": el reencodeado no achica (${(salida.length / 1048576).toFixed(1)} MB) — va el original`)
    return buffer
  }
  console.log(`[vision] "${nombre}": ${w}x${h} → ${w2}x${h2} · ` +
    `${(buffer.length / 1048576).toFixed(2)} → ${(salida.length / 1048576).toFixed(2)} MB`)
  return salida
}

/** Un bloque listo para el proveedor: base64 + su tipo. `null` si no sirve. */
function normalizar(buffer, nombre) {
  if (!buffer?.length) return null

  // El tipo va ANTES del reescalado: hay que saber si es PNG para saber si se puede achicar. Y el
  // tope por archivo va DESPUÉS, porque un PNG de 5 MB a 4K entra de sobra una vez reescalado —
  // descartarlo antes de mirarlo tiraba una referencia aprovechable.
  const mime = mimeDe(buffer)
  if (!mime) { console.warn(`[vision] "${nombre}" descartada: formato no reconocido`); return null }

  const bytes = mime === 'image/png' ? achicarPng(buffer, nombre) : buffer

  if (bytes.length > BYTES_MAX) {
    console.warn(`[vision] "${nombre}" descartada: ${(bytes.length / 1048576).toFixed(1)} MB supera el tope por imagen`)
    return null
  }
  return { base64: bytes.toString('base64'), mime, nombre }
}

async function bajar(url) {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    return Buffer.from(await r.arrayBuffer())
  } catch {
    return null
  }
}

/** Imágenes embebidas en un documento. Hoy solo PDF: es el único formato del que se pueden
 *  sacar sin abrir el archivo entero en memoria de otra forma. */
async function imagenesDeDocumento(url, mime) {
  if (!/^application\/pdf$/.test(mime || '')) return { imgs: [], total: 0 }
  const buf = await bajar(url)
  if (!buf) return { imgs: [], total: 0 }

  let parser
  try {
    const { PDFParse } = require('pdf-parse')
    parser = new PDFParse({ data: buf })
    const r = await parser.getImage()
    const crudas = []
    for (const pag of (r.pages || [])) {
      for (const im of (pag.images || [])) {
        if (im?.data) crudas.push({ data: im.data, pagina: pag.pageNumber ?? null })
      }
    }
    const usadas = crudas.slice(0, MAX_POR_DOC)
    const imgs = []
    for (const c of usadas) {
      const b = Buffer.isBuffer(c.data) ? c.data : Buffer.from(c.data)
      const n = normalizar(b, `page ${c.pagina}`)
      if (n) imgs.push(n)
    }
    return { imgs, total: crudas.length }
  } catch (err) {
    console.warn('[vision] no se pudieron extraer imágenes del PDF:', err.message)
    return { imgs: [], total: 0 }
  } finally {
    await parser?.destroy?.().catch(() => {})
  }
}

/**
 * Cosecha las referencias visuales de los inputs ya resueltos de un nodo.
 * Devuelve los bloques y una NOTA para el texto: si un documento trae más imágenes de las que
 * entraron, el modelo tiene que saberlo. Si no, da por completo lo que vio y afirma de más.
 *
 * @param {Array<{label?:string, isImage?:boolean, imageUrl?:string, docUrl?:string, docMime?:string}>} refs
 * @returns {Promise<{ images: Array<{base64:string,mime:string,nombre:string}>, nota: string }>}
 */
async function collectVisualRefs(refs = []) {
  const images = []
  const avisos = []

  // Una URL cosechada no se vuelve a bajar. `forge_assets` registra el mismo objeto de R2 más de
  // una vez —medido en el proyecto de Migue: 13 filas «Convergence» para 10 archivos— y sin esto
  // la misma imagen ocupaba dos de los doce cupos y su peso se contaba dos veces.
  const vistas = new Set()

  // Presupuesto del mensaje. Se cierra el grifo ANTES de pasarse, no después: pasarse significa
  // un 413 del proveedor, y el 413 no dice cuál imagen sobró.
  let bytesB64 = 0
  let fuera    = 0

  const meter = n => {
    if (bytesB64 + n.base64.length > PRESUPUESTO_B64) {
      fuera++
      console.warn(`[vision] "${n.nombre}" fuera del presupuesto: ` +
        `${(bytesB64 / 1048576).toFixed(1)} MB ya reservados de ${(PRESUPUESTO_B64 / 1048576)} MB`)
      return false
    }
    images.push(n)
    bytesB64 += n.base64.length
    return true
  }

  for (const r of refs) {
    if (images.length >= MAX_TOTAL) break

    if (r.imageUrl) {
      if (vistas.has(r.imageUrl)) continue
      vistas.add(r.imageUrl)
      const buf = await bajar(r.imageUrl)
      const n = buf && normalizar(buf, r.label || 'image')
      if (n) meter(n)
      continue
    }

    if (r.docUrl) {
      if (vistas.has(r.docUrl)) continue
      vistas.add(r.docUrl)
      const { imgs, total } = await imagenesDeDocumento(r.docUrl, r.docMime)
      let puestas = 0
      for (const i of imgs) {
        if (images.length >= MAX_TOTAL) break
        if (meter({ ...i, nombre: `${r.label || 'document'} — ${i.nombre}` })) puestas++
      }
      if (total > puestas) {
        avisos.push(`${r.label || 'document'}: ${puestas} of ${total} embedded images included`)
      }
    }
  }

  // Que falten referencias no es lo mismo que que no existan, y el modelo tiene que poder
  // distinguirlo: sin este aviso da por completo lo que vio y afirma sobre lo que no está.
  if (fuera > 0) {
    console.warn(`[vision] ${fuera} imagen(es) fuera por presupuesto · ` +
      `${(bytesB64 / 1048576).toFixed(1)} MB en ${images.length} adjuntas`)
    avisos.push(`${fuera} further image(s) were omitted because the message size limit was reached`)
  }

  const nota = avisos.length
    ? `\n\n[VISUAL REFERENCES] ${images.length} image(s) attached to this message. ` +
      `${avisos.join('; ')}. Do not claim to have seen what is not attached.`
    : images.length
      ? `\n\n[VISUAL REFERENCES] ${images.length} image(s) attached to this message.`
      : ''

  return { images, nota }
}

module.exports = { collectVisualRefs, achicarPng, MAX_POR_DOC, MAX_TOTAL, LADO_MAX, PRESUPUESTO_B64 }
