// ─── Medidas de un .glb, sin abrirlo entero ──────────────────────────────────
//
// Un `.glb` es un contenedor: cabecera de 12 bytes, un chunk JSON con toda la estructura, y
// después el binario con la geometría. El JSON declara, por cada accessor de POSITION, el `min` y
// el `max` de cada eje — la caja envolvente, escrita por quien exportó el archivo. Así que la
// medida se lee pidiendo los primeros kilobytes y sin descargar el modelo.
//
// Medido el 10-09 sobre los seis modelos almacenados: el chunk JSON pesa entre 1,1 y 2,1 KB
// contra archivos de decenas de MB. Un `Range` de 64 KB sobra.
//
// PARA QUÉ. El escalado del kit necesita saber cuánto mide HOY cada modelo para calcular el factor
// (`medida_real_objetivo / dimensión_actual`). Sin esto habría que medir cada asset dentro de
// Blender y devolver el dato — un viaje de ida y vuelta que no hace falta.
//
// LAS UNIDADES SON LAS DEL ARCHIVO, no metros. Y el eje vertical es **Y**: glTF es Y-up, Blender
// es Z-up y convierte al importar. Por eso lo medido se guarda diciendo en qué convención está;
// confundirlas aplica el factor al eje equivocado.

const CABECERA = 65536          // cuánto se pide: la cabecera y el chunk JSON entran de sobra
const MAGIC_GLTF = 0x46546c67   // "glTF"
const MAGIC_JSON = 0x4e4f534a   // "JSON"

const sinTransformacion = n => !n.matrix && !n.scale && !n.rotation && !n.translation

/** Lee la cabecera y el chunk JSON de un `.glb` remoto. */
async function leerEstructura(url) {
  const r = await fetch(url, { headers: { Range: `bytes=0-${CABECERA - 1}` } })
  if (!r.ok) throw new Error(`no se pudo leer el modelo: HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  // Si el origen ignora el Range devuelve el archivo entero: mejor cortar que tragarse 55 MB.
  if (buf.length > CABECERA * 2) throw new Error('el origen no respetó el Range')
  if (buf.length < 20 || buf.readUInt32LE(0) !== MAGIC_GLTF) throw new Error('no es un .glb')

  const largo = buf.readUInt32LE(12)
  if (buf.readUInt32LE(16) !== MAGIC_JSON) throw new Error('el primer chunk no es JSON')
  if (largo > buf.length - 20) throw new Error(`el chunk JSON mide ${largo} y no entra en la cabecera pedida`)
  return JSON.parse(buf.slice(20, 20 + largo).toString('utf8'))
}

/**
 * Caja envolvente de un `.glb`, en las unidades del propio archivo.
 *
 * La caja sale de UNIR los accessors de POSITION de todas las primitivas. Eso es exacto mientras
 * los nodos no traigan transformación propia — que es el caso de todo lo que Forge almacena hoy
 * (seis de seis: una malla, un nodo, sin transformaciones). Si aparece un modelo con nodos
 * transformados, la unión deja de ser la caja real: se devuelve igual, pero marcada
 * `exacta: false`, porque un número silenciosamente equivocado es peor que uno con etiqueta.
 */
async function medirGlb(url) {
  const g = await leerEstructura(url)

  const accesores = new Set()
  let primitivas = 0
  for (const m of g.meshes || []) {
    for (const p of m.primitives || []) {
      primitivas++
      if (p.attributes?.POSITION !== undefined) accesores.add(p.attributes.POSITION)
    }
  }
  if (!accesores.size) throw new Error('el modelo no declara ninguna posición de vértice')

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let sinCaja = 0
  for (const i of accesores) {
    const acc = g.accessors?.[i]
    if (!acc?.min || !acc?.max) { sinCaja++; continue }
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], acc.min[k])
      max[k] = Math.max(max[k], acc.max[k])
    }
  }
  if (!Number.isFinite(min[0])) throw new Error('ningún accessor de posición declara min/max')

  const transformados = (g.nodes || []).filter(n => !sinTransformacion(n)).length
  const dim = max.map((v, k) => redondear(v - min[k]))
  const ejes = ['x', 'y', 'z']

  return {
    // glTF es Y-up: el alto de un personaje es `y`. Blender convierte al importar, así que quien
    // aplique el factor tiene que saber en qué convención se midió.
    convencion: 'gltf_y_up',
    unidades: 'archivo',
    dim: { x: dim[0], y: dim[1], z: dim[2] },
    alto: dim[1],
    min: { x: redondear(min[0]), y: redondear(min[1]), z: redondear(min[2]) },
    max: { x: redondear(max[0]), y: redondear(max[1]), z: redondear(max[2]) },
    // La base del objeto en Y: es el punto que la convención de pivote necesita.
    base_y: redondear(min[1]),
    eje_mayor: ejes[dim.indexOf(Math.max(...dim))],
    mallas: (g.meshes || []).length,
    primitivas,
    nodos: (g.nodes || []).length,
    nodos_transformados: transformados,
    exacta: transformados === 0 && sinCaja === 0,
    ...(sinCaja ? { accessors_sin_min_max: sinCaja } : {}),
    medido_en: new Date().toISOString(),
  }
}

const redondear = v => Math.round(v * 1e6) / 1e6

/**
 * Mide un activo y deja el resultado guardado en su metadata. Vuelve a medir solo si hace falta:
 * la caja de un archivo no cambia, y el archivo tampoco — cada render escribe una ruta nueva.
 */
async function medirActivo(db, asset, { forzar = false } = {}) {
  if (!forzar && asset.metadata?.medidas) return asset.metadata.medidas
  if (!asset.storage_url) throw new Error('el activo no tiene archivo')
  if (asset.format && asset.format !== 'glb') throw new Error(`no es un modelo (formato ${asset.format})`)

  const medidas = await medirGlb(asset.storage_url)
  const { error } = await db().from('forge_assets')
    .update({ metadata: { ...(asset.metadata || {}), medidas } })
    .eq('id', asset.id)
  if (error) throw error
  return medidas
}

module.exports = { medirGlb, medirActivo, leerEstructura }
