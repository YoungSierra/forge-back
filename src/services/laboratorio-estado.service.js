// ─── El estado del Laboratory, que deja de vivir en su disco ─────────────────
//
// El Laboratory corre en una instancia cuyo disco es EFÍMERO: lo que escribió ayer puede no estar
// hoy y cada redespliegue se lo lleva. Leído en su propio repo (commit 84193c0):
//
//   public/gameplay/     el jugable generado        ignorado en git → se pierde
//   docs/tdds/           los TDD empujados          no viene en el repo → se pierde
//   workspaces/<slug>/   el taller de cada proyecto ignorado → se pierde
//   el CHAT              `const sessions = new Map()`   server/index.js:78
//                        `chatHistory` / `checkpoint`   server/agent/session.js:140
//
// El chat es el peor: no llega ni a disco. Muere con el proceso, y `/api/sessions/resume` NO lo
// recupera — abre una sesión nueva sobre el build que quedara. Se pierde el ida y vuelta con el
// modelo, que es donde está el criterio de quién prototipó.
//
// Acá el dueño del dato pasa a ser Forge y el Laboratory queda como lo que es: el taller.
//
// CÓMO SE REPARTE, y es el mismo reparto que usa todo lo demás en Forge — la fila describe, R2
// guarda:
//
//   fila en `v57.laboratory_state`   una por proyecto: el índice, el chat y cuándo se guardó
//   R2  projects/<id>/lab/<slug>/files/<ruta>   los archivos, con su ruta relativa tal cual
//
// Los archivos no van en la fila porque el gameplay son ~78 KB de JavaScript y el TDD 112 KB, y el
// cuello de esta base ya son los bytes. El chat sí, porque es JSON que se lee entero junto con la
// fila y nunca por partes.
//
// UNA fila por proyecto, sin historial: hay un prototipo, el actual. Versionarlo es otro producto.

const { uploadToStorage, getFromStorage, deleteStorageKeys } = require('./storage.service')
const { slugDe } = require('./laboratorio.service')

/** Un prefijo por proyecto y taller. El slug ya viene saneado por el propio Laboratory. */
const prefijoDe = (projectId, slug) => `projects/${projectId}/lab/${slug}`

// Qué se guarda y qué no. El criterio es: lo que no se puede volver a tener.
//
//   SE GUARDA    el gameplay generado (es lo que costó) y el TDD que lo originó
//   NO SE GUARDA los exports (1,6 MB cada uno y se rehacen de un botón), las capturas de QA (son
//                de una corrida), el benchmark y el proveedor elegido (preferencias del servicio,
//                no del proyecto)
//
// Añadir una carpeta es una línea en esta lista, no un desarrollo. Por eso es una lista.
const CARPETAS = ['public/gameplay', 'docs/tdds']

const TIPOS = {
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8', yml: 'text/yaml; charset=utf-8', txt: 'text/plain; charset=utf-8',
}
const tipoDe = ruta => TIPOS[String(ruta).split('.').pop().toLowerCase()] || 'application/octet-stream'

/** El proyecto al que pertenece un taller. El Laboratory solo conoce slugs; el mapa vive acá. */
async function proyectoDeSlug({ db, slug }) {
  const { data, error } = await db().from('projects').select('id, name')
  if (error) throw error
  // Por el MISMO slug que Forge le manda al abrirlo, no por parecido: si dos proyectos produjeran
  // el mismo, guardar en el equivocado sería silencioso y destructivo.
  const iguales = (data || []).filter(p => slugDe(p.name) === slug)
  if (!iguales.length) {
    const e = new Error(`No project matches the workshop "${slug}"`); e.code = 'SIN_PROYECTO'; throw e
  }
  if (iguales.length > 1) {
    const e = new Error(`${iguales.length} projects produce the workshop name "${slug}", so this state cannot be filed safely`)
    e.code = 'SLUG_AMBIGUO'; throw e
  }
  return iguales[0]
}

/** Las claves que ya hay bajo un prefijo. R2 pagina; se recorre entero. */
async function listarPrefijo(prefijo) {
  const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3')
  const cliente = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CF_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
    },
  })
  const claves = []
  let token
  do {
    const r = await cliente.send(new ListObjectsV2Command({
      Bucket: process.env.CF_R2_BUCKET, Prefix: `${prefijo}/`, ContinuationToken: token,
    }))
    for (const o of (r.Contents || [])) claves.push(o.Key)
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return claves
}

/**
 * Guarda el estado que manda el Laboratory. REEMPLAZA el anterior: hay un estado por taller.
 *
 * `archivos` son `{ ruta, texto }` con la ruta RELATIVA a la raíz del Laboratory
 * —`public/gameplay/main.js`—, que es la misma con la que hay que devolvérselos.
 */
