// ─── El paquete que Forge le entrega a Blender ───────────────────────────────
//
// JSON #2 del proceso: el bundle `montaje/1.0`. Es lo último que hace Forge en este tramo —
// después el addon de LoopForge escala, recentra e instancia, y Forge no vuelve a intervenir
// hasta que el `.glb` del nivel montado entra al moodboard.
//
// La carpeta es la forma canónica del contrato y un `.zip` de esa carpeta es el mismo bundle, así
// que se entrega comprimido: es un archivo que alguien baja.
//
//   bundle.json                  manifiesto, con el inventario y su sha256
//   montaje/orden_de_montaje.json  qué se coloca y dónde
//   montaje/kit.json               cómo es cada asset
//   montaje/validacion.json        qué se comprobó
//   modelos/<asset_id>.glb         un archivo por asset
//
// Lo que Forge puede llenar solo y lo que no:
//
//   bbox de tres ejes        ✓  se lee del propio `.glb` (glb-medidas)
//   `offset_horneado`        ✓  ceros: los assets pasan por Tool 1, que recentra el pivote
//   `eje_largo`              ✓  el eje mayor del bbox, que es lo que decide la rotación del muro
//   `superficies_planas`     ✗  no sale del bbox — `bbox_max` nunca es la tapa real de una mesa.
//                               Se deja vacío A PROPÓSITO: ningún topper se apoya ahí, y eso es
//                               mejor que inventar una altura y dejar objetos flotando.
//   gramática                ✗  qué pieza juega cada papel estructural es una decisión de arte,
//                               no una medición. Nada en la geometría dice cuál muro es el
//                               exterior. Sin ella el montaje sale con cero objetos.

const crypto = require('crypto')
const archiver = require('archiver')

const CONTRATO = 'montaje/1.0'

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

/**
 * Un id de archivo a partir del nombre humano de un activo.
 *
 * El tope de 60 caracteres no puede ser un corte a secas. Forge nombra por PROCEDENCIA —«Art
 * Style Guide — 29_EnvironmentSheet — Concept art — parte_01 — 3D production»— así que lo que
 * distingue a dos piezas hermanas vive al FINAL del nombre, justo donde caía la tijera: medido
 * sobre los nombres vivos, 4 de 6 modelos llegaban al tope y dos páginas ya colapsaban al mismo
 * id. Cuando hay que cortar se deja sitio para la huella del nombre completo.
 */
const slugDe = nombre => {
  const limpio = String(nombre)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[—–-]\s*/g, '_')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_').replace(/^_|_$/g, '')
    .toLowerCase()
  if (!limpio) return 'asset'
  if (limpio.length <= 60) return limpio
  return `${limpio.slice(0, 53)}_${sha256(String(nombre)).slice(0, 6)}`
}

/**
 * El `kit.json` que consume el montaje, armado desde lo que Forge ya midió.
 *
 * `activos` son filas de `forge_assets` con `metadata.medidas` (las escribe glb-medidas), y
 * `escala` es el `kit_scale_spec.json` cuando existe: de ahí sale el factor, para que las
 * dimensiones declaradas sean las que el asset VA A TENER después de Tool 1, no las que tiene
 * ahora. Declarar las de ahora dejaría al montaje colocando piezas de un tamaño y a Blender
 * instanciando otro.
 */
