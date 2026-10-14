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

// Los límites de palabra no son cosmética. Medido contra el documento vivo, sin ellos:
// «SFX dull t-hud» caía en la hoja de UI, y «custom sy-stem» en la de Audio.
//
// Pero NO pueden ser `\b`: en JavaScript el guion bajo es letra, así que entre «VFX» y «_» no hay
// límite y `VFX_WaterSplash` no casaba con nada. Medido por Pedro el 13-10 en Wort: 40 filas del
// inventario en `sin_clasificar` y ni una VFX Sheet ni una UI Sheet que instanciar, justo cuando
// la cadena de la VFX acababa de publicarse. Acá el límite es «ni letra ni dígito», y el guion
// bajo cuenta como separador. Fuera de eso, se acepta exactamente lo mismo que antes.
const _ =(...alternativas) => new RegExp(alternativas.map(a => `(?<![a-z0-9])${a}(?![a-z0-9])`).join('|'), 'i')

/** A qué hoja del ASG va cada clase de asset. Por palabra declarada, no por parecido. */
const A_LA_HOJA = [
  { hoja: '22_VFXSheet',            etiqueta: 'VFX Sheet',             re: _('vfx', 'visual effects?') },
  { hoja: '21_UIComponentSheet',    etiqueta: 'UI Component Sheet',    re: _('ui', 'hud', 'screens?', 'menus?') },
  { hoja: '23_AudioSheet',          etiqueta: 'Audio Sheet',           re: _('audio', 'sfx', 'music', 'voices?', 'vo', 'stems?') },
  // Sin «rig»: «CHR_Wort (mesh, textures, rig)» es la fila del PERSONAJE, que también se riggea, y
  // por esa palabra caía en una Animation Sheet. Una clase de animación se nombra por sus clips.
  { hoja: '24_AnimationSheet',      etiqueta: 'Animation Sheet',       re: _('animations?', 'clips?') },
  // ANTES que la del entorno, y no por gusto: un skybox se nombra por el entorno que rodea
  // —«Skybox — Sector 7 Hydro Labs»— asi que la regla del entorno se lo llevaria. El orden de
  // esta lista es el que decide, y aca si importa.
  //
  // «360» solo si no es un giro: un «360 turnaround» es la vuelta a un personaje, no un panorama.
  { hoja: '25_SkyboxSheet',         etiqueta: 'Skybox Sheet',          re: /(?<![a-z0-9])(?:skyboxe?s?|panoramas?)(?![a-z0-9])|(?<![a-z0-9])360(?![a-z0-9])(?!\s*°?\s*(?:turn|spin|rotat))/i },
  { hoja: '19_EnvironmentSheet',    etiqueta: 'Environment Sheet',     re: _('env-\\d+','environments?', 'backgrounds?', 'levels?') },
  { hoja: '20_PropSheet',           etiqueta: 'Prop Sheet',            re: _('props?', 'items?', 'objects?') },
  { hoja: '25_VideoMarketingSheet', etiqueta: 'Video Marketing Sheet', re: _('marketing', 'trailer', 'teaser', 'promo') },
  { hoja: '18_CharacterSheet',      etiqueta: 'Character Sheet',       re: _('char', 'char-\\d+','characters?', 'actors?', 'enem(?:y|ies)', 'creatures?', 'hero', 'npc') },
]

// La convención de `asset_id` de los propios nodos de Forge (el 3.9 la valida con
// ^(CHR|PRP|ENV|VFX|UI|ICO|AUD|ITEM|LVL)_). Cuando la fila empieza por uno de estos, el prefijo
// DICE la clase y manda sobre las palabras del resto de la fila.
//
// `ITEM_` no va a ninguna Sheet: el ítem lo cubre la página editorial `11_ItemCollectible`, la
// misma regla que ya sigue el manifiesto del 3.20 («ITEM_ … are never Prop Sheets»). `CHR_` va al
// personaje, que luego cuenta el roster. `LVL_` no tiene hoja.
const POR_PREFIJO = {
  VFX: '22_VFXSheet', UI: '21_UIComponentSheet', ICO: '21_UIComponentSheet', HUD: '21_UIComponentSheet',
  AUD: '23_AudioSheet', ENV: '19_EnvironmentSheet', PRP: '20_PropSheet', CHR: '18_CharacterSheet',
  ITEM: null, LVL: null,
}

