// ─── El pack de animación que Forge le entrega a Blender + LoopForge ─────────
//
// Fase 5 del proceso de JuanK (`Animation_For_Moodboard`, 18-09), pedida en su informe v3 punto 3,
// reiterada en v5 y subida a prioridad ALTA en v6. Es el gemelo del paquete de nivel: Forge reúne
// lo que YA tiene generado y aprobado, y no calcula nada. El rig y la animación se hacen fuera.
//
// La FORMA de la carpeta no es una elección nuestra: la fija la skill
// `blender-loopforge-character-pipeline`, que él nos pasó. Es plana, y el proceso lee de ella dos
// cosas y solo dos:
//
//     <Nombre>/
//     ├── <Nombre>.glb        el personaje en bind-pose. De acá sale el «nombre de trabajo»
//     ├── <Movimiento>.mp4    uno por movimiento. El NOMBRE DEL ARCHIVO es el nombre del clip:
//     ├── <Movimiento>.mp4    «si aparece Jump.mp4, se produce un clip Jump»
//     ├── AnimationSheet.png  extra nuestro (Fase 5), el proceso lo ignora
//     └── clips.json          extra nuestro (Fase 5): tiempos, reglas y el prompt que se usó
//
// `Output resources/` NO se crea acá: la crea su proceso.
//
// Dos reglas heredadas del paquete de nivel, por las mismas razones:
//   · lo que entra, entra completo o no entra. Una pieza que no se puede bajar se declara ausente
//     con su motivo, nunca se omite en silencio ni se rellena con otra cosa.
//   · el zip queda como pieza del proyecto, para que se pueda volver a bajar sin re-armarlo.

const crypto = require('crypto')
const archiver = require('archiver')

const CONTRATO = 'forge_animation_pack/1.0'

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

const norma = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Nombre de archivo seguro y legible. Se conservan las mayúsculas y los `_` porque el nombre del
 *  archivo ES el nombre del clip del otro lado: «Idle_Sleepy.mp4» → clip `Idle_Sleepy`. */
const archivoDe = s => String(s || 'clip')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w.\- ]+/g, '')
  .trim().replace(/\s+/g, '_')
  .slice(0, 60) || 'clip'

async function bajar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`could not download (${r.status})`)
  const buf = Buffer.from(await r.arrayBuffer())
  return { buffer: buf, bytes: buf.length, sha256: sha256(buf) }
}

const falta = (mensaje, code = 'FALTA') => { const e = new Error(mensaje); e.code = code; return e }

/** Los segundos que el propio documento declara para un clip, o null.
 *
 *  El listado de tiempos es la mitad de lo que JuanK pide en la Fase 5, y el Vertical Slice los
 *  escribe dentro del paréntesis de cada movimiento: «2.0 s loop», «0.4 s throw animation»,
 *  «400 ms, one-shot». No se estiman: si el documento no lo dice, va null y el otro lado mide la
 *  duración del vídeo, que es lo que su pipeline hace de todas formas. */
function segundosDe(clip) {
  const t = String(clip?.reglas || clip?.etiqueta || '')
  const ms = t.match(/(\d+(?:[.,]\d+)?)\s*ms\b/i)
  if (ms) return Math.round(Number(ms[1].replace(',', '.')) / 100) / 10
  const s = t.match(/(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|seg)/i)
  if (s) {
    const n = Number(s[1].replace(',', '.'))
    if (Number.isFinite(n) && n > 0 && n <= 60) return Math.round(n * 10) / 10
  }
  return null
}

/**
 * Arma el pack del personaje de `asset_id` (su hoja de Animation Sheet).
 *
 * `soloEstado: true` no descarga ni escribe nada: contesta qué llevaría y qué falta. Es lo que
 * alimenta el sector del radial, que tiene que poder decir «faltan los vídeos» ANTES de pulsar.
 */
