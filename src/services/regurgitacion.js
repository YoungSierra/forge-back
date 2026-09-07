// ¿La respuesta trae copiado el playbook del skill?
//
// Un skill es método: se sigue, no se emite. El system prompt ya lo dice y desde v2.9.31 la DNA
// también, pero una instrucción no es una medición. En la corrida del 3.3 del 2 de septiembre la
// respuesta fueron 139.935 caracteres de los cuales el 45% era el skill copiado literal —Purpose,
// When to use this, The method, Worked example— y el output de imagen nunca se escribió: no le
// quedó ni atención ni presupuesto.
//
// Detectarlo es barato porque la huella es inconfundible: los encabezados propios del skill,
// aparecidos como encabezados en la respuesta. No se compara el cuerpo —eso sería caro y además
// daría falsos positivos, porque el deliverable legítimamente reusa vocabulario del método—, solo
// los títulos de sus secciones.
//
// Es un aviso de conformidad, no una guarda: la respuesta ya está pagada cuando esto corre. Sirve
// para poder decir «este nodo regurgita» con un número, en vez de descubrirlo leyendo 140.000
// caracteres a mano.

// Los encabezados markdown de un texto, normalizados.
const encabezadosDe = txt => [...String(txt || '').matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)]
  .map(m => m[1].replace(/[*_`]/g, '').trim())
  .filter(Boolean)

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Un skill está partido en dos: «A · How to generate this document» es el MÉTODO, y «B · Template
// / structure to fill in» es el ENTREGABLE, cuyas secciones sí van en la respuesta. Cortar por esa
// frontera parecía suficiente y no lo es: `progression_system_design` deja *When to use this*, *The
// method* y *Output checklist* dentro de B, y son exactamente las que copió el 3.3.
//
// Así que las secciones de método se reconocen POR NOMBRE. La lista es corta y cerrada porque el
// catálogo entero de skills usa la misma plantilla, y ninguno de estos títulos es jamás una sección
// de un entregable: nadie entrega un documento con un capítulo llamado «Common mistakes».
//
// Lo contrario —tomar todos los encabezados del skill— acusa a los nodos que trabajan bien:
// medido, marcaba a 2.1 por «The ask» y a 2.2 por «Fact Sheet», que son las secciones del
// documento que esos nodos deben producir.
const META = [
  'how to generate this document', 'principles', 'principles read before building',
  'default output format', 'visual identity', 'structure', 'quality bar',
  'when to use this', 'inputs the user needs', 'inputs you need', 'the method step by step',
  'the method', 'worked example', 'output checklist', 'common mistakes', 'companion artifacts',
  'playbook method', 'image handling', 'how to use this template', 'template structure to fill in',
].map(norm)

// ¿Este encabezado es una sección de método? Se compara por prefijo porque los títulos vienen con
// coletillas —«Worked example *(illustrative — invented game, do not reuse)*»— que el modelo copia
// enteras o recorta a gusto.
const esMeta = enc => {
  const k = norm(enc)
  return META.some(m => k === m || k.startsWith(m + ' ') || m.startsWith(k + ' '))
}

// Las secciones de método que los skills de ESTA corrida traen de verdad. Se descartan las que el
// nodo declara como outputs: si un output se llamara igual, su sección es legítima.
function huellaDeSkills(textosDeSkills, clavesDeOutputs = []) {
  const prohibidas = new Set(clavesDeOutputs.map(norm))
  const h = new Set()
  for (const t of textosDeSkills || []) for (const e of encabezadosDe(t)) {
    const k = norm(e)
    if (k.length < 4 || prohibidas.has(k) || !esMeta(e)) continue
    h.add(k)
  }
  return [...h]
}

// Cuántos de esos encabezados reaparecen COMO ENCABEZADOS en la respuesta.
// El umbral es tres: uno puede ser coincidencia de vocabulario, tres seguidos es el playbook.
function detectarRegurgitacion(respuesta, huella, umbral = 3) {
  if (!huella?.length) return null
  // Se compara por prefijo, igual que al armar la huella: el modelo copia el título con su
  // coletilla o sin ella, y las dos formas son el mismo encabezado copiado.
  const enRespuesta = encabezadosDe(respuesta).map(norm)
  const repetidos = huella.filter(h => enRespuesta.some(e => e === h || e.startsWith(h + ' ')))
  if (repetidos.length < umbral) return null
  return {
    repetidos,
    total: enRespuesta.length,
    motivo: `la respuesta reproduce ${repetidos.length} encabezado(s) del skill como secciones propias`
      + ` (${repetidos.slice(0, 6).join(', ')}${repetidos.length > 6 ? ', …' : ''})`,
  }
}

module.exports = { encabezadosDe, huellaDeSkills, detectarRegurgitacion }
