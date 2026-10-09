// Qué opciones de generación expone un workflow, y cómo escribirlas en su grafo.
//
// Punto 12 del informe v3 de Miguel: las opciones de los nodos están fijas en el backend y el
// usuario no puede elegirlas. Acá se descubren; no se listan a mano.
//
// La fuente de los VALORES VÁLIDOS es ComfyUI: `/api/object_info` devuelve, por clase de nodo, el
// tipo de cada campo y su lista de opciones. Escribirla a mano en el repo envejecería en silencio
// —cuando OpenAI agregue un modelo, el desplegable seguiría ofreciendo los viejos— y ComfyUI
// rechaza un valor que no está en la lista, así que el error aparecería recién al pagar la corrida.
//
// Cuatro trampas medidas el 31-08 sobre los workflows vivos:
//
//  1. No es un campo, son N. El Art Style Guide tiene 34 nodos de imagen, cada uno con su
//     `quality`, su `size` y su `model`; el Art Bible 26, el GDD 21, Environments 22. Una opción
//     del usuario se escribe en TODOS los nodos que la declaran.
//  2. `model` no siempre es un valor. En `KSampler` y `LoraLoaderModelOnly` es de tipo `MODEL`:
//     un cable del grafo. Filtrar por nombre ofrecería editar una conexión, así que se filtra por
//     el TIPO que declara object_info.
//  3. Hay dos formatos. Casi todos son planos (`quality`), pero `V57_STUDIO_2.5_Visual_pitch` los
//     anida (`model.quality`, `model.size`) igual que Tripo (`output_mode.pbr`).
//  4. `output_mode` es un combo dinámico: elegir «Textured» hace aparecer `pbr` y
//     `texture_quality`, y elegir «Geometry only» tiene que QUITARLOS — si no, se le mandan a
//     ComfyUI campos que ese modo no admite.

const BASE = () => (process.env.COMFYUI_BASE_URL || '').replace(/\/$/, '')
const KEY  = () => process.env.COMFYUI_API_KEY

// Lo que el informe pide exponer, y nada más. La lista es corta a propósito: `face_limit`,
// `orientation` o `texture_alignment` también son editables y nadie los pidió.
// Ampliada el 01-10 a pedido de Migue: «mapeen el schema completo del nodo a ese cuadro, sin
// recortar». Antes decía aquí que la lista era corta a propósito porque nadie había pedido el
// resto; ahora lo pidió.
//
// Dos cosas que NO entran, y conviene que esté dicho para que nadie las añada creyendo que faltan:
//   · `model_seed` y `texture_seed` — la semilla la inyecta el motor en cada corrida
//     (`inject_config.seed`), así que ofrecerlas sería dar un control que el sistema pisa.
//   · los cables. Se filtran por TIPO más abajo, no por nombre.
//
// `texture` es de la serie P de Tripo y absorbe a los dos de P1: `output_mode` (Geometry only /
// Textured) y `texture_quality`. Los tres conviven en la lista porque los workflows de P1 siguen
// vivos; cada grafo expone solo los que de verdad tiene.
const EXPUESTAS = new Set([
  'output_mode', 'pbr', 'texture_quality',   // 3D — Tripo P1
  'texture', 'quad',                         // 3D — Tripo serie P
  'face_limit', 'texture_alignment', 'orientation',
  'enable_image_autofix', 'auto_size', 'export_uv', 'compress_geometry',
  'quality', 'model', 'size',                // imagen
  'custom_width', 'custom_height',           // resolución, cuando `size` = Custom
  // Video — Seedance 2.5 (`ByteDance2ReferenceNodeV2`), pedido por Miguel León el 08-10.
  // Su regla: «toda capacidad de un nodo nuevo tiene que seguir disponible en Forge como control
  // editable; nada se cablea en el .json ni se recorta». Sin estos nombres el descubridor solo
  // ofrecía `model` y las otras diez quedaban fijas en el grafo, que es justo lo que pide evitar.
  'resolution', 'ratio', 'duration',
  'generate_audio', 'task_type', 'output_format',
  'auto_downscale', 'auto_upscale', 'watermark',
])

// Tipos que son un VALOR y no un cable. Sin esto, `model` de KSampler entraría como opción.
const TIPOS_VALOR = new Set(['COMBO', 'COMFY_DYNAMICCOMBO_V3', 'INT', 'FLOAT', 'BOOLEAN', 'STRING'])

