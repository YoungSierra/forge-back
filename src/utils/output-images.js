// ─── Unir los mapas de output_images de varias sesiones de una instancia ─────
//
// Un output vive repartido: el despacho del motor deja sus imágenes en la sesión del output y
// iterar desde el hilo las deja en la general. Hay que elegir UNA por (clave, índice).
//
// Gana la más RECIENTE. Antes ganaba «la de más variaciones, a igualdad la que ya estaba», y eso
// devolvía la vieja: JM, 21-10, rehízo las 4 imágenes del pitch del 2.1 (una variación cada una,
// en la general) y el PDF salió con las del primer despacho (una variación cada una, en la del
// output). Mismo número de variaciones; ganó la que llegó primero.
//
// La fecha sale del nombre del archivo: todo render guarda `…-<índice>-<ms>.png`. Sin fecha
// legible en alguna de las dos, se cae a la regla de antes.

const instanteDe = it => {
  let t = 0
  for (const v of (it?.variations || [{ url: it?.url || it?.image_url }])) {
    if (!v || v.deleted) continue
    const m = /-(\d{13})\.[a-z0-9]+(?:\?|$)/i.exec(String(v.url || ''))
    if (m) t = Math.max(t, Number(m[1]))
  }
  return t
}

// ¿`nuevo` desplaza a `previo` para el mismo hueco?
function ganaSobre(nuevo, previo) {
  if (!previo) return true
  const tn = instanteDe(nuevo), tp = instanteDe(previo)
  if (tn && tp && tn !== tp) return tn > tp
  return (nuevo.variations?.length ?? 0) > (previo.variations?.length ?? 0)
}

function unirOutputImages(base, extra) {
  const out = { ...(base || {}) }
  for (const [clave, lista] of Object.entries(extra || {})) {
    if (!Array.isArray(lista)) { out[clave] = lista; continue }
    const porIndice = new Map((out[clave] || []).map(it => [it.index, it]))
    for (const it of lista) {
      const previo = porIndice.get(it.index)
      if (ganaSobre(it, previo)) porIndice.set(it.index, previo ? { ...previo, ...it } : it)
    }
    out[clave] = [...porIndice.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  }
  return out
}

module.exports = { unirOutputImages, instanteDe, ganaSobre }