// Y la `category` del brief aprobado del 3.9, que manda sobre las dos cosas anteriores cuando la
// fila tiene brief: es lo que el nodo que produjo el asset dijo que es (decisión de Pedro, 13-10).
// Con prefijo `ITEM_` sigue sin hoja aunque el brief diga Prop: ver arriba.
const POR_CATEGORIA = [
  [/^(prop|interactable|platform|decoration)$/i,                '20_PropSheet'],
  [/^(environment blockout|environment kit|background)$/i,      '19_EnvironmentSheet'],
  [/^vfx$/i,                                                    '22_VFXSheet'],
  [/^(ui element|icon|font)$/i,                                 '21_UIComponentSheet'],
  [/^(character|companion|boss)$/i,                             '18_CharacterSheet'],
]

/** El `asset_id` con el que empieza una fila del inventario: «PRP_AmberWarningLamp ×6» → PRP_AmberWarningLamp. */
const idDeFila = nombre => (String(nombre).match(/^([A-Z]{2,5})_[A-Za-z0-9]+/) || [])[0] || null

// Lo que el inventario declara pero NO es una lámina de arte: escenas de motor, sistemas de
// código, perfiles de render. Se excluyen por nombre declarado y se cuentan aparte — repartirlas
// por parecido es lo que mandaba «Scene: SCN_MainMenu_Menu» a la hoja de UI.
//
// Las escenas de QA y el concept art/moodboard son entregables, pero no láminas del ASG.
const NO_ES_LAMINA = /^(scene|custom system|system|prefab|script|shader|material)\b|post-process|\bvolume profile\b|^qa test scenes?\b|^concept art\b|\bmood ?boards?\b/i

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

// Una fila que se reconoce y a propósito no lleva Sheet (los `ITEM_`). Distinto de null, que es
// «no se sabe qué es» y va a `sin_clasificar`.
const SIN_HOJA = Symbol('sin hoja')

/**
 * La hoja de una fila del inventario. En este orden: la `category` de su brief aprobado, el
 * prefijo de su `asset_id`, y por último las palabras. Sin nada de eso, null — nunca Prop por
 * descarte.
 */
