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

/** Si el botón tiene a dónde ir, sin empujar nada. */
async function estadoDelLaboratorio({ db, project_id }) {
  const doc = await tddDelProyecto(db, project_id)
  return {
    configurado: Boolean(BASE()),
    tiene_tdd: Boolean(doc),
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
