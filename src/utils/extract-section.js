'use strict'

const escapar = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Extrae la sección de un output ("## <sectionName>") de un documento markdown multi-output.
 * Devuelve null si la sección no existe — el caller usa el contenido completo como fallback.
 *
 * `otherKeys` son las claves de los DEMÁS outputs del mismo nodo. Con ellas la sección termina
 * donde empieza otro output, que es el único corte que significa algo. Sin ellas se cae al corte
 * viejo —el próximo `##`, sea de quien sea—, que es correcto solo mientras el modelo no use `##`
 * para sus propios apartados.
 *
 * Ese corte a ciegas costaba caro: un 1.1 corrido como nodo entero escribe «## concept_seeds» y
 * enseguida «## Divergence Pass», así que aguas abajo viajaban 431 de 16.792 caracteres — el
 * título y la nota de paleta, sin una sola de las cinco propuestas. El 1.4 recibía eso, no
 * reconocía ningún seed y se inventaba cuatro: así un juego rítmico de saltos llegó al 2.1
 * convertido en un juego de peleas. Medido sobre la BD viva el 26-08: de 255 secciones, 72 salían
 * recortadas a un muñón de 100–400 caracteres y ninguna pierde nada con el corte por output.
 */
function extractSection(content, sectionName, otherKeys = null) {
  const startRx = new RegExp(`^##\\s+${escapar(sectionName)}\\s*$`, 'im')
  const match   = startRx.exec(content)
  if (!match) return null

  const after = content.slice(match.index + match[0].length)

  // Basta con que el caller SEPA cuáles son los otros outputs, aunque no haya ninguno: un nodo de
  // un solo output no tiene dónde cortar, y su sección es el documento entero. Ahí se caía a la
  // regla vieja y el 1.1 —que declara solo `concept_seeds`— mandaba 391 de 16.792 caracteres.
  if (Array.isArray(otherKeys)) {
    const claves = otherKeys.filter(k => k && k !== sectionName)
    // El ancla de otro output: su clave como encabezado de cualquier nivel, con o sin negrita.
    const cortes = claves
      .map(k => new RegExp(`^#{1,4}\\s+\\*{0,2}\\s*${escapar(k)}\\b`, 'im').exec(after))
      .filter(Boolean)
      .map(r => r.index)
    return (cortes.length ? after.slice(0, Math.min(...cortes)) : after).trim()
  }

  const nextSection = /^##\s+/im.exec(after)
  return nextSection ? after.slice(0, nextSection.index).trim() : after.trim()
}

module.exports = { extractSection }