// Opciones cuyo valor encarece la corrida del lado del proveedor. No se traduce a dinero: el
// sistema imputa un precio plano por imagen (0,04 USD, medido: 405 registros y un solo valor), así
// que un número por calidad sería inventado. Se marca cuál sube el costo y se dice cuántas
// imágenes son; el resto lo decide quien paga.
const ENCARECE = {
  quality:         v => v === 'medium' || v === 'high',
  output_mode:     v => v === 'Textured',
  pbr:             v => v === true,
  texture_quality: v => v === 'detailed' || v === 'extreme',
  // En la serie P, `texture` es el desplegable que reemplaza a los dos de arriba: `none` devuelve
  // malla pelada y no encarece; `standard` es 2K, `detailed` 4K y `extreme` 8K.
  texture:         v => v === 'detailed' || v === 'extreme',
  size:            v => typeof v === 'string' && /2048|3840|2160/.test(v),
  // Video: los dos ejes que mueven el precio. Un teaser de 10 s a 1080p no cuesta lo que uno de
  // 5 s a 480p, y el recuadro de coste tiene que avisarlo ANTES de despachar.
  resolution:      v => typeof v === 'string' && /720|1080|2k|4k/i.test(v),
  duration:        v => Number(v) > 5,
}

let cacheObjectInfo = null
let cacheEn = 0
const TTL = 10 * 60 * 1000

async function objectInfo () {
  if (cacheObjectInfo && Date.now() - cacheEn < TTL) return cacheObjectInfo
  const r = await fetch(`${BASE()}/api/object_info`, {
    headers: KEY() ? { Authorization: `Bearer ${KEY()}` } : {},
  })
  if (!r.ok) throw new Error(`object_info: ${r.status}`)
  cacheObjectInfo = await r.json()
  cacheEn = Date.now()
  return cacheObjectInfo
}

// La declaración de un campo, siguiendo los combos dinámicos hacia adentro. `output_mode.pbr` vive
// dentro de la rama «Textured» de `output_mode`, no al lado.
function declaracionDe (inputs, ruta) {
  const partes = ruta.split('.')
  let nivel = inputs
  let def = null
  for (const parte of partes) {
    def = nivel?.[parte]
    if (!def) return null
    const opts = def[1]?.options
    if (Array.isArray(opts) && opts.length && typeof opts[0] === 'object') {
      // Combo dinámico: sus hijos están repartidos por rama. Se busca en todas.
      const hijos = {}
      for (const rama of opts) Object.assign(hijos, rama.inputs?.required || {}, rama.inputs?.optional || {})
      nivel = hijos
    } else {
      nivel = null
    }
  }
  return def
}

// Las ramas de un combo dinámico: qué campos hace aparecer cada valor.
function ramasDe (def) {
  const opts = def?.[1]?.options
  if (!Array.isArray(opts) || !opts.length || typeof opts[0] !== 'object') return null
  const m = {}
  for (const rama of opts) {
    m[rama.key] = Object.keys({ ...(rama.inputs?.required || {}), ...(rama.inputs?.optional || {}) })
  }
  return m
}

/**
 * Las opciones que ESTE workflow expone, con su valor actual, sus valores válidos y en cuántos
 * nodos vive cada una.
 */
async function opcionesDe (workflowJson) {
  const grafo = typeof workflowJson === 'string' ? JSON.parse(workflowJson) : workflowJson
  const oi = await objectInfo()
  const porClave = new Map()

  for (const [idNodo, nodo] of Object.entries(grafo)) {
    const clase = oi[nodo.class_type]
    if (!clase) continue
    const declarados = { ...(clase.input?.required || {}), ...(clase.input?.optional || {}) }

    for (const [campo, valor] of Object.entries(nodo.inputs || {})) {
      const hoja = campo.split('.').pop()
      // Por la HOJA, no por la raíz. Con la raíz entraba `model.background` del 2.5 —que nadie
      // pidió— solo porque cuelga de `model`. La hoja deja pasar `model.quality` y `model.size`,
      // que sí están en la lista, y deja fuera al resto de esa rama.
      if (!EXPUESTAS.has(hoja)) continue
      if (Array.isArray(valor)) continue                     // es un cable, no un valor
      const def = declaracionDe(declarados, campo)
      if (!def || !TIPOS_VALOR.has(def[0])) continue          // trampa 2: `model` de KSampler

      const clave = campo
      if (!porClave.has(clave)) {
        const meta = def[1] || {}
        porClave.set(clave, {
          clave,
          etiqueta: hoja.replace(/_/g, ' '),
          tipo:     def[0] === 'COMFY_DYNAMICCOMBO_V3' ? 'COMBO' : def[0],
          valor,
          valores:  Array.isArray(meta.options)
            ? (typeof meta.options[0] === 'object' ? meta.options.map(o => o.key) : meta.options)
            : null,
          ramas:    ramasDe(def),
          ayuda:    meta.tooltip || null,
          nodos:    [],
          // Un campo anidado solo aplica cuando su padre está en la rama que lo declara.
          padre:    campo.includes('.') ? campo.split('.').slice(0, -1).join('.') : null,
        })
      }
      porClave.get(clave).nodos.push(idNodo)
    }
  }

  // El costo se dice en imágenes, no en dólares: el precio por imagen que usa el sistema es plano.
  return [...porClave.values()]
    .map(o => ({ ...o, encarece: (ENCARECE[o.clave.split('.').pop()] || (() => false)) }))
    .map(o => ({ ...o, encarece: undefined, sube_costo: o.valores ? o.valores.filter(v => o.encarece(v)) : [] }))
    .sort((a, b) => a.clave.localeCompare(b.clave))
}

