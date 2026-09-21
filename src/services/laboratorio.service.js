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
 *
 * Y si el nodo se corrió ENTERO, donde no hay clave que buscar, se lee su sección del documento
 * único. El 3.12 puede correrse de las dos formas y su contrato lo permite; buscar solo la clave
 * dejaba a `test_pinball_migue_v.10` con su TDD de 170.843 caracteres aprobado en el lienzo y el
 * botón diciendo «this project has no assembled TDD yet — run node 3.12 first». Medido el 18-09.
 */
async function tddDelProyecto(db, project_id) {
  const { data } = await db().from('forge_assets')
    .select('id, name, content, created_at')
    .eq('project_id', project_id).eq('output_key', 'tdd_complete')
    .not('content', 'is', null)
    .order('created_at', { ascending: false })
  const doc = (data || [])[0]
  if (doc?.content) return doc

  return await tddDeCorridaEntera(db, project_id)
}

/**
 * El TDD dentro del documento de una corrida de nodo entero.
 *
 * Una corrida entera aprueba UNA pieza sin `output_key` con las nueve salidas dentro, cada una
 * bajo su encabezado `## <nombre de la salida>`.
 *
 * El corte NO puede ser por nivel de encabezado: el propio TDD usa nivel 2 para sus secciones
 * —`## 0.0 · Fill-policy legend`, `## Mechanic: FlipperController`— así que cortar en el próximo
 * `##` devolvería un muñón. El límite es la SIGUIENTE SALIDA del nodo, que es justo lo que hace
 * `seccionDeOutput`; se reutiliza esa en vez de escribir otra que se equivoque igual.
 */