function kitDesdeMedidas(activos, escala = null, gramaticaClases = {}) {
  const porId = {}
  const inventario = []

  for (const a of activos) {
    const m = a.metadata?.medidas
    if (!m?.dim) continue
    // Dos nombres distintos pueden dar el mismo slug sin llegar al tope —«… — visual_pitch» y
    // «… — Visual Pitch» son nueve pares en la base de hoy— y en un kit eso no es un id feo: es
    // un modelo pisando al otro sin decirlo. El segundo se desempata con su huella.
    let id = slugDe(a.name)
    if (porId[`${id}.glb`]) id = `${id.slice(0, 53)}_${sha256(a.id).slice(0, 6)}`
    const objetoEscala = escala?.objetos
      ? Object.values(escala.objetos).find(o => o.forge_asset_id === a.id)
      : null
    const f = objetoEscala?.factor ?? 1

    // La caja se lee en la convención del archivo (Y arriba) y el montaje trabaja en la de
    // Blender (Z arriba). Se convierte acá, una vez, en vez de dejar que cada consumidor adivine.
    const dim = [m.dim.x * f, m.dim.z * f, m.dim.y * f]
    const min = [m.min.x * f, m.min.z * f, m.min.y * f]
    const max = [m.max.x * f, m.max.z * f, m.max.y * f]

    porId[`${id}.glb`] = {
      coleccion: id.toUpperCase(),
      clase: gramaticaClases[id] || objetoEscala?.clase || 'piso_libre',
      uso: a.name,
      // Decide la rotación de un muro: sin esto una pieza puede salir girada 90°.
      eje_largo: dim[0] >= dim[1] ? 'X' : 'Y',
      dim: dim.map(v => +v.toFixed(4)),
      bbox_min: min.map(v => +v.toFixed(4)),
      bbox_max: max.map(v => +v.toFixed(4)),
      // Cero por contrato: Tool 1 recentra el pivote en (centro x, centro y, base z).
      offset_horneado: [0, 0, 0],
      // Vacío a propósito — ver la nota de arriba.
      superficies_planas: [],
      forge_asset_id: a.id,
      forge_asset_nombre: a.name,
    }
    inventario.push({ asset_id: id, url: a.storage_url, nombre: a.name })
  }

  return { assets: porId, inventario }
}

/**
 * Arma el `.zip` del bundle. Devuelve el buffer, para que quien llame decida si lo sube a R2 o lo
 * manda por la respuesta.
 */
async function armarZip({
  bundle, orden, kit, validacion, modelos, shell = null, planta = null,
  // Lo que pide el documento de JuanK del 18-09 y no viajaba: la documentación del nivel, la
  // lámina del Environment Sheet, una imagen de diseño por asset y las medidas del GDD.
  //
  // Su razón para las imágenes, literal: «realmente me ayudan a identificar y redimensionar los
  // modelos». Un `.glb` abierto en Blender es una malla gris sin contexto; la imagen de la que
  // salió dice qué es y cómo de grande debería ser.
  documentos = [], laminaSheet = null, imagenes = [], medidas = null,
}) {
  const zip = archiver('zip', { zlib: { level: 9 } })
  const trozos = []
  zip.on('data', t => trozos.push(t))
  const listo = new Promise((res, rej) => { zip.on('end', res); zip.on('error', rej) })

  zip.append(JSON.stringify(bundle, null, 2), { name: 'bundle.json' })
  zip.append(JSON.stringify(orden, null, 2), { name: 'montaje/orden_de_montaje.json' })
  zip.append(JSON.stringify(kit, null, 2), { name: 'montaje/kit.json' })
  zip.append(JSON.stringify(validacion, null, 2), { name: 'montaje/validacion.json' })

  // Cada asset con su imagen y su modelo BAJO EL MISMO NOMBRE BASE, que es lo que permite
  // emparejarlos al abrir el `.zip`. El nombre lo trae el modelo; si dos chocaran, el segundo
  // lleva su id detrás — renombrar en silencio dos cosas igual sería peor que un nombre feo.
  const usados = new Set()
  for (const m of modelos) {
    let base = m.base || m.asset_id
    if (usados.has(base)) base = `${base}__${String(m.asset_id).slice(0, 8)}`
    usados.add(base)
    m.base_final = base
    zip.append(m.buffer, { name: `assets/modelos/${base}.glb` })
  }
  for (const img of imagenes) {
    const m = modelos.find(x => x.asset_id === img.asset_id)
    const base = m?.base_final || img.base || img.asset_id
    zip.append(img.buffer, { name: `assets/imagenes/${base}${img.ext || '.png'}` })
  }

  for (const d of documentos) zip.append(d.contenido, { name: `level_design/${d.nombre}` })
  if (laminaSheet) zip.append(laminaSheet.buffer, { name: `environment_sheet/${laminaSheet.nombre}` })
  if (medidas) zip.append(JSON.stringify(medidas, null, 2), { name: 'medidas.json' })

  // La carpeta de referencia no la consume nadie: existe para que un humano entienda el bundle
  // sin abrir Blender.
  if (shell) zip.append(JSON.stringify(shell, null, 2), { name: 'referencia/shell.json' })
  if (planta) zip.append(planta, { name: 'referencia/planta.png' })

  zip.finalize()
  await listo
  return Buffer.concat(trozos)
}

