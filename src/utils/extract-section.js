'use strict'

/**
 * Extrae la sección de un output ("## <sectionName>") de un documento markdown multi-output.
 * Devuelve null si la sección no existe — el caller usa el contenido completo como fallback.
 */
function extractSection(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const startRx = new RegExp(`^##\\s+${escaped}\\s*$`, 'im')
  const match   = startRx.exec(content)
  if (!match) return null
  const after       = content.slice(match.index + match[0].length)
  const nextSection = /^##\s+/im.exec(after)
  return nextSection ? after.slice(0, nextSection.index).trim() : after.trim()
}

module.exports = { extractSection }
