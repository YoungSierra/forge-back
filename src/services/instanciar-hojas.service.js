// ─── Una hoja por ítem del alcance ───────────────────────────────────────────
//
// El ASG dejó de ser 25 páginas fijas: la plantilla sigue emitiendo UNA hoja de cada tipo y Forge
// la instancia una vez por ítem del alcance —tres personajes, tres Character Sheets—. Lo confirmó
// Miguel el 15-09 y su documento de actualización lo dice igual: «20 páginas fijas + N fichas de
// instancia». El `.json` no se toca.
//
// Cómo, sin tocar el compositor. Instanciar es despachar la MISMA página varias veces, y ese
// camino ya existe y está probado: es el de iterar una página —`generateDeck` con `solo:[índice]`
// y un `extraPrompt`—. Dos instancias no pueden viajar en el mismo job porque comparten el nodo
// que guarda la imagen: la segunda pisaría a la primera. Así que va un despacho por ítem.
//
// Cada despacho SE PAGA. Por eso el plan se puede pedir sin ejecutarlo, el ejecutor tiene tope, y
// nada corre sin que quien llama nombre explícitamente las páginas: un botón que multiplica el
// gasto por veintiséis no puede depender de un valor por defecto.

const { itemsDelAlcance } = require('./alcance-vs.service')

/** Tope duro por llamada. Veintiséis despachos es lo que da un slice real; más es un error. */
const TOPE_DESPACHOS = 40

/**
 * Qué se instanciaría y cuánto sale, sin despachar nada.
 *
 * Devuelve las páginas del deck que tienen ítems, con el índice que necesita `solo:[…]`, para que
 * el recuadro previo pueda enseñar la lista ANTES de cobrar.
 */