function destinoDe(nombre, categorias, avisos) {
  const hoja = h => A_LA_HOJA.find(d => d.hoja === h)
  const id = idDeFila(nombre)
  const pref = id ? id.split('_')[0].toUpperCase() : null
  if (pref === 'ITEM') {
    avisos.push(`“${nombre}”: ITEM_ rows get no Sheet — the item is covered by the editorial page 11_ItemCollectible`)
    return SIN_HOJA
  }
  // Las animaciones de un personaje llevan SU id —«CHR_Wort animations (8 clips)»— y son una
  // Animation Sheet, no otra Character Sheet: la palabra manda sobre el prefijo y sobre la
  // categoría del brief, que es la del personaje.
  const anim = hoja('24_AnimationSheet')
  if (anim.re.test(nombre)) return anim
  const cat = id && categorias?.get(id)
  if (cat) {
    const m = POR_CATEGORIA.find(([re]) => re.test(cat))
    if (m) return hoja(m[1])
  }
  if (pref && pref in POR_PREFIJO) return POR_PREFIJO[pref] ? hoja(POR_PREFIJO[pref]) : SIN_HOJA
  return A_LA_HOJA.find(d => d.re.test(nombre)) || null
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
function itemsDesdeSpec(md, { categorias = null } = {}) {
  const porHoja = {}
  const sinClasificar = []
  const noSonLaminas = []
  const avisos = []

  const anota = (hoja, item) => { (porHoja[hoja] ||= []).push(item) }

  // ── El inventario declarado ────────────────────────────────────────────────
  //
  // Se busca primero donde lo sitúa el documento del sistema —§A7.1— y, si ahí no está, POR SU
  // FORMA: la tabla cuya primera columna es «Asset Class».
  //
  // El ancla se mueve entre versiones del 3.13. Medido el 17-09 en test_smack_migue_v.09: su
  // §A7.1 es «Platform and Build Form» y el inventario vive en «A6 · Quality Tier Per Asset
  // Class». Atados al número, de 69.000 caracteres salían 2 instancias en vez de quince, y el
  // panel decía que no había nada que contar. Es la misma lección que con las páginas del ASG: el
  // número es la posición, no la identidad.
  const inv = (() => {
    const porAncla = seccion(md, /^#{2,4}\s*A7\.1/)
    if (porAncla) {
      const t = filasDeTabla(porAncla)
      if (t.filas?.length) return { ...t, de: '§A7.1' }
    }
    // Se recorren los bloques del documento —cada encabezado hasta el siguiente— y se toma el que
    // trae una tabla de clases de asset. Cortar el texto a mano evita armar una expresión regular
    // a partir de un título, que es frágil con los «·» y los puntos de la numeración.
    const lineas = md.split('\n')
    const cortes = []
    lineas.forEach((l, i) => { if (/^#{2,4}\s+\S/.test(l)) cortes.push(i) })
    for (let k = 0; k < cortes.length; k++) {
      const bloque = lineas.slice(cortes[k], cortes[k + 1] ?? lineas.length).join('\n')
      const t = filasDeTabla(bloque)
      if (t.filas?.length && (t.cabecera || []).some(c => /asset\s*class/i.test(c))) {
        const titulo = lineas[cortes[k]].replace(/^#+\s*/, '').trim()
        return { ...t, de: `§${titulo.split(/[\s·]/)[0]}` }
      }
    }
    return null
  })()

  if (!inv) avisos.push('the spec has no asset-class inventory table: there is nothing to count from')
  else {
    const { cabecera, filas, de } = inv
    const iClase = 0
    const iCuenta = (cabecera || []).findIndex(c => /count/i.test(c))
    // FINAL o SLICE-ONLY. Es una ETIQUETA de clase de asset, no un estado: la marca dirección de
    // arte y el menú solo la enseña (spec del menú §7, y v2.3 §11 punto 4).
    const iTier = (cabecera || []).findIndex(c => /tier|final/i.test(c))
    for (const f of filas) {
      const nombre = limpio(f[iClase])
      if (!nombre) continue
      const n = iCuenta > 0 ? cuenta(f[iCuenta]) : 1
      if (n === 0) continue                       // declarado y fuera del slice
      if (NO_ES_LAMINA.test(nombre)) { noSonLaminas.push({ nombre, cuenta: n }); continue }
      const destino = destinoDe(nombre, categorias, avisos)
      if (destino === SIN_HOJA) continue
      if (!destino) { sinClasificar.push({ nombre, cuenta: n, de }); continue }
      // Los personajes los pone el roster, que los nombra uno por uno.
      if (destino.hoja === '18_CharacterSheet') { avisos.push(`“${nombre}”: counted from the actor roster, not from the inventory`); continue }
      // En el formato viejo la columna «FINAL» lleva una CUENTA, no una etiqueta: ahí un «1» no
      // significa que el asset sea FINAL. Solo se toma si es texto.
      const crudo = iTier > 0 ? limpio(f[iTier]) : null
      const tier = crudo && !/^[\d\s.,–-]+$/.test(crudo) ? crudo : null
      anota(destino.hoja, { nombre, cuenta: n, de, ...(tier ? { tier } : {}) })
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

  // ── La hoja de animación, una por personaje ────────────────────────────────
  //
  // Sus instancias salen del inventario de CLASES de activo, y una clase no tiene por qué nombrar
  // a un personaje. En test_smack_migue_v.09 lo hace por casualidad —«Cartón rig + all
  // animations», «Moon Jelly × 6»— y todo funciona. En test_pinball_migue_v.10 las filas son «6
  // creature rigs and skinning» y «42 creature animation clips (7 per creature × 6)»: dos hojas
  // para seis criaturas, y ninguna dice a cuál animar. El paso no encuentra ancla y no corre.
  //
  // La sección de animación del propio spec SÍ enumera por personaje, así que de ahí salen. Pero
  // solo se recurre a ella cuando hace falta: si alguna clase ya nombra a un actor del roster, se
  // deja como está — cambiarlo renombraría instancias vivas y dejaría huérfanas las hojas ya
  // generadas y pagadas.
  const HOJA_ANIM = '24_AnimationSheet'
  const actores = (porHoja['18_CharacterSheet'] || []).map(x => x.nombre)
  if (actores.length) {
    const k = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    const nombraActor = (porHoja[HOJA_ANIM] || []).some(it =>
      actores.some(a => k(it.nombre).includes(k(a)) || k(a).includes(k(it.nombre))))
    if (!nombraActor) {
      // Los grupos de la sección de animación: «*Luma (Axolotl) — 7 clips:*».
      const anim = (() => {
        const L = md.split('\n')
        let i = L.findIndex(l => /^#{1,4}\s*B\d+\s*[·•.\-–—]?\s*animation\s*$/i.test(l))
        if (i < 0) i = L.findIndex(l => /^#{1,4}\s*B\d+\b[^\n]*\banimation\b/i.test(l))
        if (i < 0) return []
        const j = L.findIndex((l, n) => n > i && /^#{1,4}\s/.test(l))
        const grupos = []
        for (const l of L.slice(i + 1, j < 0 ? L.length : j)) {
          const g = l.match(/^\s*\*\*?\s*([^*|]+?)\s*[—–]\s*\d+\s*clips?\s*:?\s*\*?\*\s*$/i)
          if (g) grupos.push(g[1].trim())
        }
        // Solo los que el roster reconoce como actores: la sección también menciona props, y esos
        // se animan dentro de la hoja de su personaje, no en una hoja propia.
        return grupos
          .map(g => actores.find(a => k(a).includes(k(g)) || k(g).includes(k(a))) || null)
          .filter((v, n, arr) => v && arr.indexOf(v) === n)
      })()
      if (anim.length > 1) {
        avisos.push(`${HOJA_ANIM}: instanced per character from the animation section `
          + `(${anim.length}), because no asset class names an actor`)
        porHoja[HOJA_ANIM] = anim.map(nombre => ({ nombre, cuenta: 1, de: '§B · Animation' }))
      }
    }
  }

  // Los props que solo aparecen en la tabla de animación NO se derivan como hoja.
  //
  // El 30-09 llegaron a derivarse: el alcance no declara un solo prop en ningún proyecto y sin
  // embargo el Vertical Slice de v.09 pide animar «Exit Door — Open», así que se les daba hoja
  // propia para tener dónde animarlos. Ese mismo día JuanK cambió el criterio tras validarlo con
  // David: **las animaciones de props se resuelven en el motor** y salen del flujo de Forge.
  //
  // Sin animación que producir, darles hoja sería crear instancias —y despachos pagos— que nadie
  // pidió. Se quedan fuera, que es lo que él pide: «no deben aparecer en ningún listado». Si
  // algún día el alcance nombra props de verdad, entran por la clasificación normal de arriba.

  return { porHoja, sinClasificar, noSonLaminas, avisos }
}

// El 3.13 emite TRES salidas y el spec puede estar bajo cualquiera de ellas: `vs_spec_doc` es el
// ensamblado, `vs_spec` el que escribe el nodo. Mirar solo una dejaba invisible un documento
// APROBADO que estaba al lado — medido el 16-09 en 13_lives_kitten_TEST, donde `vs_spec` está
// aprobado y `vs_spec_doc` sigue en `active`. Se prefiere el ensamblado y se cae al otro.
const CLAVES_DEL_SPEC = ['vs_spec_doc', 'vs_spec']

/** Lo mismo, leyendo el Vertical Slice Specification aprobado del proyecto.
 *
 *  Antes se pregunta por el MANIFIESTO del 3.20, que es la fuente correcta desde la v2.9.35:
 *  un mapa declarado, con ids estables, en vez de tablas dentro de un documento en prosa. Su
 *  propia nota lo dice — «prose the Moodboard cannot count from».
 *
 *  El spec sigue de respaldo y no es temporal: un proyecto que no haya vuelto a correr el 3.20
 *  no puede quedarse sin poder instanciar. `fuente` dice de dónde salió la cuenta, porque al
 *  mirar un número que se paga hay que poder saber quién lo dijo. */
/**
 * El spec como base y el manifiesto por encima, PÁGINA A PÁGINA.
 *
 * `fuente` deja de ser una palabra para todo el resultado y pasa a ser un mapa: qué dijo cada
 * página y quién lo dijo. Es lo que hay que poder mirar cuando un número no cuadra, porque las dos
 * fuentes cuentan distinto y saber cuál habló es la mitad de la respuesta.
 */
function conManifiesto(r, manifiesto, avisoManifiesto) {
  const base = { hay: true, ...r, fuente: 'vs_spec', avisos: [...avisoManifiesto, ...(r.avisos || [])] }
  if (!manifiesto?.hay) return base

  const porHoja = { ...(r.porHoja || {}) }
  const fuentePorHoja = Object.fromEntries(Object.keys(porHoja).map(h => [h, 'vs_spec']))
  const tomadas = []
  for (const [hoja, items] of Object.entries(manifiesto.porHoja || {})) {
    if (!items?.length) continue          // una hoja que el manifiesto nombra vacía no manda
    porHoja[hoja] = items
    fuentePorHoja[hoja] = 'manifest'
    tomadas.push(hoja)
  }

  return {
    ...base,
    porHoja,
    fuente: tomadas.length ? 'mixta' : 'vs_spec',
    fuente_por_hoja: fuentePorHoja,
    avisos: [
      ...base.avisos,
      ...(tomadas.length ? [`sheet instance manifest used for: ${tomadas.join(', ')}`] : []),
      ...(manifiesto.avisos || []),
    ],
  }
}

/**
 * `asset_id` → `category` del `asset_briefs` APROBADO del 3.9. Sin pieza, o si no se puede leer,
 * null: la clasificación sigue por prefijo y por palabra, como antes.
 *
 * Por clave, en los dos sitios donde vive (la pieza y su sesión), y con la pieza del modo nodo
 * entero como respaldo: la reconoce su forma, `- asset_id:`, no su nombre.
 */
async function categoriasDeBriefs(db, project_id) {
  try {
    const { data: nodo } = await db().from('forge_nodes').select('id').eq('node_key', '3.9').maybeSingle()
    if (!nodo?.id) return null
    const { data: piezas } = await db().from('forge_assets')
      .select('content, created_at, output_key, forge_sessions!session_id(output_key)')
      .eq('project_id', project_id).eq('node_id', nodo.id)
      .in('status', ['approved', 'auto_approved']).not('content', 'is', null)
      .order('created_at', { ascending: false })
    const clave = a => a.output_key ?? a.forge_sessions?.output_key ?? null
    const pieza = (piezas || []).find(a => clave(a) === 'asset_briefs')
      || (piezas || []).find(a => !clave(a) && /^- asset_id:/m.test(a.content))
    if (!pieza) return null
    const T = require('./tandas.service')
    const YAML = require('yaml')
    const m = new Map()
    for (const tramo of T.tramos(T.bloqueYaml(pieza.content), 'asset_id')) {
      try {
        const v = YAML.parse(tramo); const o = Array.isArray(v) ? v[0] : v
        if (o?.asset_id && o?.category) m.set(String(o.asset_id), String(o.category).trim())
      } catch { /* un tramo roto no tumba los demás */ }
    }
    return m.size ? m : null
  } catch (e) {
    console.warn(`[alcance-vs] asset_briefs not read: ${e?.message}`)
    return null
  }
}

async function itemsDelAlcance({ db, project_id }) {
  const { itemsDelManifiesto } = require('./manifiesto-hojas.service')
  const manifiesto = await itemsDelManifiesto({ db, project_id })

  // UNA FUENTE POR PÁGINA, no una fuente para todo el deck.
  //
  // El manifiesto manda en las páginas que declara, y el spec cubre el resto. Tomarlo entero era
  // todo-o-nada y se comió cinco hojas: medido en pinball el 01-10, su manifiesto solo especifica
  // Environment y Prop —deja Character, UI, VFX, Audio y Animation en PENDING_SPEC— y al usarlo
  // para el deck completo el plan pasaba de 6 hojas y 20 ítems a 2 hojas y 14. Desaparecían
  // ocho personajes y seis animaciones sin que nada lo dijera. Lo vio venir Pedro.
  //
  // El manifiesto NO se descarta por eso: donde declara instancias es más preciso que el spec,
  // porque lo escribió el nodo que de verdad las produjo. Lo que no puede es hablar por las
  // páginas sobre las que calla.
  const avisoManifiesto = /has no sheet instance manifest/.test(manifiesto.motivo || '')
    ? []
    : manifiesto.hay ? [] : [`sheet instance manifest not used — ${manifiesto.motivo}`]

  const { data: ses } = await db().from('forge_sessions').select('id, output_key, status')
    .eq('project_id', project_id).in('output_key', CLAVES_DEL_SPEC)

  const aprobadas = (ses || []).filter(x => x.status === 'approved' || x.status === 'auto_approved')

  // Y la pieza del MODO NODO ENTERO, que no tiene clave.
  //
  // Un nodo puede correr salida por salida —y entonces cada documento lleva la suya— o entero,
  // y entonces produce UNA pieza con todo dentro, llamada «… — Output» y con `output_key` en
  // null. Buscar solo por clave la deja invisible: en test_smack_migue_v.09 el spec estaba ahí,
  // aprobado y con sus 69.000 caracteres, y el panel decía que había que correr el 3.13.
  //
  // Se reconoce por el NODO que la produjo, no por su nombre: «Output» lo lleva cualquiera.
  let deNodoEntero = null
  if (!aprobadas.length) {
    const { data: nodo } = await db().from('forge_nodes').select('id').eq('node_key', '3.13').maybeSingle()
    if (nodo) {
      const { data: piezas } = await db().from('forge_assets').select('content, name, status, created_at')
        .eq('project_id', project_id).eq('node_id', nodo.id)
        .in('status', ['approved', 'auto_approved']).not('content', 'is', null)
        .order('created_at', { ascending: false })
      // La que de verdad es el spec: la que trae su inventario. Si ninguna lo trae, la más
      // larga — y el aviso de más abajo dirá que no hay nada que contar.
      deNodoEntero = (piezas || []).find(p => /A7\.1/.test(p.content))
        || (piezas || []).sort((a, b) => b.content.length - a.content.length)[0]
        || null
    }
  }

  if (!aprobadas.length && !deNodoEntero) {
    // Que exista sin aprobar y que no exista son dos problemas distintos y se arreglan de
    // formas distintas. Decir lo mismo en los dos casos mandaba a correr un nodo que ya corrió.
    const motivo = (ses || []).length
      ? 'The Vertical Slice Specification exists but is not approved yet: approve the output of node 3.13'
      : 'This project has no Vertical Slice Specification yet: run node 3.13'
    return { hay: false, motivo, porHoja: {}, sinClasificar: [], avisos: avisoManifiesto }
  }

  // En el orden de preferencia, no en el que devuelva la base.
  const orden = CLAVES_DEL_SPEC
    .flatMap(k => aprobadas.filter(x => x.output_key === k))
  if (!orden.length && deNodoEntero) {
    const r = itemsDesdeSpec(deNodoEntero.content, { categorias: await categoriasDeBriefs(db, project_id) })
    const total = Object.values(r.porHoja || {}).reduce((n, l) => n + l.length, 0)
    if (!total) {
      return {
        hay: false,
        motivo: 'The approved Vertical Slice Specification has no §A7.1 inventory to count from. Re-run node 3.13.',
        porHoja: {}, sinClasificar: r.sinClasificar || [], avisos: [...avisoManifiesto, ...(r.avisos || [])],
      }
    }
    return conManifiesto(r, manifiesto, avisoManifiesto)
  }
  const { data: docs } = await db().from('forge_assets').select('content, session_id, created_at')
    .in('session_id', orden.map(x => x.id)).not('content', 'is', null)
    .order('created_at', { ascending: false })
  const porSesion = new Map((docs || []).map(d => [d.session_id, d]))
  const elegido = orden.map(x => porSesion.get(x.id)).find(Boolean)
  const md = elegido?.content || deNodoEntero?.content
  if (!md) return { hay: false, motivo: 'The approved Vertical Slice Specification has no text', porHoja: {}, sinClasificar: [], avisos: avisoManifiesto }

  const r = itemsDesdeSpec(md, { categorias: await categoriasDeBriefs(db, project_id) })

  // Un spec viejo se lee entero y no da NADA: los de antes de v2.9.2 no traen el inventario
  // §A7.1 del que salen las cuentas. Sin decirlo, el panel enseña cero instancias y parece que
  // el alcance está vacío, cuando lo que pasa es que el documento es de otra generación.
  const total = Object.values(r.porHoja || {}).reduce((n, l) => n + l.length, 0)
  if (!total) {
    return {
      hay: false,
      motivo: 'The approved Vertical Slice Specification is from an older version of node 3.13: '
            + 'it has no §A7.1 inventory, so there is nothing to count. Re-run node 3.13.',
      porHoja: {}, sinClasificar: r.sinClasificar || [], avisos: [...avisoManifiesto, ...(r.avisos || [])],
    }
  }
  return conManifiesto(r, manifiesto, avisoManifiesto)
}

module.exports = { itemsDelAlcance, itemsDesdeSpec, A_LA_HOJA, seccion, filasDeTabla }