/**
 * El nombre de un asset convertido en nombre de archivo.
 *
 * Sin tildes y sin espacios: el `.zip` se abre en Windows, en macOS y en Linux, y una `ó` en una
 * ruta es un problema de codificación esperando a pasar — lo mismo que ya anotó JuanK para el
 * `Cartón` de los videos.
 */
function nombreDeArchivo(nombre) {
  return String(nombre || '')
    .split(/\s+[—–]\s+/).pop()          // solo el nombre propio, no el documento ni la cadena
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

/** Baja los `.glb` del inventario y calcula su huella, que es lo que el manifiesto declara. */
async function traerModelos(inventario) {
  const modelos = []
  for (const it of inventario) {
    const r = await fetch(it.url)
    if (!r.ok) throw new Error(`no se pudo bajar «${it.nombre}»: HTTP ${r.status}`)
    const buffer = Buffer.from(await r.arrayBuffer())
    // El nombre LEGIBLE del asset, que es con el que viaja al `.zip`. Antes el archivo se llamaba
    // como su UUID: emparejar un modelo con su imagen funcionaba, pero quien abre el paquete en
    // Blender no distingue un muro de una silla — y el documento de JuanK pide justamente poder
    // identificarlos. El id queda igual en el manifiesto, que es donde hace falta.
    modelos.push({
      asset_id: it.asset_id, buffer, bytes: buffer.length, sha256: sha256(buffer),
      base: nombreDeArchivo(it.nombre) || it.asset_id,
    })
  }
  return modelos
}

function manifiesto({ level_id, modelos, alturaJugador, fuenteAltura, escalaSpec }) {
  return {
    contrato: CONTRATO,
    bundle_id: `${level_id}__${new Date().toISOString().replace(/[:.]/g, '-')}`,
    level_id,
    generado_por: 'Forge',
    generado_en: new Date().toISOString(),
    convencion_ejes: 'Z_up_metros',
    escala_referencia: {
      altura_personaje_m: alturaJugador,
      fuente: fuenteAltura,
      _nota: 'No escala nada por sí sola: es el ancla contra la que se declaran las dimensiones.',
    },
    montaje: {
      orden: 'montaje/orden_de_montaje.json',
      kit: 'montaje/kit.json',
      validacion: 'montaje/validacion.json',
    },
    modelos: {
      carpeta: 'assets/modelos',
      formato: 'glb',
      // `archivo` sale del nombre con el que el modelo viajó de verdad, no de una plantilla: dos
      // assets con el mismo nombre desempatan al empaquetar, y el manifiesto tiene que decir
      // dónde quedó cada uno. Y va `imagen`, que es lo que empareja el modelo con su lámina.
      inventario: modelos.map(m => ({
        asset_id: m.asset_id,
        archivo: `assets/modelos/${m.base_final || m.base || m.asset_id}.glb`,
        imagen: m.imagen_ext ? `assets/imagenes/${m.base_final || m.base || m.asset_id}${m.imagen_ext}` : null,
        sha256: m.sha256, bytes: m.bytes,
      })),
    },
    // Trazabilidad: de dónde salió la escala con la que se declararon esas dimensiones.
    ...(escalaSpec ? { kit_scale_spec: { kit_id: escalaSpec.kit_id, ancla: escalaSpec.ancla } } : {}),
  }
}

module.exports = { CONTRATO, slugDe, kitDesdeMedidas, armarZip, traerModelos, manifiesto, sha256 }