async function guardarEstado({ db, slug, archivos = [], chat = null, origen = null }) {
  const p = await proyectoDeSlug({ db, slug })
  const prefijo = prefijoDe(p.id, slug)

  // Solo lo declarado. El filtro vive donde está escrita la regla, no en el Laboratory.
  const dentro = archivos.filter(a => CARPETAS.some(c => String(a.ruta || '').startsWith(`${c}/`)))
  const descartados = archivos.length - dentro.length

  // Lo de antes se borra ANTES de escribir lo nuevo. Si el gameplay pasó de diez archivos a ocho,
  // dejar los dos viejos devolvería un taller que mezcla dos generaciones — y eso no da ningún
  // síntoma hasta que algo no compila.
  const viejos = await listarPrefijo(prefijo)
  if (viejos.length) await deleteStorageKeys(viejos)

  const indice = []
  let bytes = 0
  for (const a of dentro) {
    const buf = Buffer.from(String(a.texto ?? ''), 'utf8')
    bytes += buf.length
    indice.push({ ruta: a.ruta, bytes: buf.length })
    await uploadToStorage(buf, `${prefijo}/files/${a.ruta}`, tipoDe(a.ruta))
  }

  const mensajes = chat?.checkpoint?.messages?.length ?? chat?.historial?.length ?? 0
  const fila = {
    project_id: p.id, slug, r2_prefix: prefijo,
    archivos: indice, bytes, chat, chat_mensajes: mensajes,
    origen, guardado_en: new Date().toISOString(),
  }

  // `upsert` por `project_id`, que es la clave primaria: un proyecto tiene un estado y el nuevo
  // reemplaza al viejo. El índice único del slug es la red de seguridad por el otro lado.
  const { data, error } = await db().from('laboratory_state')
    .upsert(fila, { onConflict: 'project_id' }).select('*').single()
  if (error) throw error

  console.log(`[lab-estado] guardado «${slug}» · ${indice.length} archivo(s) ${Math.round(bytes / 1024)} KB`
    + ` · chat ${mensajes} mensaje(s)` + (descartados ? ` · ${descartados} descartado(s)` : '')
    + (origen ? ` · desde ${origen}` : ''))
  return { ...data, descartados }
}

/**
 * El estado guardado de un taller, listo para que el Laboratory lo escriba tal cual.
 *
 * Si no hay nada se dice con `hay: false` en vez de devolver un estado vacío: un taller sin guardar
 * y un taller vacío son cosas distintas, y confundirlas haría que restaurar BORRARA lo que el
 * Laboratory tuviera en disco.
 */
async function leerEstado({ db, slug, conArchivos = true }) {
  const { data: fila, error } = await db().from('laboratory_state')
    .select('*').eq('slug', slug).maybeSingle()
  if (error) throw error
  if (!fila) return { hay: false, slug }

  const archivos = []
  if (conArchivos) {
    for (const a of (fila.archivos || [])) {
      try { archivos.push({ ruta: a.ruta, texto: await getFromStorage(`${fila.r2_prefix}/files/${a.ruta}`) }) }
      catch (e) {
        // Un archivo que el índice nombra y R2 no tiene es un estado a medias. Se dice: devolver el
        // resto en silencio entregaría un gameplay incompleto que no arranca y sin explicación.
        const err = new Error(`The saved state lists "${a.ruta}" and the file is not in storage: ${e.message}`)
        err.code = 'ESTADO_INCOMPLETO'
        throw err
      }
    }
  }

  return {
    hay: true, slug, project_id: fila.project_id,
    guardado_en: fila.guardado_en, origen: fila.origen,
    bytes: fila.bytes, chat: fila.chat, chat_mensajes: fila.chat_mensajes,
    indice: fila.archivos, archivos,
  }
}

/** Lo que el panel necesita para decir si hay prototipo guardado, sin tocar R2. */
async function resumenDelEstado({ db, project_id }) {
  const { data, error } = await db().from('laboratory_state')
    .select('slug, bytes, chat_mensajes, origen, guardado_en, archivos')
    .eq('project_id', project_id).maybeSingle()
  if (error) throw error
  if (!data) return { hay: false }
  return {
    hay: true, slug: data.slug, guardado_en: data.guardado_en, origen: data.origen,
    archivos: (data.archivos || []).length, bytes: data.bytes, chat_mensajes: data.chat_mensajes,
  }
}

module.exports = { guardarEstado, leerEstado, resumenDelEstado, proyectoDeSlug, CARPETAS, prefijoDe }
