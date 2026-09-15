// ─── Qué pide el alcance del Vertical Slice, ítem por ítem ───────────────────
//
// El ASG dejó de ser «25 páginas fijas». Lo dice el documento del sistema de actualización y lo
// confirmó Miguel el 15-09: la plantilla `.json` sigue emitiendo UNA hoja, y **Forge la instancia
// una vez por ítem del alcance** — tres personajes, tres Character Sheets. El workflow no se toca.
//
// De dónde salen los ítems. De dos sitios, y ninguno es el ADI:
//
//   · Las REGLAS de cuánto entra («1 por actor del slice», «1 de 4») son del documento de alcance
//     VS_Alcance_Produccion, y ya viven en el panel del front.
//   · Los NÚMEROS Y NOMBRES de cada juego son del Vertical Slice Specification, que Forge mismo
//     produce en el 3.13. Es lo que lee este servicio.
//
// Se leen TABLAS, no prosa. La prosa nombra un efecto al hablar de otro —«a diferencia de
// VFX-02…»— y ahí empezaría a hacer falta adivinar; una tabla es una relación declarada. Las dos
// que sirven, medidas contra el documento vivo:
//
//   §A7.1 Tier summary — «Asset class | Count | FINAL | SLICE-ONLY | Notes». El inventario.
//   §A2.5 Actor roster — «Actor | Type | Behaviour | Loop interaction | Trigger». Quién actúa.
//
// Lo que no se reconoce NO se reparte por descarte: se devuelve en `sin_clasificar`. Repartir por
// parecido es lo que hace que alguien pague tres despachos de una hoja que no iba.

/** A qué hoja del ASG va cada clase de asset. Por palabra declarada, no por parecido. */
const A_LA_HOJA = [
  { hoja: '22_VFXSheet',            etiqueta: 'VFX Sheet',             re: /\bvfx\b|\bvisual effects?\b/i },
  // Los límites de palabra no son cosmética. Medido contra el documento vivo, sin ellos:
  // «SFX dull t-hud» caía en la hoja de UI, y «custom sy-stem» en la de Audio.
  { hoja: '21_UIComponentSheet',    etiqueta: 'UI Component Sheet',    re: /\bui\b|\bhud\b|\bscreens?\b|\bmenus?\b/i },
  { hoja: '23_AudioSheet',          etiqueta: 'Audio Sheet',           re: /\baudio\b|\bsfx\b|\bmusic\b|\bvoices?\b|\bvo\b|\bstems?\b/i },
  { hoja: '24_AnimationSheet',      etiqueta: 'Animation Sheet',       re: /\banimation\b|\bclips?\b|\brigs?\b/i },
  { hoja: '19_EnvironmentSheet',    etiqueta: 'Environment Sheet',     re: /\benv-\d|\benvironments?\b|\bbackgrounds?\b|\blevels?\b/i },
  { hoja: '20_PropSheet',           etiqueta: 'Prop Sheet',            re: /\bprops?\b|\bitems?\b|\bobjects?\b/i },
  { hoja: '25_VideoMarketingSheet', etiqueta: 'Video Marketing Sheet', re: /\bmarketing\b|\btrailer\b|\bteaser\b|\bpromo\b/i },
  { hoja: '18_CharacterSheet',      etiqueta: 'Character Sheet',       re: /\bchar\b|\bchar-\d|\bcharacters?\b|\bactors?\b|\benem(y|ies)\b|\bcreatures?\b|\bhero\b|\bnpc\b/i },
]

// Lo que el inventario declara pero NO es una lámina de arte: escenas de motor, sistemas de
// código, perfiles de render. Se excluyen por nombre declarado y se cuentan aparte — repartirlas
// por parecido es lo que mandaba «Scene: SCN_MainMenu_Menu» a la hoja de UI.
const NO_ES_LAMINA = /^(scene|custom system|system|prefab|script|shader|material)\b|post-process|\bvolume profile\b/i