async function armarPackDeAnimacion({ db, project_id, asset_id, member_id = null, soloEstado = false }) {
  const anm = require('./animacion.service')

  const { data: origen } = await db().from('forge_assets')
    .select('id, name, node_id, format, storage_url, metadata')
    .eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!origen) throw falta('Asset not found', 'NO_APLICA')

  // El personaje sale de la instancia de la hoja, igual que en la corrida. Si la hoja no nombra a
  // un personaje —agrupa varios— no hay pack que armar, por la misma razón por la que no hay
  // vídeos que generar: no se sabe de quién serían.
  // Tiene que ser la HOJA, no algo que la hoja produjo. Los vídeos de la cadena heredan el nombre
  // de su hoja —«… — 24_AnimationSheet — Moon Jelly × 6 — Motion reference — idlepulse»— así que
  // por nombre parecen hojas; lo que los delata es que llevan sello de cadena y que no son imagen.
  // Sin esta guarda se ofrecía un pack sobre un mp4, con un «personaje» que era su propio título.
  if (origen.metadata?.cadena) throw falta('This is a piece produced from a sheet, not the sheet', 'NO_APLICA')
  if (!/^(png|jpg|jpeg|image)$/i.test(origen.format || '')) throw falta('This is not an animation sheet', 'NO_APLICA')

  // Y tiene que ser la hoja de ANIMACIÓN, no cualquier hoja que nombre a un personaje.
  //
  // Faltaba, y el sector salía sobre las Character Sheet: también son imagen y también nombran a
  // su criatura, así que pasaban las dos comprobaciones de arriba. Lo reportó Miguel el 23-09
  // sobre «Character Sheet — Cactus». La página la dice la propia instancia —`18_CharacterSheet`,
  // `24_AnimationSheet`—, que es el dato que las separa sin depender de cómo se llame el activo.
  const pagina = origen.metadata?.instancia?.pagina || ''
  const esHojaDeAnimacion = pagina
    ? /animationsheet/i.test(String(pagina).replace(/[^a-z]/gi, ''))
    : /animation\s*sheet/i.test(String(origen.name || ''))
  if (!esHojaDeAnimacion) throw falta('This is not an animation sheet', 'NO_APLICA')

  const desde = origen.metadata?.instancia?.item || origen.name || null
  const personaje = anm.nombreDePersonaje(desde)
  if (!personaje || norma(personaje).length < 2) throw falta('This sheet does not name a character', 'NO_APLICA')

  const faltantes = []

  // ── 1 · Los vídeos de referencia ───────────────────────────────────────────
  // Se reconocen por su PADRE, no por su nombre: cada mp4 de la cadena cuelga de la hoja desde la
  // que se corrió (`derived_from_id`), y esa hoja sí dice de qué personaje es. Buscarlos por
  // nombre fallaría — en la base hay mp4 llamados «Motion reference — swing», sin personaje — y
  // en un proyecto donde seis criaturas comparten los mismos nombres de clip, emparejar por clip
  // mezclaría los personajes. Es justo lo que este pack existe para no hacer.
  const { data: piezas } = await db().from('forge_assets')
    .select('id, name, format, storage_url, metadata, derived_from_id, created_at, status')
    .eq('project_id', project_id)
    .in('status', ['approved', 'auto_approved'])
  const todas = piezas || []

  const videos = todas.filter(a =>
    /^mp4$/i.test(a.format || '') && a.storage_url &&
    a.metadata?.cadena?.paso === 'animation_ref' &&
    String(a.derived_from_id) === String(origen.id))

  if (!videos.length) faltantes.push({ que: 'videos', dice: 'No reference video has been generated from this sheet yet' })

  // ── 2 · El modelo del personaje ────────────────────────────────────────────
  // Se resuelve por LINAJE: el `.glb` cuelga de la hoja de personaje, que lleva la instancia. El
  // nombre queda de respaldo para los modelos viejos, cuyo linaje no llega a ninguna instancia.
  const porId = Object.fromEntries(todas.map(a => [a.id, a]))
  const itemDe = a => {
    let cur = a
    for (let i = 0; i < 6 && cur; i++) {
      if (cur.metadata?.instancia?.item) return cur.metadata.instancia.item
      cur = porId[cur.derived_from_id]
    }
    return null
  }
  const k = norma(personaje)
  const modelos = todas.filter(a => /^glb$/i.test(a.format || '') && a.storage_url)
  const suyos = modelos.filter(a => {
    const it = itemDe(a)
    return it && (norma(anm.nombreDePersonaje(it)) === k)
  })
  // Entre los del personaje gana el que salió de la vista FRONTAL. La skill pide el modelo en
  // T/bind-pose, y el que se generó desde la vista trasera o lateral llega con la pose de esa
  // lámina. Medido en test_smack_migue_v.09: el primero que devolvía la base era el de «back».
  const deLaVista = a => {
    let cur = a
    for (let i = 0; i < 6 && cur; i++) {
      const r = cur.metadata?.cadena?.rol
      if (r && r !== 'glb') return r
      cur = porId[cur.derived_from_id]
    }
    return /—\s*front\b/i.test(a.name || '') ? 'front' : null
  }
  const modelo = suyos.find(a => deLaVista(a) === 'front')
    || suyos[0]
    || modelos.find(a => norma(a.name).includes(k) && k.length >= 3)
    || null

  if (!modelo) faltantes.push({ que: 'glb', dice: `No 3D model of “${personaje}” in this project` })

  // ── 3 · La lámina y los tiempos ────────────────────────────────────────────
  const lamina = origen.storage_url && /^(png|jpg|jpeg|image)$/i.test(origen.format || '') ? origen : null
  if (!lamina) faltantes.push({ que: 'sheet', dice: 'This sheet has no rendered image' })

  // La lista de clips solo sirve para NOMBRAR los archivos y poner sus tiempos, y eso únicamente
  // hace falta al armar el zip. Pidiéndola también para el estado, abrir el radial leía el
  // Vertical Slice entero —112.000 caracteres en pinball— cada vez, y el sector tardaba en
  // aparecer. Miguel lo reportó el 23-09. El estado no la usa: cuenta vídeos y dice qué falta.
  const clips = soloEstado
    ? []
    : await anm.clipsDelPersonaje({ db, project_id, desde, soloCache: true })
        .then(r => r.clips || []).catch(() => [])

  // El nombre del archivo de cada vídeo: el del clip, que es como el otro lado sabe qué animar.
  // Se toma la etiqueta del listado —«Idle_Sleepy»— y, si el clip no está en la lista, la clave
  // con la que se despachó, que es lo único que queda.
  const porClave = Object.fromEntries(clips.map(c => [c.nombre, c]))

  // UN vídeo por movimiento, el más reciente.
  //
  // Esto no es limpieza: es el contrato del otro lado. La skill dice «cada `.mp4` en la raíz de
  // la carpeta = un movimiento pedido», así que meter las re-corridas como `Idle_Pulse_2.mp4` le
  // haría producir un clip llamado `Idle_Pulse_2` que nadie pidió. Medido en
  // test_smack_migue_v.09: de 10 vídeos, 4 eran segundas y terceras vueltas del mismo clip.
  // Las anteriores no se pierden —siguen en el proyecto, versionadas— pero al pack va la última.
  const ultimoPorClave = new Map()
  for (const v of videos) {
    const clave = v.metadata?.cadena?.parte || v.id
    const previo = ultimoPorClave.get(clave)
    if (!previo || new Date(v.created_at) > new Date(previo.created_at)) ultimoPorClave.set(clave, v)
  }
  const descartados = videos.length - ultimoPorClave.size

  const usados = new Set()
  const conNombre = [...ultimoPorClave.entries()].map(([clave, v]) => {
    const clip = porClave[clave] || null
    const base = archivoDe(clip?.etiqueta || clave || 'Clip')
    // Por si dos claves distintas dieran el mismo nombre de archivo: el zip no puede tener dos
    // entradas iguales y perder una en silencio sería peor que un sufijo.
    let n = 1, nombre = base
    while (usados.has(nombre.toLowerCase())) nombre = `${base}_${++n}`
    usados.add(nombre.toLowerCase())
    return { asset: v, clave, clip, archivo: `${nombre}.mp4`, segundos: segundosDe(clip) }
  })

  const estado = {
    personaje,
    videos: conNombre.map(v => ({ archivo: v.archivo, clip: v.clave, segundos: v.segundos })),
    descartados,
    modelo: modelo ? modelo.name : null,
    lamina: Boolean(lamina),
    clips: clips.length,
    faltantes,
    listo: faltantes.length === 0,
  }
  if (soloEstado) return estado
  if (faltantes.length) { const e = falta(faltantes.map(f => f.dice).join(' · ')); e.faltantes = faltantes; throw e }

  // ── El zip ─────────────────────────────────────────────────────────────────
  const raiz = archivoDe(personaje)
  const binarios = []
  const ausencias = []

  for (const v of conNombre) {
    try { const b = await bajar(v.asset.storage_url); binarios.push({ archivo: v.archivo, ...b }) }
    catch (e) { ausencias.push({ archivo: v.archivo, motivo: e.message }) }
  }
  let modeloArchivo = null
  try {
    const b = await bajar(modelo.storage_url)
    modeloArchivo = `${raiz}.glb`
    binarios.push({ archivo: modeloArchivo, ...b })
  } catch (e) { ausencias.push({ archivo: `${raiz}.glb`, motivo: e.message }) }

  let laminaArchivo = null
  try {
    const b = await bajar(lamina.storage_url)
    laminaArchivo = 'AnimationSheet.png'
    binarios.push({ archivo: laminaArchivo, ...b })
  } catch (e) { ausencias.push({ archivo: 'AnimationSheet.png', motivo: e.message }) }

  // El listado de tiempos de la Fase 5. La skill no lo lee —solo mira los `.mp4` y el `.glb`— pero
  // él lo pide, y es lo único que lleva la duración y la intención de cada movimiento escritas.
  const listado = {
    contrato: CONTRATO,
    personaje,
    generado: new Date().toISOString(),
    modelo: modeloArchivo,
    lamina: laminaArchivo,
    clips: conNombre.map(v => ({
      archivo: v.archivo,
      clip: v.clip?.etiqueta || v.clave,
      clave: v.clave,
      loop: v.clip?.loop ?? null,
      segundos: v.segundos,
      es_prop: v.clip?.es_prop ?? null,
      intencion: v.clip?.reglas || null,
      prompt: v.asset.metadata?.prompt || null,
    })),
    ...(ausencias.length ? { ausencias } : {}),
  }

  const zip = archiver('zip', { zlib: { level: 9 } })
  const trozos = []
  zip.on('data', t => trozos.push(t))
  const listo = new Promise((ok, mal) => { zip.on('end', ok); zip.on('error', mal) })

  zip.append(JSON.stringify(listado, null, 2), { name: `${raiz}/clips.json` })
  for (const b of binarios) zip.append(b.buffer, { name: `${raiz}/${b.archivo}` })
  zip.finalize()
  await listo
  const buffer = Buffer.concat(trozos)

  const pack_id = crypto.randomUUID()
  const { uploadToStorage } = require('./storage.service')
  const url = await uploadToStorage(buffer, `projects/${project_id}/packs/${pack_id}.zip`, 'application/zip')

  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id: origen.node_id, output_key: null, status: 'auto_approved',
    iteration_count: 1, started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id,
  }).select('id').single()

  const { data: pieza } = await db().from('forge_assets').insert({
    project_id, node_id: origen.node_id, session_id: ses?.id || null,
    name: `Animation pack — ${personaje}`,
    format: 'zip', mime_type: 'application/zip', storage_url: url,
    status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
    derived_from_id: origen.id,
    metadata: { pack: { contrato: CONTRATO, pack_id, personaje, videos: conNombre.length, ausencias: ausencias.length } },
  }).select('id, name, storage_url').single()

  return {
    url, pack_id, personaje, bytes: buffer.length,
    videos: conNombre.map(v => v.archivo),
    modelo: modeloArchivo, lamina: laminaArchivo,
    ausencias, asset: pieza || null,
  }
}

module.exports = { armarPackDeAnimacion, CONTRATO }
