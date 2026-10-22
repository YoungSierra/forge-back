// ── USERREF: la referencia de Dirección de Arte (IMAGE 3 del maestro de 34, v2.9.60) ─────────────────────
//
// Cada página del maestro de 34 trae una tercera imagen además de la plantilla y del REF del pipeline: la
// referencia que Dirección de Arte aprueba para ESA página o para ESA instancia de hoja, por Add Context o por
// Design Edits (spec de Miguel León, 21-10). El registro la declara como un hueco más de `image_inputs`:
//   { node, slot: "3", source: "Art Direction reference registry", resolve: "page_instance" }
// y el REF sigue siendo solo del pipeline.
//
// Sin referencia, la página tiene que salir EXACTAMENTE como hoy (requisito de Pedro, condición del despliegue):
// sin `image_3` y sin la cláusula «IMAGE 3 = …», y con «TWO input images». No es solo el costo: en el primer render
// casi ninguna página tiene referencia, y mandarle al modelo la plantilla dos veces más un párrafo que tiene que
// ignorar puede empeorar el resultado. Además la cláusula nombra a IMAGE 2, así que sin quitarla ninguna página
// podría caer al camino de solo plantilla (`aguantaSinRef` daba 0/34).
//
// La cláusula se quita de la PLANTILLA, antes de componer (slide-composer): el compositor recorta los datos para
// que el prompt quepa en 31.000 caracteres, y con la cláusula todavía puesta el recorte caía en otro sitio y la
// página ya no era la de hoy.
'use strict'

const esUserref = h => String(h?.slot) === '3' && h?.resolve === 'page_instance'

/** El prompt sin la cláusula IMAGE 3: su línea «IMAGE 3 = …», las viñetas «- …» que la siguen y su salto final. */
function sinClausulaUserref(texto) {
  if (typeof texto !== 'string') return texto
  const m = /^IMAGE 3 = [^\n]*\n(?:- [^\n]*\n)*/m.exec(texto)
  if (!m) return texto
  return (texto.slice(0, m.index) + texto.slice(m.index + m[0].length))
    .replace(/^You are given THREE input images\./m, 'You are given TWO input images.')
}

/**
 * La referencia VIGENTE de una página o de una instancia de hoja (`page_type` + `instance_id`), entre las piezas
 * del registro compartido (`metadata.contexto`, ordenadas de la más nueva a la más vieja).
 *
 * La página se compara sin su número —el número es una posición, no una identidad— y la instancia por su id
 * estable (`TT-01`, `CHAR-02`…) o, sin id, por el nombre del ítem. Una referencia de una instancia NUNCA carga en
 * otra del mismo tipo de hoja, y una de página (sin instancia) solo carga en la página sin instanciar. Manda la
 * `primary`; sin ninguna marcada, la última aprobada. Las anteriores quedan como historial.
 */
function elegirReferencia(refs, nombrePagina, instancia = null) {
  return historialDeReferencias(refs, nombrePagina, instancia).vigente
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
const soloPagina = s => norm(String(s || '').replace(/^\d+[_\s-]*/, ''))

/**
 * Todas las piezas del registro de UNA página o instancia, de la más nueva a la más vieja, y cuál es la vigente.
 *
 * Solo cuenta el rol «Approved style reference» (spec de Miguel León §3.2): los otros roles tienen su propio
 * destino. Una pieza `retirada` (alguien quitó la referencia, §4.4) queda en el historial pero no carga: si se
 * quitan todas, la página vuelve a ir sin referencia. Al registrar una nueva, el motor se la queda como `primary`
 * y se la quita a las demás (ver `referencias-ad.service`), así que «la última aprobada gana» sale de acá.
 */
function historialDeReferencias(refs, nombrePagina, instancia = null) {
  const quiero = soloPagina(nombrePagina)
  const conInstancia = !!(instancia?.id || instancia?.item)
  const todas = (refs || []).filter(r => {
    const c = r.metadata?.contexto
    if (!c || !r.storage_url || c.estado === 'rejected' || r.status === 'rejected') return false
    if (c.rol && c.rol !== 'referencia_aprobada') return false
    if (!quiero || soloPagina(c.pagina_destino) !== quiero) return false
    return mismaInstancia(c.instancia || null, conInstancia ? instancia : null)
  })
  const activas = todas.filter(r => !r.metadata.contexto.retirada)
  const vigente = activas.find(r => r.metadata.contexto.primary) || activas[0] || null
  return { vigente, todas }
}

/** Si dos instancias son la misma: por id estable cuando las dos lo tienen, si no por el nombre del ítem. Sin instancia = la página fija. */
function mismaInstancia(a, b) {
  if (!a || !b) return !a && !b
  if (a.id && b.id) return String(a.id) === String(b.id)
  return norm(a.item) === norm(b.item)
}

module.exports = { esUserref, sinClausulaUserref, elegirReferencia, historialDeReferencias, mismaInstancia, soloPagina }