async function tddDeCorridaEntera(db, project_id) {
  const { seccionDeOutput } = require('./slide-composer.service')

  const { data: n } = await db().from('forge_nodes')
    .select('id, outputs').eq('node_key', '3.12').maybeSingle()
  if (!n) return null
  const salidas = Array.isArray(n.outputs) ? n.outputs : []
  const claves = salidas.map(o => o.key || o.name).filter(Boolean)
  // La etiqueta la declara la DNA —`tdd_complete` → «TDD Complete»—; no se escribe a mano acá.
  const etiqueta = salidas.find(o => (o.key || o.name) === 'tdd_complete')?.label || 'TDD Complete'

  // Solo DOCUMENTOS: una sesión única también deja piezas sueltas sin clave que no son el TDD.
  const { data: enteros } = await db().from('forge_assets')
    .select('id, name, content, created_at')
    .eq('project_id', project_id).eq('node_id', n.id)
    .in('status', ['approved', 'auto_approved'])
    .is('output_key', null).not('content', 'is', null)
    .order('created_at', { ascending: false })

  // 1 · La pieza que lleva la sección dentro. Es el caso de una corrida REALMENTE entera: un solo
  //     documento con las nueve salidas, cada una bajo su `## <clave>`.
  for (const a of enteros || []) {
    const s = seccionDeOutput(a.content, 'tdd_complete', claves)
    if (!s) continue
    console.log(`[lab] 3.12 corrido entero: sección «tdd_complete» de «${a.name}» (${s.length} chars)`)
    return { ...a, content: s, de_corrida_entera: true }
  }

  // 2 · Y la pieza cuyo NOMBRE es la salida. Medido el 18-09: hay proyectos con las nueve piezas
  //     publicadas por separado y ninguna con clave —el nombre lleva la etiqueta de la DNA,
  //     «Technical Design Document — TDD Complete»— porque cada output se aprobó en su propia
  //     sesión sin que nadie escribiera `output_key`. Es el bug de fondo de buscar por clave un
  //     dato que el motor deja en el nombre.
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const buscada = norm(etiqueta)
  for (const a of enteros || []) {
    const cola = String(a.name || '').split(/\s+[—–-]\s+/).pop()
    if (norm(cola) !== buscada) continue
    console.log(`[lab] 3.12 sin clave: se reconoce «${a.name}» por su etiqueta (${a.content.length} chars)`)
    return { ...a, por_etiqueta: true }
  }

  // 3 · Y por ELIMINACIÓN, que tampoco es adivinar: de las nueve salidas del 3.12, ocho son de
  //     tipo `connection` y la ÚNICA que es un documento es `tdd_complete`. Así que un documento
  //     sin clave de este nodo que no sea ninguna de las otras ocho, es el TDD.
  //
  //     Hace falta porque hay una tercera forma en la base, medida el 18-09 en
  //     `smack_test_pedrito_v0.4`: las ocho conexiones publicadas CON su clave, y el TDD suelto
  //     sin clave, llamado «Technical Design Document — Output» y sin ninguna marca dentro. Son
  //     143.809 caracteres con su Fill-policy legend y sus secciones 1 a 6: decir que ese proyecto
  //     no tiene TDD era falso.
  //
  //     Solo se acepta si queda UNO. Con varios candidatos no hay forma de elegir y se prefiere
  //     decir que no hay a mandar el documento equivocado al Laboratory.
  const etiquetasDeConexion = salidas
    .filter(o => o.type === 'connection')
    .map(o => norm(o.label || o.key || o.name))
    .filter(Boolean)
  const sobran = (enteros || []).filter(a => {
    const cola = norm(String(a.name || '').split(/\s+[—–-]\s+/).pop())
    return !etiquetasDeConexion.includes(cola)
  })
  if (sobran.length === 1) {
    console.log(`[lab] 3.12 sin clave: «${sobran[0].name}» es el único documento que no es una conexión (${sobran[0].content.length} chars)`)
    return { ...sobran[0], por_eliminacion: true }
  }
  if (sobran.length > 1) {
    console.warn(`[lab] 3.12 deja ${sobran.length} documentos sin clave que podrían ser el TDD (${sobran.map(a => a.name).join(', ')}) — no se elige ninguno`)
  }
  return null
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
  // ── El TDD no espera al laboratorio ───────────────────────────────────────
  //
  // Antes esta pregunta aguardaba hasta 90 segundos a que el Laboratory contestara, y recién
  // entonces devolvía TODO — incluido `tiene_tdd`, que sale de la base y ya estaba resuelto en la
  // primera línea. El resultado: el botón se quedaba en «Checking…» esperando a un servicio
  // externo para decir algo que no depende de él. Lo reportó David el 21-09 sobre
  // test_pinball_migue_v.10, cuyo TDD está perfectamente ahí.
  //
  // Ahora se espera poco. El despertar del laboratorio NO necesita que nadie lo aguarde: la
  // petición ya salió y el servicio arranca igual, así que si no contesta a tiempo se devuelve lo
  // que sí se sabe y `jugable_listo` queda en falso hasta la próxima consulta. Un Publish que
  // tarda un ciclo en aparecer es mucho mejor que un botón que no dice nada en minuto y medio.
  const ESPERA_MS = 6000
  let jugable = null
  if (base) {
    const t0 = Date.now()
    try {
      const r = await fetch(`${base}/api/gameplay/status`, { signal: AbortSignal.timeout(ESPERA_MS) })
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
 * Despertar el Laboratory, sin esperarlo.
 *
 * Corre en una instancia que se duerme: la primera petición tarda ~22 s y la siguiente 0,28. Si
 * ese arranque empieza cuando alguien ya abrió el panel, se lo come esperando. Empezándolo en el
 * LOGIN —mientras la persona escribe su contraseña— llega despierto a la primera pantalla.
 *
 * No devuelve el resultado a propósito: lo único que hace falta es que el proceso de allá
 * arranque. Quien de verdad necesite saber si hay build, lo pregunta con `estadoDelLaboratorio`.
 */
function despertarLaboratorio() {
  const base = BASE()
  if (!base) return { configurado: false }
  fetch(`${base}/api/gameplay/status`, { signal: AbortSignal.timeout(90000) })
    .then(() => console.log('[lab] despierto'))
    .catch(() => { /* silencio: corre de fondo y su fallo no es de nadie que esté mirando */ })
  return { configurado: true }
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

module.exports = { abrirLaboratorio, estadoDelLaboratorio, despertarLaboratorio, tddDelProyecto, slugDe, BASE }