/** La sección pedida, hasta el próximo encabezado del mismo nivel o superior. */
function seccion(md, re) {
  const L = String(md || '').split('\n')
  const i = L.findIndex(l => re.test(l))
  if (i < 0) return null
  const nivel = (L[i].match(/^#+/) || ['#'])[0].length
  const out = []
  for (let j = i + 1; j < L.length; j++) {
    const m = L[j].match(/^(#+)\s/)
    if (m && m[1].length <= nivel) break
    out.push(L[j])
  }
  return out.join('\n')
}

/** Las filas de la primera tabla de un trozo de markdown, ya partidas en celdas. */
function filasDeTabla(md) {
  const filas = []
  let cabecera = null
  for (const linea of String(md || '').split('\n')) {
    if (!linea.includes('|')) { if (cabecera) break; continue }   // la tabla terminó
    const celdas = linea.split('|').map(c => c.trim())
    if (celdas[0] === '') celdas.shift()
    if (celdas[celdas.length - 1] === '') celdas.pop()
    if (!celdas.length) continue
    if (/^[-: ]+$/.test(celdas[0])) continue                      // la línea de guiones
    if (!cabecera) { cabecera = celdas; continue }
    filas.push(celdas)
  }
  return { cabecera, filas }
}

/** «**VFX Ghost Arc (VFX-03)**» → «VFX Ghost Arc (VFX-03)». */
const limpio = s => String(s || '').replace(/\*\*/g, '').replace(/`/g, '').trim()

/** «2 (bell + tentacle)» → 2 · «~5 (A × 5)» → 5 · «—» → 0. */
function cuenta(celda) {
  const t = limpio(celda)
  const m = t.match(/\d+/)
  return m ? parseInt(m[0], 10) : 0
}

/**
 * Los ítems del alcance, agrupados por la hoja del ASG que los produce.
 *
 * `total` es lo que el slice declara; `instancias` es cuántas hojas habría que emitir, que no es
 * lo mismo: una fila puede declarar dos sprite sheets del MISMO personaje —«2 (bell + tentacle)»—
 * y eso es un personaje con dos láminas, no dos personajes. Por eso instancia por FILA, no por
 * cuenta, y deja la cuenta a la vista para quien mire el recuadro antes de pagar.
 */
function itemsDesdeSpec(md) {
  const porHoja = {}
  const sinClasificar = []
  const noSonLaminas = []
  const avisos = []

  const anota = (hoja, item) => { (porHoja[hoja] ||= []).push(item) }

  // ── §A7.1 Tier summary: el inventario declarado ────────────────────────────
  const tier = seccion(md, /^#{2,4}\s*A7\.1/)
  if (!tier) avisos.push('the spec has no §A7.1 Tier summary: the inventory could not be read')
  else {
    const { cabecera, filas } = filasDeTabla(tier)
    const iClase = 0
    const iCuenta = (cabecera || []).findIndex(c => /count/i.test(c))
    for (const f of filas) {
      const nombre = limpio(f[iClase])
      if (!nombre) continue
      const n = iCuenta > 0 ? cuenta(f[iCuenta]) : 1
      if (n === 0) continue                       // declarado y fuera del slice
      if (NO_ES_LAMINA.test(nombre)) { noSonLaminas.push({ nombre, cuenta: n }); continue }
      const destino = A_LA_HOJA.find(d => d.re.test(nombre))
      if (!destino) { sinClasificar.push({ nombre, cuenta: n, de: '§A7.1' }); continue }
      // Los personajes los pone el roster, que los nombra uno por uno.
      if (destino.hoja === '18_CharacterSheet') { avisos.push(`“${nombre}”: counted from the actor roster, not from the inventory`); continue }
      anota(destino.hoja, { nombre, cuenta: n, de: '§A7.1' })
    }
  }

  // ── §A2.5 Actor roster: quién actúa ────────────────────────────────────────
  // El roster es la autoridad de PERSONAJES y solo de eso: es literalmente la lista de actores, y
  // una Character Sheet se instancia por actor. Del inventario no se toman personajes, porque los
  // nombra por su entregable —«Diver character sprite sheet» frente a «Diver (player character)»—
  // y las dos filas son el mismo actor contado dos veces.
  //
  // El roster también mezcla efectos: «Ghost Arc» es VFX-03 y ya está en el inventario. Por eso
  // solo entran las filas cuyo tipo declara personaje.
  const roster = seccion(md, /^#{2,4}\s*A2\.5/)
  if (roster) {
    const { cabecera, filas } = filasDeTabla(roster)
    const iTipo = (cabecera || []).findIndex(c => /type/i.test(c))
    const esPersonaje = A_LA_HOJA.find(d => d.hoja === '18_CharacterSheet').re
    for (const f of filas) {
      const nombre = limpio(f[0])
      if (!nombre) continue
      const tipo = iTipo > 0 ? limpio(f[iTipo]) : ''
      if (!esPersonaje.test(tipo) && !esPersonaje.test(nombre)) continue
      anota('18_CharacterSheet', { nombre, cuenta: 1, de: '§A2.5' })
    }
  }

  return { porHoja, sinClasificar, noSonLaminas, avisos }
}

/** Lo mismo, leyendo el Vertical Slice Specification aprobado del proyecto. */
async function itemsDelAlcance({ db, project_id }) {
  const { data: ses } = await db().from('forge_sessions').select('id')
    .eq('project_id', project_id).eq('output_key', 'vs_spec_doc')
    .in('status', ['approved', 'auto_approved'])
  if (!(ses || []).length) {
    return { hay: false, motivo: 'This project has no approved Vertical Slice Specification yet', porHoja: {}, sinClasificar: [], avisos: [] }
  }
  const { data: docs } = await db().from('forge_assets').select('content')
    .in('session_id', ses.map(s => s.id)).not('content', 'is', null)
    .order('created_at', { ascending: false }).limit(1)
  const md = docs?.[0]?.content
  if (!md) return { hay: false, motivo: 'The Vertical Slice Specification has no text', porHoja: {}, sinClasificar: [], avisos: [] }

  const r = itemsDesdeSpec(md)
  return { hay: true, ...r }
}

module.exports = { itemsDelAlcance, itemsDesdeSpec, A_LA_HOJA, seccion, filasDeTabla }
