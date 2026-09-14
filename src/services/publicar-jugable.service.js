// ─── Del Laboratory a una URL que se juega ───────────────────────────────────
//
// El Laboratory arma una build autónoma —`index.html`, el runtime de Three.js, el `gameplay/`
// generado y el TDD— y la deja en SU disco, que es efímero: lo comprobamos en vivo, un redespliegue
// se llevó lo que había. Así que el jugable se pierde, y con él lo que costó generarlo.
//
// Esto lo trae y lo pone en R2, que es donde vive todo lo demás del proyecto, y devuelve la
// dirección del `index.html`. Esa dirección se abre y se juega: no hace falta nada más.
//
// Por qué se sube el ÁRBOL y no un comprimido: un `.zip` en almacenamiento no es un enlace
// jugable. El navegador pide `index.html`, y de ahí `play.js`, `runtime/Engine.js`, cada módulo
// del gameplay… uno por uno. Guardarlo empaquetado obligaría a alguien a descargarlo y abrirlo a
// mano, que es justo lo que este camino existe para evitar.
//
// Y por eso el `Content-Type` de cada archivo importa más de lo que parece: un `.js` servido como
// imagen lo rechaza el navegador y el juego no arranca, sin decir por qué.

const { uploadToStorage } = require('./storage.service')
const { BASE } = require('./laboratorio.service')

const TIPOS = {
  html: 'text/html; charset=utf-8',
  js:   'text/javascript; charset=utf-8',
  mjs:  'text/javascript; charset=utf-8',
  css:  'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md:   'text/markdown; charset=utf-8',
  txt:  'text/plain; charset=utf-8',
  svg:  'image/svg+xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
  glb:  'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin:  'application/octet-stream',
  wasm: 'application/wasm',
  mp3:  'audio/mpeg',
  ogg:  'audio/ogg',
  wav:  'audio/wav',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf:  'font/ttf',
  ico:  'image/x-icon',
  map:  'application/json; charset=utf-8',
}

const tipoDe = ruta => TIPOS[(/\.([a-z0-9]+)$/i.exec(ruta)?.[1] || '').toLowerCase()] || 'application/octet-stream'

// Un techo para no subir en silencio una build enorme. El runtime de Three.js ya pesa lo suyo y
// cada publicación es espacio que se queda; si una build lo supera, se dice antes de empezar.
const TOPE_BUILD = 120 * 1024 * 1024

/**
 * Publica el jugable de un proyecto y devuelve su dirección.
 *
 * `slug` es el mismo con el que Forge le empujó el TDD, que es como el Laboratory tiene archivado
 * ese proyecto.
 */
async function publicarJugable({ db, project_id, slug, nombreProyecto = null, member_id = null }) {
  const base = BASE()
  if (!base) {
    const err = new Error('LAB_URL is not configured: Forge does not know where the Laboratory lives')
    err.code = 'SIN_LAB'
    throw err
  }

  // 1 · Que arme la build y diga qué archivos tiene.
  const r = await fetch(`${base}/api/tdds/${encodeURIComponent(slug)}/publish`, { method: 'POST' })
  const cuerpo = await r.text()
  if (!r.ok) {
    let motivo = cuerpo.slice(0, 300)
    try { motivo = JSON.parse(cuerpo).error || motivo } catch { /* el cuerpo no era JSON */ }
    const err = new Error(motivo)
    // «No playable public/gameplay/main.js. Generate Final first.» no es un fallo del servidor:
    // es que todavía no hay juego que publicar.
    err.code = /generate final/i.test(motivo) ? 'SIN_JUGABLE' : 'LAB_ERROR'
    throw err
  }
  const build = JSON.parse(cuerpo)
  if (!build.files?.length) throw new Error('The Laboratory reported a build with no files')
  if (build.bytes > TOPE_BUILD) {
    throw new Error(`That build is ${(build.bytes / 1024 / 1024).toFixed(0)} MB, over the ${TOPE_BUILD / 1024 / 1024} MB ceiling`)
  }

  // 2 · Traer cada archivo y ponerlo en R2 bajo una carpeta propia de esta publicación. Con sello
  //     de tiempo: publicar otra vez no pisa lo que alguien ya compartió.
  const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const raiz = `projects/${project_id}/play/${build.export || `${slug}-${sello}`}`
  const t0 = Date.now()
  let subidos = 0
  let bytes = 0

  for (const f of build.files) {
    const ar = await fetch(`${base}/api/exports/${encodeURIComponent(build.export)}/${f.path}`)
    if (!ar.ok) throw new Error(`Could not fetch "${f.path}" from the build: HTTP ${ar.status}`)
    const buf = Buffer.from(await ar.arrayBuffer())
    await uploadToStorage(buf, `${raiz}/${f.path}`, tipoDe(f.path))
    subidos++
    bytes += buf.length
    if (subidos % 25 === 0) console.log(`[jugable] ${subidos}/${build.files.length} archivos`)
  }

  const publico = (process.env.CF_R2_PUBLIC_URL || '').replace(/\/$/, '')
  const url = `${publico}/${raiz}/${build.entry || 'index.html'}`
  console.log(`[jugable] ${subidos} archivos · ${(bytes / 1024 / 1024).toFixed(1)} MB · ${Math.round((Date.now() - t0) / 1000)}s`)

  // 3 · Y queda como pieza del proyecto, para que se encuentre desde el moodboard y no solo desde
  //     el enlace que alguien copió.
  const { data: nodo } = await db().from('forge_nodes').select('id').eq('node_key', '3.12').maybeSingle()
  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id: nodo?.id || null, output_key: null, status: 'auto_approved',
    iteration_count: 1, started_at: new Date(t0).toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id,
  }).select('id').single()

  const { data: activo, error } = await db().from('forge_assets').insert({
    project_id, node_id: nodo?.id || null, session_id: ses?.id || null,
    name: `Playable — ${nombreProyecto || slug}`,
    format: 'html', mime_type: 'text/html',
    status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
    storage_url: url,
    metadata: { jugable: { slug, export: build.export, archivos: subidos, bytes } },
  }).select('id, name, storage_url').single()
  if (error) console.warn('[jugable] no se pudo registrar el activo (el enlace igual sirve):', error.message)

  return { url, archivos: subidos, bytes, segundos: Math.round((Date.now() - t0) / 1000), asset_id: activo?.id || null }
}

module.exports = { publicarJugable, tipoDe, TOPE_BUILD }