/**
 * Escribe las opciones elegidas en el grafo. Devuelve cuántas escrituras hizo, para poder decir en
 * el log qué se cambió de verdad: una opción que no encuentra su nodo es un silencio caro.
 */
function aplicarOpciones (grafo, elegidas, catalogo, espejo = null) {
  if (!elegidas || !Object.keys(elegidas).length) return { escrituras: 0, avisos: [] }
  const porClave = new Map((catalogo || []).map(o => [o.clave, o]))
  let escrituras = 0
  const avisos = []

  // Solo lo ACEPTADO llega a la sincronización de ramas de más abajo. Sin esta separación, un
  // valor rechazado seguía mandando ahí: `output_mode: "__no_existe__"` no escribía nada pero
  // dejaba la rama vacía y BORRABA `pbr` y `texture_quality`, así que rechazar un valor rompía el
  // grafo. Lo encontró scripts/preflight-opciones.js, no una corrida — que habría costado.
  const validas = {}

  for (const [clave, valor] of Object.entries(elegidas)) {
    if (valor === undefined || valor === null) continue
    const def = porClave.get(clave)
    if (!def) { avisos.push(`"${clave}" no existe en este workflow`); continue }
    if (def.valores && !def.valores.includes(valor)) {
      avisos.push(`"${valor}" no es un valor válido de ${clave} (${def.valores.join(', ')})`)
      continue
    }
    validas[clave] = valor
    for (const id of def.nodos) {
      if (!grafo[id]?.inputs) continue
      grafo[id].inputs[clave] = valor
      escrituras++
    }
  }

  // Trampa 4: un combo dinámico manda sobre sus hijos. Al pasar a una rama que no los declara,
  // los campos de la otra se van; dejarlos le manda a ComfyUI entradas que ese modo no admite.
  for (const def of porClave.values()) {
    if (!def.ramas) continue
    const elegido = validas[def.clave] ?? def.valor
    const permitidos = new Set(def.ramas[elegido] || [])
    for (const id of def.nodos) {
      const inputs = grafo[id]?.inputs
      if (!inputs) continue
      for (const campo of Object.keys(inputs)) {
        if (!campo.startsWith(def.clave + '.')) continue
        // Solo el PRIMER tramo: `model.images.image_1` cuelga de `images`, que la rama sí permite.
        // Comparando la ruta entera no coincidía con nada y el campo se borraba — un input real
        // que desaparecía del grafo sin que nadie lo pidiera.
        const hoja = campo.slice(def.clave.length + 1).split('.')[0]
        if (!permitidos.has(hoja)) { delete inputs[campo]; escrituras++ }
      }
      for (const hoja of permitidos) {
        const campo = `${def.clave}.${hoja}`
        if (campo in inputs) continue
        const valor = validas[campo]
        if (valor !== undefined) { inputs[campo] = valor; escrituras++ }
      }
    }
  }

  // ── El mismo valor, en dos sitios ──
  //
  // Hay workflows donde un ajuste vive DOS veces: en el parámetro real del nodo y, además, escrito
  // en el prompt. El teaser de marketing es así — la proporción y la duración van al nodo del
  // modelo y también a sendos `CustomCombo` que el prompt concatena —, y si las dos copias
  // discrepan el modelo recibe instrucciones contradictorias: el parámetro dice 10 segundos y el
  // texto le pide cinco. Lo señaló Miguel León en su §3.3: un control, dos escrituras.
  //
  // El espejo se DECLARA en el registro del workflow (`inject_config.espejo`), no se adivina
  // buscando combos que contengan el valor. Adivinar acertaría hoy y escribiría en el combo
  // equivocado el día que dos controles compartan un valor.
  for (const [clave, destino] of Object.entries(espejo || {})) {
    const valor = validas[clave]
    if (valor === undefined) continue
    const inputs = grafo[destino.node]?.inputs
    if (!inputs) { avisos.push(`el espejo de "${clave}" apunta al nodo ${destino.node}, que no está en el grafo`); continue }
    // El texto puede no ser el valor pelado: el combo de duración lista «10s » —con el espacio
    // final— y escribir «10» dejaría una opción que no es ninguna de las suyas.
    const texto = destino.formato ? String(destino.formato).replace('{v}', String(valor)) : String(valor)
    inputs[destino.field] = texto
    escrituras++
    // Y si ese texto no está entre las opciones del combo, se añade: ofrecer una proporción que el
    // combo no lista dejaría el prompt pidiendo algo que su propia lista no admite.
    const opciones = Object.keys(inputs).filter(k => /^option\d+$/.test(k))
    if (opciones.length && !opciones.some(k => inputs[k] === texto)) {
      inputs[`option${opciones.length + 1}`] = texto
      escrituras++
    }
  }

  return { escrituras, avisos }
}

module.exports = { opcionesDe, aplicarOpciones, objectInfo }