async function planDeInstancias({ db, project_id, deck = 'asg' }) {
  const { composeDeck } = require('./slide-composer.service')

  const alcance = await itemsDelAlcance({ db, project_id })
  if (!alcance.hay) return { hay: false, motivo: alcance.motivo, paginas: [], despachos: 0 }

  // El índice de cada página lo da el propio deck compuesto: deducirlo del número del nombre
  // —«18_CharacterSheet» → 18— funciona hoy y deja de funcionar en cuanto el maestro se
  // reordene, que ya pasó dos veces este año.
  const armado = await composeDeck({ db, projectId: project_id, deck })
  // Por NOMBRE y no por número. El manifiesto y el lector del alcance hablan del maestro de 25
  // páginas —«19_EnvironmentSheet»— y un proyecto puede correr otro, donde la misma hoja es la
  // 29. Es la trampa que ya rompió la cascada de actualización: el número cambia, el nombre no.
  const sinNumero = n => String(n || '').replace(/^d+[_s-]*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const porNombre = new Map(armado.paginas.map(p => [p.nombre, p]))
  for (const p of armado.paginas) {
    const k = sinNumero(p.nombre)
    if (k && !porNombre.has(k)) porNombre.set(k, p)
  }

  const paginas = []
  const ausentes = []
  for (const [hoja, items] of Object.entries(alcance.porHoja || {})) {
    const pag = porNombre.get(hoja) ?? porNombre.get(sinNumero(hoja))
    if (!pag) { ausentes.push(hoja); continue }
    paginas.push({
      pagina: hoja, indice: pag.indice, kind: pag.kind || 'image',
      items: items.map(i => ({ nombre: i.nombre, de: i.de, cuenta: i.cuenta })),
    })
  }
  paginas.sort((a, b) => a.indice - b.indice)

  return {
    hay: true,
    paginas,
    despachos: paginas.reduce((n, p) => n + p.items.length, 0),
    // Lo que el alcance pide y el deck no sabe producir. Callarlo haría parecer que el slice
    // está cubierto cuando le falta una hoja entera.
    ausentes,
    sin_clasificar: alcance.sinClasificar || [],
    no_son_laminas: alcance.noSonLaminas || [],
    avisos: alcance.avisos || [],
    // De dónde salió la cuenta: el manifiesto del 3.20 o la prosa del VS Spec. Un número que se
    // paga tiene que decir quién lo dijo.
    fuente: alcance.fuente || null,
  }
}

/** La línea que le dice al modelo DE CUÁL de los ítems es esta instancia. */
const pedidoDe = (pagina, item) => [
  `This sheet is for ONE item of the vertical slice scope: "${item.nombre}".`,
  `Fill the ${pagina.replace(/^\d+_/, '')} for that item only — not for the whole game, and not for any other item.`,
  'Keep the page layout, the field names and the style of the template exactly as they are.',
].join('\n')

/**
 * Despacha las instancias y publica cada una como página propia.
 *
 * `paginas` viene de quien llamó y no del plan: obliga a que la decisión de gastar la tome quien
 * mira el recuadro. Un fallo en una instancia no cancela las anteriores —ya están pagadas y
 * publicadas— y se devuelve lo que sí salió, con el motivo de lo que no.
 */
async function instanciarHojas({
  db, project_id, node_id, node_key, output_key, image_gen_model,
  paginas, deck = 'asg', documento = 'Art Style Guide', member_id = null, limite = 0,
}) {
  const { generateDeck } = require('./image-gen.service')

  if (!Array.isArray(paginas) || !paginas.length) {
    const e = new Error('No pages were named: instancing is never implicit, because every dispatch is paid')
    e.code = 'SIN_PAGINAS'
    throw e
  }

  const trabajo = []
  for (const p of paginas) {
    for (const item of p.items || []) trabajo.push({ pagina: p.pagina, indice: p.indice, item })
  }
  const recortado = limite > 0 && trabajo.length > limite ? trabajo.slice(0, limite) : trabajo
  if (recortado.length > TOPE_DESPACHOS) {
    const e = new Error(`${recortado.length} dispatches asked for, over the ceiling of ${TOPE_DESPACHOS}`)
    e.code = 'TOPE'
    throw e
  }

  const creados = []
  const fallos = []

  for (const t of recortado) {
    try {
      const r = await generateDeck({
        db, project_id, node_id, session_id: null, node_key, output_key,
        image_gen_model, deck, member_id,
        solo: [t.indice],
        extraPrompt: pedidoDe(t.pagina, t.item),
      })
      const pg = r.paginas?.[0]
      if (!pg?.url) { fallos.push({ ...t, motivo: 'the workflow returned no image' }); continue }

      // Una sesión por despacho, como hace la cadena: el activo la exige y deja el paso trazado.
      const { data: ses } = await db().from('forge_sessions').insert({
        project_id, node_id, output_key, status: 'auto_approved', iteration_count: 1,
        started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
        triggered_by: member_id,
      }).select('id').single()

      // El nombre conserva la página Y nombra el ítem: «Art Style Guide — 18_CharacterSheet —
      // Diver». El prefijo del documento se respeta porque el moodboard reparte las zonas por él.
      const { data: activo } = await db().from('forge_assets').insert({
        project_id, node_id, session_id: ses?.id || null,
        name: `${documento} — ${t.pagina} — ${t.item.nombre}`,
        format: 'png', mime_type: 'image/png', storage_url: pg.url,
        status: 'approved', approved_by: member_id, approved_at: new Date().toISOString(),
        metadata: { instancia: { pagina: t.pagina, item: t.item.nombre, de: t.item.de || null, job: r.jobId || null } },
      }).select('id, name, storage_url').single()

      creados.push(activo || { name: `${documento} — ${t.pagina} — ${t.item.nombre}`, storage_url: pg.url })
      console.log(`[instancias] ${t.pagina} · ${t.item.nombre} ✓`)
    } catch (e) {
      console.warn(`[instancias] ${t.pagina} · ${t.item.nombre}: ${e.message}`)
      fallos.push({ ...t, motivo: e.message })
    }
  }

  return { creados, fallos, pedidos: recortado.length, de: trabajo.length }
}

module.exports = { planDeInstancias, instanciarHojas, pedidoDe, TOPE_DESPACHOS }
