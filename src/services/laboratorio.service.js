// ─── El Laboratory, con el TDD del proyecto ya puesto ────────────────────────
//
// El Prototype Laboratory convierte un TDD en un jugable de Three.js. Vive aparte —repositorio
// propio, despliegue propio— y Forge no lo reimplementa: lo llama, igual que a Maps_App.
//
// Lo único que hace este servicio es quitarle al usuario un paso que no es una decisión. El
// Laboratory abre pidiendo que elijas un TDD de su carpeta; pero si vienes desde un proyecto de
// Forge, el TDD ya está decidido — es el de ese proyecto. Así que Forge se lo empuja y abre la
// interfaz ya parada en él.
//
// Se empuja CADA VEZ, y no una sola. El disco de su despliegue es efímero: lo que se subió ayer
// puede no estar hoy. Además el TDD cambia cuando el 3.12 vuelve a correr, y abrir el Laboratory
// con una versión vieja del documento es peor que no abrirlo.

const BASE = () => (process.env.LAB_URL || '').replace(/\/$/, '')

// La regla de nombres del propio Laboratory (`SAFE_SLUG_RE` en su `server/security/paths.js`):
// empieza por alfanumérico, después alfanuméricos, guion bajo o guion, hasta 80.
const slugDe = nombre => {
  const s = String(nombre || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 80)
  return s || 'Proyecto'
}

function exigirBase() {
  const b = BASE()
  if (!b) {
    const err = new Error('LAB_URL is not configured: Forge does not know where the Laboratory lives')
    err.code = 'SIN_LAB'
    throw err
  }
  return b
}

/**
 * El TDD ensamblado del proyecto, o null.
 *
 * Se busca por `output_key`, que es el contrato — `tdd_complete` es la salida del nodo 3.12 que
 * junta las nueve secciones. Las secciones sueltas no sirven: el Laboratory lee UN documento.
 */
async function tddDelProyecto(db, project_id) {
  const { data } = await db().from('forge_assets')
    .select('id, name, content, created_at')
    .eq('project_id', project_id).eq('output_key', 'tdd_complete')
    .not('content', 'is', null)
    .order('created_at', { ascending: false })
  const doc = (data || [])[0]
  return doc?.content ? doc : null
}

/**
 * Si el botón tiene a dónde ir, sin empujar nada.
 *
 * Y de paso DESPIERTA el laboratorio. Corre en una instancia que se duerme sola: medido el 16-09,
 * la primera petición tarda **22,5 segundos** y la siguiente 0,28. Si ese arranque empieza cuando
 * alguien ya pulsó, se lo come esperando; empezándolo al abrir el panel, corre mientras lee.
 *
 * Cualquier petición lo despierta —no hace falta abrir su página—, así que se aprovecha la que ya
 * hace falta para saber si hay un Final construido.
 */
async function estadoDelLaboratorio({ db, project_id }) {
  const doc = await tddDelProyecto(db, project_id)
  const base = BASE()

  // `ready` es del SERVICIO, no del proyecto: el laboratorio guarda un solo taller para todos.
  // Sin preguntarlo, Publish se ofrecía siempre y el error llegaba del otro lado.
  let jugable = null
  if (base) {
    const t0 = Date.now()
    try {
      const r = await fetch(`${base}/api/gameplay/status`, { signal: AbortSignal.timeout(90000) })
      if (r.ok) jugable = await r.json()
    } catch (e) {
      // Que no conteste no es un fallo del proyecto: es el servicio arrancando o caído, y el
      // panel lo dice en vez de prometer un botón que va a fallar.
      jugable = { ready: false, motivo: e.name === 'TimeoutError' ? 'still waking up' : e.message }
    }
    console.log(`[lab] estado en ${Math.round((Date.now() - t0) / 1000)}s · ready: ${jugable?.ready}`)
  }

  return {
    configurado: Boolean(base),
    tiene_tdd: Boolean(doc),
    // Si hay build final en el laboratorio. Es lo que decide si Publish se puede ofrecer.
    jugable_listo: Boolean(jugable?.ready),
    lab_responde: jugable !== null && !jugable?.motivo,
    ...(jugable?.motivo ? { lab_motivo: jugable.motivo } : {}),
    ...(doc ? { documento: doc.name, chars: doc.content.length } : {}),
  }
}

/**
 * Empuja el TDD y devuelve la dirección con la que abrir el Laboratory ya parado en él.
 *
 * `project_name` se antepone porque el Laboratory lo busca ahí y nuestro TDD no lo trae: sin esa
 * línea el proyecto aparece en su lista como «Untitled». Es más barato que pedirle al nodo 3.12
 * que cambie su plantilla, y no toca el documento guardado — solo la copia que viaja.
 */
async function abrirLaboratorio({ db, project_id, nombreProyecto }) {
  const base = exigirBase()
  const doc = await tddDelProyecto(db, project_id)
  if (!doc) {
    const err = new Error('This project has no assembled TDD yet: run node 3.12 first')
    err.code = 'SIN_TDD'
    throw err
  }

  const slug = slugDe(nombreProyecto || project_id)
  const texto = `project_name: ${nombreProyecto || slug}\n\n${doc.content}`

  // El taller del laboratorio es UNO para todo el servicio: el jugable vive siempre en
  // `public/gameplay`. Abrir dos proyectos seguidos hacía que el segundo viera el prototipo del
  // primero — lo reportó Miguel. Antes de empujar nada se le pide al laboratorio que aparte el
  // taller que estaba y traiga el de este proyecto. Si esa versión del laboratorio todavía no lo
  // soporta, se sigue como antes en vez de no abrir.
  try {
    const w = await fetch(`${base}/api/workspace/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    })
    if (w.ok) {
      const est = await w.json()
      console.log(`[lab] taller «${slug}»${est.changed ? ` (antes: ${est.previous || 'ninguno'})` : ' ya puesto'} · build: ${est.ready}`)
    } else {
      console.warn(`[lab] este laboratorio no aísla por proyecto todavía (HTTP ${w.status})`)
    }
  } catch (e) {
    console.warn('[lab] no se pudo cambiar de taller:', e.message)
  }

  const r = await fetch(`${base}/api/tdds/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, text: texto }),
  })
  const cuerpo = await r.text()
  if (!r.ok) throw new Error(`The Laboratory refused the TDD (${r.status}): ${cuerpo.slice(0, 200)}`)

  let res
  try { res = JSON.parse(cuerpo) } catch { throw new Error('The Laboratory did not answer with JSON') }

  return {
    url: `${base}/?tdd=${encodeURIComponent(res.slug)}`,
    slug: res.slug,
    documento: doc.name,
    proyecto: res.projectName,
    mecanicas: (res.mechanics || []).length,
    // El Laboratory construye A PARTIR de las mecánicas. Un TDD sin ninguna abre una pantalla
    // vacía, así que se dice acá y quien llama decide si avisa antes de abrir.
    usable: Boolean(res.usable),
  }
}

module.exports = { abrirLaboratorio, estadoDelLaboratorio, tddDelProyecto, slugDe, BASE }
