// El id que un ancla nombra: «[ IMAGE: <id> ]», o «[ IMAGE: <id> — descripción ]».
//
// Tres caminos distintos leen la misma ancla y tienen que sacar el MISMO id, o el sistema se
// desincroniza consigo mismo: `forge-canvas.routes` le dice al modelo qué ids reutilizar,
// `canvas-chat` resuelve por id qué imagen va en cada hueco, y `tools.service` la dibuja ahí
// en el PDF. Hasta el 04-09 el primero leía el cuerpo entero y los otros dos lo cortaban en el
// primer guion, así que el motor pedía «Chain-sync is the score, not the time» y el PDF después
// buscaba «Chain»: no encontraba nada, la imagen quedaba sin sitio y el corchete se imprimía.
//
// Medido sobre los 107 marcadores vivos: 26 se estaban truncando —«Full-bleed gothic-cute key
// art» se quedaba en «Full»— y 0 se rompen al dejar de cortarlos.
//
// El pie sí hay que descartarlo, pero solo cuando hay un separador DE VERDAD: em-dash o dos
// puntos rodeados de espacios. De los 107 marcadores, 26 usan el em-dash y ninguno usa el guion
// simple ni los dos puntos pegados, así que cortar por esos dos últimos solo partía ids.

// El cuerpo del ancla: hasta el `]` o, si el modelo no lo cerró, hasta el fin de la línea.
// No se exige el cierre a propósito: los sitios del PDF nunca lo exigieron y no es este el
// cambio donde ponerse estricto.
const RX_ANCLA_LINEA = /^\[\s*IMAGE\s*:\s*([^\]\n]+)/i
const RX_ANCLA = /\[\s*IMAGE\s*:\s*([^\]\n]+)/gi

// Del cuerpo al id: se descarta el pie que algunos modelos escriben después del separador.
const idDeAncla = cuerpo => String(cuerpo).split(/\s[—:]\s/)[0].trim()

// Los ids de todas las anclas de un texto, en orden.
const idsDeAnclas = txt =>
  [...String(txt).matchAll(RX_ANCLA)].map(m => idDeAncla(m[1])).filter(Boolean)

module.exports = { RX_ANCLA, RX_ANCLA_LINEA, idDeAncla, idsDeAnclas }
