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

// Sin reescalado. Se midieron las imágenes reales del proyecto: el key art embebido en el PDF
// pesa 520 y 590 KB, el PNG más grande de la librería 1,7 MB — todas por debajo del tope de 5 MB
// del proveedor, que además reescala de su lado a 1568 px y cobra tokens sobre esa medida. O sea
// achicarlas acá no ahorraría ni un token, y `sharp` es módulo nativo: agregarlo mete riesgo de
// build en Render a cambio de nada. Si algún día entra un archivo enorme, se descarta con aviso.

// PENDIENTE — PREGUNTAR AL EQUIPO: ¿cuántas imágenes por documento es razonable?
// Provisorio en 7. El PDF de SMACK trae 2 en 4 páginas y sobra, pero un pitch deck de 40 slides
// con una foto por página se comería el contexto sin avisar: una imagen de 738x1600 cuesta
// ~1.600 tokens. Cuando haya criterio del equipo, se cambia acá y nada más.
const MAX_POR_DOC = 7
const MAX_TOTAL   = 12                 // techo del mensaje entero, sin importar de dónde vengan
const BYTES_MAX   = 4 * 1024 * 1024    // tope duro del proveedor por imagen

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

/** Un bloque listo para el proveedor: base64 + su tipo. `null` si no sirve. */
function normalizar(buffer, nombre) {
  if (!buffer?.length) return null
  if (buffer.length > BYTES_MAX) {
    console.warn(`[vision] "${nombre}" descartada: ${(buffer.length / 1048576).toFixed(1)} MB supera el tope`)
    return null
  }
  const mime = mimeDe(buffer)
  if (!mime) { console.warn(`[vision] "${nombre}" descartada: formato no reconocido`); return null }
  return { base64: buffer.toString('base64'), mime, nombre }
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

  for (const r of refs) {
    if (images.length >= MAX_TOTAL) break

    if (r.imageUrl) {
      const buf = await bajar(r.imageUrl)
      const n = buf && normalizar(buf, r.label || 'image')
      if (n) images.push(n)
      continue
    }

    if (r.docUrl) {
      const { imgs, total } = await imagenesDeDocumento(r.docUrl, r.docMime)
      for (const i of imgs) {
        if (images.length >= MAX_TOTAL) break
        images.push({ ...i, nombre: `${r.label || 'document'} — ${i.nombre}` })
      }
      if (total > imgs.length) {
        avisos.push(`${r.label || 'document'}: ${imgs.length} of ${total} embedded images included`)
      }
    }
  }

  const nota = avisos.length
    ? `\n\n[VISUAL REFERENCES] ${images.length} image(s) attached to this message. ` +
      `${avisos.join('; ')}. Do not claim to have seen what is not attached.`
    : images.length
      ? `\n\n[VISUAL REFERENCES] ${images.length} image(s) attached to this message.`
      : ''

  return { images, nota }
}

module.exports = { collectVisualRefs, MAX_POR_DOC, MAX_TOTAL }
