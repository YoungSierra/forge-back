// ─── Miniaturas de las láminas, hechas acá ───────────────────────────────────
//
// El lienzo pinta tarjetas de 300 px con archivos de 1 MB. Reducirlas lo hacía el optimizador de
// Vercel (`next/image`), hasta que el 16-09 empezó a contestar
//
//     HTTP 402 · x-vercel-error: OPTIMIZED_IMAGE_REQUEST_PAYMENT_REQUIRED
//
// a toda imagen que no tuviera ya en caché: se agotó la cuota del plan. El síntoma no fue un
// error visible sino el marco VACÍO en las páginas recién generadas —las viejas seguían viéndose
// porque estaban cacheadas—, y desde afuera parecía que el workflow no publicaba nada. Es lo que
// reportó Miguel como «New Angle no genera el output»: el PNG estaba en R2, entero y correcto.
//
// Así que la reducción se hace acá y el resultado se guarda en R2 junto al original. No hay cuota
// que se agote, la imagen la sirve R2 directo (su salida no se cobra) y el navegador la cachea
// para siempre porque la ruta incluye el ancho y el original nunca cambia de nombre.
//
// Las 665 imágenes del sistema son PNG —medido, no supuesto—, así que `pngjs`, que ya estaba
// instalado, alcanza. Si alguna vez entra un jpg, no se rompe nada: no se puede reducir y se
// devuelve el original, que es exactamente lo que pasaba antes.

const { PNG } = require('pngjs')
const { uploadToStorage } = require('./storage.service')

const PUBLICO = () => String(process.env.CF_R2_PUBLIC_URL || '').replace(/\/$/, '')

// Dos anchos y no cualquiera: cada ancho es una copia más en el bucket. 600 es la tarjeta y 1200
// es la tarjeta con el lienzo acercado, que es cuando se leen las páginas de la guía de estilo.
const ANCHOS = [600, 1200]
const anchoValido = w => (ANCHOS.includes(Number(w)) ? Number(w) : ANCHOS[0])

/** La llave dentro del bucket, o null si la dirección no es nuestra.
 *
 *  Es también el control de seguridad: sin él, esta ruta sería un proxy abierto al que se le pide
 *  cualquier dirección de internet. Solo se toca lo que está en nuestro propio R2 público. */
function claveDe(url) {
  const base = PUBLICO()
  const u = String(url || '')
  if (!base || !u.startsWith(base + '/')) return null
  const clave = u.slice(base.length + 1).split('?')[0]
  return clave && !clave.includes('..') ? clave : null
}

const claveMiniatura = (clave, ancho) => `thumbs/${ancho}/${clave}`

/**
 * Reduce por promedio de área (no por muestreo).
 *
 * Tomar un píxel de cada N deja los bordes dentados y el texto de las páginas ilegible; promediar
 * la caja entera es lo que hace que una lámina de 1024 se lea a 600. El promedio va con el alfa
 * premultiplicado: sin eso, un píxel transparente arrastra su color al vecino y las piezas
 * recortadas —lo que sale de Segmentación— quedan con una orla oscura.
 */
function reducir(src, anchoDestino) {
  const w = src.width, h = src.height
  if (w <= anchoDestino) return null                       // ya es más chica que la tarjeta
  const W = anchoDestino
  const H = Math.max(1, Math.round(h * (W / w)))
  const out = new PNG({ width: W, height: H })
  const fx = w / W, fy = h / H

  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.min(h, Math.max(y0 + 1, Math.ceil((y + 1) * fy)))
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.min(w, Math.max(x0 + 1, Math.ceil((x + 1) * fx)))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) << 2
          const al = src.data[i + 3] / 255
          r += src.data[i] * al; g += src.data[i + 1] * al; b += src.data[i + 2] * al
          a += src.data[i + 3]; n++
        }
      }
      const j = (y * W + x) << 2
      const am = a / n                                     // alfa medio, 0..255
      const k = am > 0 ? n * (am / 255) : 1                // se desmultiplica con el alfa medio
      out.data[j]     = Math.round(r / k)
      out.data[j + 1] = Math.round(g / k)
      out.data[j + 2] = Math.round(b / k)
      out.data[j + 3] = Math.round(am)
    }
  }
  return out
}

// Una misma lámina se pide desde muchas tarjetas a la vez —y al abrir el lienzo, veinte a la vez—.
// Sin esto, el primer arranque bajaba, decodificaba y subía la MISMA imagen varias veces en
// paralelo. Se comparte la promesa y todas esperan a la primera.
const enVuelo = new Map()

// Y de las que SÍ son distintas, solo tres a la vez.
//
// Un PNG decodificado ocupa ancho × alto × 4 en memoria: una lámina de 2048 son 16 MB. Veinte
// tarjetas abriendo el lienzo al mismo tiempo pedían 300 MB de golpe, y la instancia del back
// tiene 512. No es una optimización: sin el cupo, abrir un proyecto grande la mata. Esperar es
// barato porque cada lámina se construye UNA vez en la vida.
const CUPO = 3
let corriendo = 0
const cola = []

function turno() {
  if (corriendo < CUPO) { corriendo++; return Promise.resolve() }
  return new Promise(listo => cola.push(listo))
}
function soltar() {
  const siguiente = cola.shift()
  if (siguiente) siguiente()
  else corriendo--
}

async function existe(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
    return r.ok
  } catch { return false }
}

async function construir(clave, ancho, urlOriginal, urlMiniatura) {
  const r = await fetch(urlOriginal, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`no se pudo leer el original (${r.status})`)
  const buf = Buffer.from(await r.arrayBuffer())

  const chica = reducir(PNG.sync.read(buf), ancho)
  if (!chica) return urlOriginal                           // ya era chica: no se duplica en el bucket

  const png = PNG.sync.write(chica, { deflateLevel: 9 })
  await uploadToStorage(png, claveMiniatura(clave, ancho), 'image/png')
  console.log(`[miniatura] ${clave} → ${ancho}px · ${(buf.length / 1024 | 0)}KB → ${(png.length / 1024 | 0)}KB`)
  return urlMiniatura
}

/**
 * La dirección con la que pintar esta lámina en una tarjeta. La construye la primera vez que
 * alguien la pide y después la sirve R2.
 *
 * Nunca lanza hacia afuera por un fallo de reducción: si algo sale mal se devuelve el original.
 * Una tarjeta con la imagen pesada se ve; una tarjeta con un error no.
 */
async function miniaturaDe(url, anchoPedido) {
  const ancho = anchoValido(anchoPedido)
  const clave = claveDe(url)
  if (!clave) { const e = new Error('That address is not ours'); e.code = 'AJENA'; throw e }

  const urlMiniatura = `${PUBLICO()}/${claveMiniatura(clave, ancho)}`
  const cacheKey = `${ancho}:${clave}`

  if (enVuelo.has(cacheKey)) return enVuelo.get(cacheKey)

  const tarea = (async () => {
    // La comprobación va fuera del cupo: es una cabecera contra R2 y es el camino de TODOS los
    // días. El cupo protege lo caro —bajar, decodificar y subir—, que solo pasa la primera vez.
    if (await existe(urlMiniatura)) return urlMiniatura
    await turno()
    try { return await construir(clave, ancho, url, urlMiniatura) }
    catch (e) { console.warn(`[miniatura] ${clave}: ${e.message} — se sirve el original`); return url }
    finally { soltar() }
  })().finally(() => setTimeout(() => enVuelo.delete(cacheKey), 1000))

  enVuelo.set(cacheKey, tarea)
  return tarea
}

module.exports = { miniaturaDe, claveDe, reducir, ANCHOS }
