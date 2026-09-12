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

/** Un id de archivo a partir del nombre humano de un activo. */
const slugDe = nombre => String(nombre)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s*[—–-]\s*/g, '_')
  .replace(/[^A-Za-z0-9_]+/g, '_')
  .replace(/_+/g, '_').replace(/^_|_$/g, '')
  .toLowerCase().slice(0, 60) || 'asset'

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
    const id = slugDe(a.name)
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
async function armarZip({ bundle, orden, kit, validacion, modelos, shell = null, planta = null }) {
  const zip = archiver('zip', { zlib: { level: 9 } })
  const trozos = []
  zip.on('data', t => trozos.push(t))
  const listo = new Promise((res, rej) => { zip.on('end', res); zip.on('error', rej) })

  zip.append(JSON.stringify(bundle, null, 2), { name: 'bundle.json' })
  zip.append(JSON.stringify(orden, null, 2), { name: 'montaje/orden_de_montaje.json' })
  zip.append(JSON.stringify(kit, null, 2), { name: 'montaje/kit.json' })
  zip.append(JSON.stringify(validacion, null, 2), { name: 'montaje/validacion.json' })
  for (const m of modelos) zip.append(m.buffer, { name: `modelos/${m.asset_id}.glb` })
  // La carpeta de referencia no la consume nadie: existe para que un humano entienda el bundle
  // sin abrir Blender.
  if (shell) zip.append(JSON.stringify(shell, null, 2), { name: 'referencia/shell.json' })
  if (planta) zip.append(planta, { name: 'referencia/planta.png' })

  zip.finalize()
  await listo
  return Buffer.concat(trozos)
}

/** Baja los `.glb` del inventario y calcula su huella, que es lo que el manifiesto declara. */
async function traerModelos(inventario) {
  const modelos = []
  for (const it of inventario) {
    const r = await fetch(it.url)
    if (!r.ok) throw new Error(`no se pudo bajar «${it.nombre}»: HTTP ${r.status}`)
    const buffer = Buffer.from(await r.arrayBuffer())
    modelos.push({ asset_id: it.asset_id, buffer, bytes: buffer.length, sha256: sha256(buffer) })
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
      carpeta: 'modelos',
      formato: 'glb',
      inventario: modelos.map(m => ({
        asset_id: m.asset_id, archivo: `modelos/${m.asset_id}.glb`, sha256: m.sha256, bytes: m.bytes,
      })),
    },
    // Trazabilidad: de dónde salió la escala con la que se declararon esas dimensiones.
    ...(escalaSpec ? { kit_scale_spec: { kit_id: escalaSpec.kit_id, ancla: escalaSpec.ancla } } : {}),
  }
}

module.exports = { CONTRATO, slugDe, kitDesdeMedidas, armarZip, traerModelos, manifiesto, sha256 }
