'use strict'

// Título de un ítem, normalizado para comparar ENTRE nodos y entre formatos.
//
// El mismo seed aparece escrito de maneras distintas según quién lo emita:
//   "### 1. SMACK: Drift"                (1.1, encabezado numerado)
//   "- **SMACK: Drift** — advances…"     (1.4, viñeta con negrita y guion largo)
//   "- SMACK: Drift: A meditative…"      (1.4, viñeta con la descripción pegada)
// Los tres son el mismo ítem. Se recorta la decoración, se corta en el primer separador de
// descripción y se deja solo la parte que identifica: "smack drift".
//
// Se conservan DOS segmentos de dos puntos porque el nombre puede contener uno —"SMACK: Drift"—
// y quedarse con el primero convertiría todos los seeds de un juego en el mismo título. Es el
// mismo problema que dejaba los dos lanes llamados "SMACK".
function tituloDeItem(texto) {
  return String(texto || '')
    .replace(/^[\s\-*#>]+/, '')        // viñeta, almohadilla, cita
    .replace(/^\d+[.)]\s*/, '')        // ordinal "1." o "1)"
    .replace(/\*+/g, '')               // negritas
    // La descripción va tras un guion. Se acepta el largo Y el corto: el maquetador del PDF
    // pasa el texto por un saneado WinAnsi que convierte "—" en "-", así que para cuando se
    // compara contra el documento ya no queda ninguno largo. Sin esto el título se llevaba
    // puesta la justificación entera y no coincidía con nada.
    .split(/\s+[—–-]\s+|\n/)[0]
    .split(':').slice(0, 2).join(':')  // "SMACK: Drift: A meditative…" → "SMACK: Drift"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

module.exports = { tituloDeItem }
