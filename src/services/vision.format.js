// Un mismo conjunto de imágenes, en el formato que espera cada proveedor.
//
// Los tres formatos que existen hoy en el mercado:
//   · Anthropic     bloques {type:'image', source:{type:'base64', media_type, data}}
//   · OpenAI-like   bloques {type:'image_url', image_url:{url:'data:<mime>;base64,<...>'}}
//                   — lo hablan OpenAI, OpenRouter, Groq y Together
//   · Gemini        partes {inlineData:{mimeType, data}}
//
// Se centraliza acá para que agregar un proveedor sea elegir una de las tres, y para que el
// día que uno cambie su API haya un solo lugar donde mirar.

/** Proveedores capaces de recibir imágenes. Los que no están reciben solo texto. */
const CON_VISION = new Set(['anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'together'])

const soportaVision = proveedor => CON_VISION.has(proveedor)

/** Anthropic: el mensaje del usuario pasa de string a lista de bloques. */
function contenidoAnthropic(images, texto) {
  return [
    ...images.map(im => ({
      type: 'image',
      source: { type: 'base64', media_type: im.mime, data: im.base64 },
    })),
    { type: 'text', text: texto },
  ]
}

/** OpenAI y compatibles: mismo esquema de bloques, pero la imagen viaja como data URL. */
function contenidoOpenAI(images, texto) {
  return [
    ...images.map(im => ({
      type: 'image_url',
      image_url: { url: `data:${im.mime};base64,${im.base64}` },
    })),
    { type: 'text', text: texto },
  ]
}

/** Gemini: no son bloques de mensaje sino partes del contenido. */
function partesGemini(images, texto) {
  return [
    ...images.map(im => ({ inlineData: { mimeType: im.mime, data: im.base64 } })),
    { text: texto },
  ]
}

module.exports = { soportaVision, contenidoAnthropic, contenidoOpenAI, partesGemini, CON_VISION }
