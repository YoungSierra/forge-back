'use strict'

// Compositor de decks del nodo 3.20 (Art Style Guide / GDD ilustrado / Art Bible).
//
// El nodo NO dibuja: llena los placeholders de un workflow de ComfyUI ya registrado en
// `comfyui_workflows` y el renderer lo ejecuta. Cada página del workflow es un triplete
// independiente LoadImage → OpenAIGPTImage1 → SaveImage, con su PROPIO prompt: por eso el
// registro los marca `inject_config.mode = 'per_page'` y NO se pueden despachar por el camino
// de un prompt único de submitWorkflow.
//
// Los tres workflows comparten forma: un bloque delimitado con líneas «Etiqueta: [INSERT …]».
// Solo cambian el delimitador y el documento fuente. De ahí que haya un solo parser.
//
//   ASG (34 págs)  ━━━ ART DIRECTION INTAKE ━━━   4 de identidad + 1 propia    fuente 3.9 (ADI)
//   GDD (21 págs)  ---- GDD SOURCE DATA ----      1–16 campos por página       fuente 3.8 (GDD)
//   Art Bible (18) sin bloque                     1 caption opcional           fuente: IMÁGENES
//
// El Art Bible no se llena con texto: compone arte de producción APROBADO con un ImageBatch de
// dos LoadImage por página. Por eso su output va `production: "deferred"` y su trabajo real es
// el art_bible_selection_map, no este compositor.
//
// CLI de prueba (no gasta crédito, solo compone y reporta):
//   node src/services/slide-composer.service.js --workflow asg --project <uuid>
//   node src/services/slide-composer.service.js --workflow asg --page 9
//   node src/services/slide-composer.service.js --workflow asg --dump <dir>

const LIMITE = 32000   // límite duro del modelo de imagen
const MARGEN = 31000   // se recorta antes de llegar al límite

// ── Los tres decks ───────────────────────────────────────────────────────────
// `fuente` es el node_key del nodo cuyo documento aprobado alimenta el deck.
const DECKS = {
  asg:      { workflow: 'V57_STUDIO_ArtStyleGuide_Template',      fuente: '3.9', paginas: 34 },
  gdd:      { workflow: 'V57_STUDIO_Vertical_Slice_GDD_Template', fuente: '3.8', paginas: 21 },
  // El Art Bible no se llena desde un documento: cada página recibe su página YA APROBADA del ASG
  // y pinta la obra final de ese tema. Por eso no tiene `fuente` — su insumo es una imagen, no
  // texto. Pasó de 18 a 26 páginas con el rediseño del 24-ago.
  artbible: { workflow: 'V57_STUDIO_ArtBible_Template',            fuente: null, paginas: 26 },
}

// ── Mapa etiqueta de página → sección del documento fuente ───────────────────
// Autorado a mano y a propósito: medido contra el ADI vivo, el template y el ADD usan
// VOCABULARIO DISTINTO para lo mismo («Color System» ↔ «§0.4 Color Language»), así que ni el
// nombre exacto ni una heurística de subcadena sirven — la subcadena hacía que §2.1 Visual
// Pillars pareciera cubrir tres páginas diferentes.
//
// Se busca POR NOMBRE, no por número: el número es una posición y deriva cuando el ADD se
// renumera. Cada entrada es una lista de candidatos en orden de preferencia; gana el primero
// que exista en el documento.
//
// null = la página no se alimenta del documento del proyecto. Dos razones distintas:
//   SINTESIS → se deriva de las otras páginas ya generadas (portadas, índices, resúmenes)
//   ESTUDIO  → constante de V57, igual en todo proyecto → pertenece a un skill, no al ADI
const MAPA_ASG = {
  // Las 4 de identidad van IGUALES en las 34 páginas: son la voz del proyecto.
  'Core fantasy / visual soul': ['Core Fantasy Statement', 'Core Fantasy'],
  'Art style & rendering':      ['Approved Style', 'Art Style Definition'],
  'Color palette':              ['Closed 4-Role Palette', 'Color Language'],
  'Mood & tone':                ['Tone & Mood Matrix', 'Tone and Mood'],

  'Key Art':                   ['Art Style Definition', 'Visual Keywords'],
  'Visual DNA':                ['Visual Language', 'Visual Pillars'],
  'Visual Pillars':            ['Visual Pillars'],
  'Shape Language':            ['Shape Language'],
  'Character Design Language': ['Character Visual Language', 'Character Archetype Breakdown'],
  'Costume Language':          [],   // GAP real: el 3.9 no lo produce
  'Environment Language':      ['Environment Visual Language'],
  'Prop Language':             ['Props & Items Package', 'Item & Collectible'],
  'Color System':              ['Color Language', 'Closed 4-Role Palette'],
  'Lighting Language':         ['Lighting Package', 'Lighting Rules', 'Lighting'],
  'Material Language':         ['Material Language', 'Material Application'],
  'Texture Style':             ['Texture Approach'],
  'Detail Density':            [],   // GAP real
  'Visual Hierarchy':          ['Gameplay Readability', 'Visual Pillars'],
  'Camera Readability':        ['Gameplay Readability'],
  'Animation Style':           ['Animation Style Direction', 'Animation'],
  'VFX Language':              ['VFX', 'Key VFX List', 'Feedback Visual Standards'],
  'Video Marketing':           ['Marketing Art Package'],
  'UI Style':                  ['UI', 'Art Direction Document — Style Guide'],
  'Iconography':               [],   // GAP real
  'Asset Complexity':          ['Hero Asset Targets', 'Asset Breakdown'],
  'Production Rules':          ['Production Rules Summary', 'Production'],
  'AI Production Guidelines':  null, // ESTUDIO
  'Outsourcing Guide':         null, // ESTUDIO
  'Quality Checklist':         null, // ESTUDIO
  'One-Page Style Summary':    null, // SINTESIS
  'Asset Sheets (overview)':   null, // SINTESIS
  'Character Sheet':           ['Character Visual Language', 'Character Assets'],
  'Environment Sheet':         ['Environment Visual Language', 'Environment Assets'],
  'Prop Sheet':                ['Props & Items Package'],
  'UI Component Sheet':        [],   // GAP real
  'VFX Sheet':                 ['VFX', 'VFX Assets'],
  'Video Marketing Sheet':     ['Marketing Art Package'],
  'Appendices':                null, // SINTESIS
}

// El GDD guarda sus datos como CAMPOS en negrita dentro de las secciones, no como encabezados
// (`**Logline:** …`). Su vocabulario ya coincide con el del template en la mayoría, así que el
// mapa solo cubre lo que difiere: campos compuestos (array anidado = se combinan) y nombres que
// el documento escribe con su rango entre paréntesis.
const MAPA_GDD = {
  'Author':  'Fill from the project record — do not invent a name.',
  'Date':    'Fill with the export date of this deck.',
  'Version': 'Fill with the GDD version of the project.',

  'Genre + platform':   [['Primary genre', 'Target platform(s)']],
  'Camera + mode':      [['Camera / perspective', 'Player mode']],
  'Pillar 1':           [['Pillar 1 — Name', 'Pillar 1 — Definition']],
  'Pillar 2':           [['Pillar 2 — Name', 'Pillar 2 — Definition']],
  'Pillar 3':           [['Pillar 3 — Name', 'Pillar 3 — Definition']],
  'Pillar 4 (optional)': [['Pillar 4 — Name', 'Pillar 4 — Definition']],
  'Anti-pillars':       [['Anti-pillar 1', 'Anti-pillar 2', 'Anti-pillar 3']],
  'Core loop name':     ['Loop name'],
  // El core loop y los entornos viven como tabla; cada paso/entorno es una fila.
  'Step 1':             [{ seccion: 'Core Loop', fila: 1 }],
  'Step 2':             [{ seccion: 'Core Loop', fila: 2 }],
  'Step 3':             [{ seccion: 'Core Loop', fila: 3 }],
  'Step 4':             [{ seccion: 'Core Loop', fila: 4 }],
  'Environment 1':      [{ seccion: 'Environments', fila: 1 }],
  'Environment 2':      [{ seccion: 'Environments', fila: 2 }],
  'Environment 3':      [{ seccion: 'Environments', fila: 3 }],
  'Environment 4':      [{ seccion: 'Environments', fila: 4 }],
  'Economy source -> sink': ['Economy'],
  // Se resuelve dentro del ámbito de la línea (PROTAGONIST / ANTAGONIST / NPC-MENTOR).
  'Name/Age/Visual':    [['Name', 'Age', 'Visual description']],
  // OJO: el campo se llama «Abilities / actions». Sin esto la búsqueda se iba a la §8.3
  // Character Abilities y los tres personajes salían con el mismo texto.
  'Abilities':          ['Abilities / actions'],
  'Fail consequence':   ['Fail state consequence', 'Fail-state consequence'],
  'Partial success (optional)': ['Partial success state'],
  'Zone 1 baseline':    ['Zone 1 baseline (lives 1–2)', 'Zone 1 baseline'],
  'Recovery / hard cap / endgame': [['Recovery mechanic', 'Hard cap']],
  'Progression philosophy': ['Progression structure', 'Progression'],
  'Phases 1-2-3':       [['Phase 1 (early) — lives 1–4', 'Phase 2 (mid) — lives 5–9', 'Phase 3 (late) — lives 10–13']],
  'Unlockables (optional)': ['Unlockables'],
  'Anti-inflation rule': ['Anti-inflation rule 1'],
  'Carry limit':        ['Global carry limit'],
  'Carry-over':         ['Carry-over rule'],
  'Dialogue + VO scope': [['Dialogue scope', 'VO approach']],
  'Act 1 - Setup':      ['Act 1 — Setup (lives 1–4)', 'Act 1 — setup (lives 1–4)'],
  'Act 2 - Escalation': ['Act 2 — Escalation (lives 5–10)', 'Act 2 — escalation (lives 8–11)'],
  'Act 3 - Resolution': ['Act 3 — Resolution (lives 11–13)', 'Act 3 — resolution (lives 12–13)'],
  'Midpoint twist':     ['Midpoint twist (life 7)'],
  'Philosophy + structure + count': [['Level design philosophy', 'Tree structure', 'Total level count']],
  'Audio references':   [['Audio reference 1', 'Audio reference 2', 'Audio reference 3']],
  'Technical constraints': ['Technical constraints (design-side)'],
  'Success criteria':   ['Prototype success criteria'],
  'Deliverables':       ['Prototype deliverables'],
  'What invalidates it': ['What invalidates the concept'],
  'Production readiness': ['Production readiness criteria'],
  'Launch scope v1.0':  ['Launch scope — v1.0'],
  'Post-launch (optional)': ['Post-launch scope'],
  'Cuttable P1 / P2':   [['Cuttable feature — priority 1', 'Cuttable feature — priority 2']],
  'Non-negotiable':     ['Non-negotiable scope'],
  'Price per platform (one per row)': ['Price point per platform'],
  'IAP catalog (optional)': ['IAP catalog'],
}

// Etiquetas que piden una IMAGEN, no un dato: diagramas, mockups, key art, hojas de personaje.
// No son gaps del documento — el modelo las dibuja con lo que ya trae la página. Sin esta regla
// el deck reportaría 20 «faltantes» que nadie aguas arriba debe producir.
const RE_VISUAL = /\b(diagram|mockup|key ?art|sheets?|visuals?|greybox|map|thumbnails?|icon|turnaround|mood board|cover|hero|screen|frames?|timeline|roadmap|curve)\b/i

// ── Extracción por nombre ────────────────────────────────────────────────────
// Los encabezados llegan en varias formas según el asset: «### §0.3 Shape Language»,
// «## § 0.3 — Shape Language», «#### ADI_11.7 — Lighting Package». Se normaliza fuera el
// prefijo (§ / ADI_ / número / guión) y se compara solo el nombre, así una sola tabla sirve
// para todas.
const normalizar = s => String(s)
  .replace(/^#+\s*/, '')
  .replace(/^§?\s*(?:ADI_)?\s*[\d.]*\s*[—–·-]?\s*/, '')
  .replace(/[^a-z0-9]+/gi, ' ')
  .trim().toLowerCase()
  // El modelo escribe en inglés británico y el andamiaje del workflow en americano: los fills
  // decían «Colour palette» y el slot «Color palette», así que la búsqueda fallaba, se caía a
  // extraer del documento y metía la tabla entera de §0.4 —con encabezados y pipes— dentro de
  // las 34 prompts. Una diferencia de ortografía no puede decidir eso.
  .replace(/\bcolour/g, 'color')
  .replace(/\bgrey/g, 'gray')
  .replace(/\bcentre/g, 'center')

// Devuelve el bloque completo de la sección: su encabezado y todo hasta el siguiente
// encabezado de nivel igual o superior.
function seccionPorNombre(contenido, nombre) {
  const L = String(contenido || '').split('\n')
  const busca = normalizar(nombre)
  const i = L.findIndex(l => /^#{1,5} /.test(l) && normalizar(l) === busca)
  if (i < 0) return null
  const nivel = (L[i].match(/^#+/) || ['#'])[0].length
  const out = [L[i]]
  for (let j = i + 1; j < L.length; j++) {
    const m = L[j].match(/^(#+) /)
    if (m && m[1].length <= nivel) break
    out.push(L[j])
  }
  return out.join('\n').trim()
}

// ── Parser del bloque de intake ──────────────────────────────────────────────
// Un solo parser para los tres delimitadores. Devuelve null cuando el workflow no tiene
// bloque (el Art Bible), que NO es un error: significa que se llena con imágenes.
const DELIMITADORES = [
  /(━━━[^\n]*(?:INTAKE|SOURCE DATA)[^\n]*━+)\n([\s\S]*?)\n(━{4,})/,
  /(-{4}[^\n]*(?:INTAKE|SOURCE DATA)[^\n]*-{4})\n([\s\S]*?)\n(-{4,})/,
]

// Un campo es «Etiqueta: [INSERT …]». OJO: hay líneas con VARIOS en la misma
// (`PROTAGONIST - Name/Age/Visual: [INSERT …] - Mechanical role: [INSERT …]`), así que la
// etiqueta no puede llegar hasta el fin de línea — se corta en el placeholder anterior. Por eso
// la clase excluye corchetes y la sustitución se hace EN EL SITIO, no rearmando líneas.
const RE_CAMPO = /([^:\[\]\n]+?):[ \t]*(\[(?:INSERT|OPTIONAL)\b[^\]]*\])/g

// Prefijo de ENTIDAD al principio de la línea: `PROTAGONIST - Name/Age/Visual: [...] |
// Mechanical role: [...]`. Sin él, las tres fichas de personaje piden los mismos nombres de
// campo («Mechanical role», «Abilities») y las tres se resolvían a la PRIMERA aparición del
// documento — protagonista, antagonista y NPC salían con el texto idéntico, en silencio.
// El ámbito se fija al empezar la línea y lo heredan los campos que vienen detrás en ella.
const RE_ENTIDAD = /^([A-Z][A-Z0-9 /&'-]{2,30}?)\s*[-—–]\s+(?=[^\s])/

function parsearIntake(prompt) {
  for (const re of DELIMITADORES) {
    const m = String(prompt).match(re)
    if (!m) continue
    const campos = []
    // Se recorre por líneas para poder fijar el ámbito; el orden global se conserva porque el
    // bloque es lineal, y la sustitución posterior consume los valores en ese mismo orden.
    for (const linea of m[2].split('\n')) {
      const ent = linea.match(RE_ENTIDAD)
      const ambito = ent ? ent[1].trim() : null
      for (const c of linea.matchAll(RE_CAMPO)) {
        let cruda = c[1].replace(/^[\s|·-]+/, '').trim()
        if (ambito && cruda.startsWith(ambito)) cruda = cruda.slice(ambito.length).replace(/^\s*[-—–]\s*/, '').trim()
        // «This slide — Color System» y «This slide image - hero / cover» son la línea propia de
        // la página; el resto son campos comunes a todo el deck.
        const propia = /^This slide\b/i.test(cruda)
        campos.push({
          etiqueta: propia ? cruda.replace(/^This slide\s*(?:image)?\s*[—–-]?\s*/i, '').trim() : cruda,
          propia,
          ambito,
          pista: c[2],
        })
      }
    }
    return { abre: m[1], cierra: m[3], bloque: m[2], campos }
  }
  return null
}

// El GDD no guarda sus datos como secciones sino como campos en negrita DENTRO de la sección:
// «**Logline:** A witch's kitten familiar…». El extractor por encabezado no los ve — de ahí que
// el deck de 21 páginas saliera vacío. Toma el valor hasta la línea en blanco o el campo
// siguiente, así los campos de varios párrafos (Backstory, Setting) llegan enteros.
function campoPorNombre(contenido, etiqueta) {
  const L = String(contenido || '').split('\n')
  const busca = normalizar(etiqueta)
  for (let i = 0; i < L.length; i++) {
    const m = L[i].match(/^\s*[-*]?\s*\*\*([^*:]{2,60}):\*\*\s*(.*)$/)
    if (!m || normalizar(m[1]) !== busca) continue
    const out = m[2] ? [m[2].trim()] : []
    for (let j = i + 1; j < L.length; j++) {
      if (/^\s*\*\*[^*:]{2,60}:\*\*/.test(L[j]) || /^#{1,6} /.test(L[j])) break
      if (!L[j].trim() && out.length) break
      if (L[j].trim()) out.push(L[j].trim())
    }
    if (out.length) return out.join('\n')
  }
  return null
}

// Y un tercer caso: datos que el GDD guarda como FILAS de una tabla, no como campos. Los pasos
// del core loop y los entornos son eso — el deck pide «Step 1…4» y «Environment 1…4» y el
// documento tiene una tabla de 4 filas. Devuelve la fila n-ésima como «Columna: valor · …».
function filaDeTabla(contenido, seccion, n) {
  const bloque = seccionPorNombre(contenido, seccion)
  if (!bloque) return null
  const L = bloque.split('\n')
  const i = L.findIndex(l => l.trim().startsWith('|'))
  if (i < 0 || !/^\s*\|[\s:|-]+\|\s*$/.test(L[i + 1] || '')) return null
  const celdas = l => l.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim())
  const cab = celdas(L[i])
  const filas = []
  for (let j = i + 2; j < L.length && L[j].trim().startsWith('|'); j++) filas.push(celdas(L[j]))
  const f = filas[n - 1]
  if (!f) return null
  return cab.map((c, k) => f[k] && `${c}: ${f[k]}`).filter(Boolean).join(' · ')
}

// ── Composición ──────────────────────────────────────────────────────────────

// Busca el texto de una etiqueta y devuelve { texto, via } o null.
//   array          → candidatos en orden de preferencia, gana el primero que exista
//   array anidado  → los combina TODOS (`Genre + platform` = género + plataforma)
//   null           → la página no se alimenta del documento (síntesis o constante de estudio)
//   string         → instrucción literal, no se busca nada
// Si la etiqueta no está en el mapa se busca ella misma, que en el GDD acierta casi siempre.
// Cada candidato se prueba primero como SECCIÓN y luego como CAMPO en negrita.
function resolverEtiqueta(etiqueta, mapa, assets, ambito = null) {
  const cands = Object.prototype.hasOwnProperty.call(mapa, etiqueta) ? mapa[etiqueta] : [etiqueta]
  if (cands === null) return { texto: null, noAplica: true }
  if (typeof cands === 'string') return { texto: null, noAplica: true, instruccion: cands }

  // Con ámbito se busca SOLO dentro de esa sección. Si la sección no existe no se cae de vuelta
  // al documento entero: eso es lo que devolvía el personaje equivocado. Mejor un gap visible.
  const cuerpos = ambito
    ? assets.map(a => seccionPorNombre(a.content, ambito)).filter(Boolean)
    : assets.map(a => a.content)
  if (ambito && !cuerpos.length) return null

  const uno = nombre => {
    for (const texto of cuerpos) {
      // { seccion, fila } → la fila n-ésima de la tabla de esa sección
      if (typeof nombre === 'object') {
        const f = filaDeTabla(texto, nombre.seccion, nombre.fila); if (f) return f
        continue
      }
      const s = seccionPorNombre(texto, nombre); if (s) return s
      const c = campoPorNombre(texto, nombre);   if (c) return c
    }
    return null
  }
  for (const c of cands) {
    if (Array.isArray(c)) {
      const partes = c.map(x => { const t = uno(x); return t && `${x}: ${t}` }).filter(Boolean)
      if (partes.length) return { texto: partes.join(' · '), via: c.join(' + ') }
      continue
    }
    const t = uno(c)
    if (t) return { texto: t, via: c }
  }
  return null
}

// ── FILLS (v2.9.7) ───────────────────────────────────────────────────────────
// El diseño de Pedro, y es mejor que el nuestro. Nosotros copiábamos secciones enteras del ADD
// en CADA slide: prompts de hasta 29.773 de un límite de 32.000, con la página 19 recortada a
// mano. Él midió la causa real — el límite es de ENTRADA a ComfyUI, y el digest se pega en las 34
// páginas, así que su tamaño se multiplica. Medido en el deck del GDD: 21 prompts, 44.240 chars,
// promedio 2.106, y el 77% de dos prompts cualesquiera es idéntico. Lo variable son ~490 chars.
//
// Entonces el LLM escribe FILLS, nunca prompts: un digest de 1.200 chars una sola vez + una línea
// de 250 por slide. El ensamblado es determinista — mismos fills, mismo prompt byte a byte.
//
// Lo elegante es que los fills son EXACTAMENTE los valores de los placeholders que ya parseamos.
// Así que el mecanismo no cambia: cambia de dónde sale el valor. Por eso el compositor acepta las
// dos fuentes y, sin fills, sigue comportándose como hasta hoy — que es lo que permite publicar
// este código ANTES de tocar la DNA en la base.
const LIMITE_DIGEST = 1200
const LIMITE_LINEA  = 250

// Los fills llegan como texto del LLM: las 4 líneas de identidad y una `This slide — X:` por
// página. Se devuelven como mapa etiqueta → valor, con la misma normalización que usa el intake,
// para que un guion largo o una mayúscula no rompan la correspondencia.
function parsearFills(texto) {
  const m = new Map()
  // Las etiquetas que venian como `This slide - X` son de UNA pagina; el resto es el digest, que
  // se repite en todas. La distincion importa para medir cada limite contra lo suyo.
  m.propias = new Set()
  if (!texto) return m
  let etiqueta = null, buffer = []
  const cerrar = () => {
    if (!etiqueta) return
    m.set(etiqueta, buffer.join('\n').trim())
    buffer = []
  }
  for (const linea of String(texto).split('\n')) {
    const mm = linea.match(/^\s*(?:[-*]\s*)?(?:\*\*)?([^:*\n]{2,80}?)(?:\*\*)?:\s*(.*)$/)
    if (mm && !/^https?$/i.test(mm[1].trim())) {
      cerrar()
      const cruda = mm[1].trim()
      etiqueta = cruda.replace(/^This slide\s*(?:image)?\s*[—–-]?\s*/i, '').trim()
      if (/^This slide[\s—–-]/i.test(cruda + ' ')) m.propias.add(normalizar(etiqueta))
      buffer = mm[2] ? [mm[2].trim()] : []
    } else if (etiqueta && linea.trim()) {
      buffer.push(linea.trim())
    }
  }
  cerrar()
  return m
}

// Busca en los fills tolerando diferencias de forma en la etiqueta.
function fillDe(fills, etiqueta) {
  if (!fills?.size) return null
  if (fills.has(etiqueta)) return fills.get(etiqueta)
  const buscado = normalizar(etiqueta)
  for (const [k, v] of fills) if (normalizar(k) === buscado) return v
  return null
}

/**
 * Compone las N páginas de un deck.
 *
 * @param {object}  o
 * @param {Function} o.db          cliente de supabase.service
 * @param {string}  o.projectId
 * @param {string}  o.deck         'asg' | 'gdd' | 'artbible'
 * @param {string}  [o.fills]      texto del output `*_fills` (v2.9.7). Sin esto se extrae del
 *                                 documento fuente, que es el comportamiento anterior.
 * @param {number[]} [o.solo]      índices de página (1-based) a componer — para las dos pasadas
 * @returns {Promise<{deck, workflow, paginas, avisos}>}
 */
async function composeDeck({ db, projectId, deck = 'asg', fills = null, solo = null }) {
  const cfg = DECKS[deck]
  if (!cfg) throw new Error(`deck desconocido: ${deck}`)

  const { data: wfRow, error: e1 } = await db().from('comfyui_workflows')
    .select('name,workflow_json,inject_config').eq('name', cfg.workflow).single()
  if (e1 || !wfRow) throw new Error(`workflow no registrado: ${cfg.workflow}`)

  const wf = wfRow.workflow_json
  const paginasCfg = wfRow.inject_config?.pages || []
  if (paginasCfg.length !== cfg.paginas) {
    throw new Error(`${cfg.workflow}: el registro tiene ${paginasCfg.length} páginas y la DNA declara ${cfg.paginas}`)
  }

  const avisos = []

  // Documento fuente. El Art Bible no tiene: se llena con imágenes.
  let assets = []
  if (cfg.fuente) {
    const { data: n } = await db().from('forge_nodes').select('id').eq('node_key', cfg.fuente).single()
    if (!n) throw new Error(`no existe el nodo fuente ${cfg.fuente}`)
    const { data } = await db().from('forge_assets').select('name,content')
      .eq('project_id', projectId).eq('node_id', n.id).in('status', ['approved', 'auto_approved'])
    assets = data || []
    if (!assets.length) avisos.push(`node ${cfg.fuente} has no approved assets in this project`)
  }

  const mapa = deck === 'gdd' ? MAPA_GDD : MAPA_ASG
  const mapaFills = parsearFills(fills)

  // Control de tamano de los fills: son un limite de la DNA, no una sugerencia. El digest se
  // multiplica por cada pagina, asi que pasarse aca es lo que hace fallar el workflow entero.
  if (mapaFills.size) {
    const digest = [...mapaFills.entries()]
      .filter(([k]) => !mapaFills.propias.has(normalizar(k)))
      .reduce((n, [, v]) => n + v.length, 0)
    if (digest > LIMITE_DIGEST) avisos.push(`the digest is ${digest} chars, over the ${LIMITE_DIGEST} limit`)
    for (const [k, v] of mapaFills) {
      if (mapaFills.propias.has(normalizar(k)) && v.length > LIMITE_LINEA) {
        avisos.push(`line "${k}" is ${v.length} chars, over the ${LIMITE_LINEA} limit`)
      }
    }
  }

  const paginas = paginasCfg.map((p, i) => {
    // Subconjunto: las dos pasadas del ASG comparten workflow (31 de contenido + 3 de sintesis)
    if (solo && !solo.includes(i + 1)) return null
    const prompt = wf[p.prompt_node]?.inputs?.prompt || ''
    const intake = parsearIntake(prompt)
    const pag = {
      indice: i + 1,
      nombre: p.name,
      prompt_node: p.prompt_node,
      save_node: p.save_node,
      image_input: p.image_input,
      llenos: [],
      faltantes: [],
      recortado: false,
      prompt,
    }

    // Sin bloque: el prompt viaja tal cual (Art Bible, portadas sin campos).
    if (!intake) return pag

    // Un valor por placeholder, EN EL MISMO ORDEN en que aparecen en el bloque: la sustitución
    // los consume en secuencia, así el template conserva su formato y las líneas con varios
    // campos (la 13, personajes) no se rompen.
    const valores = intake.campos.map(c => {
      // Los fills mandan cuando estan: son lo que el LLM escribio para ESTE deck. Sin ellos se
      // extrae del documento, que es como venia funcionando antes de v2.9.7.
      // La línea de una página puede venir rotulada con la etiqueta del intake («Color System»)
      // o con el nombre del archivo («09_ColorSystem»). El LLM usa cualquiera de las dos, así que
      // se aceptan ambas en vez de exigirle una forma que no controlamos.
      const desdeFills = fillDe(mapaFills, c.etiqueta) ?? (c.propia ? fillDe(mapaFills, p.name) : null)
      const r = desdeFills != null
        ? { texto: desdeFills, via: 'fills' }
        : resolverEtiqueta(c.etiqueta, mapa, assets, c.ambito)
      if (r?.noAplica) {
        // No es un gap del proyecto: nadie debe producirlo aguas arriba.
        pag.llenos.push({ etiqueta: c.etiqueta, via: 'no aplica' })
        return { fijo: r.instruccion || '[derive from the other slides of this deck and V57 studio standards]' }
      }
      // Solo en el GDD: ahí los paneles de imagen conviven con campos de datos y se distinguen
      // por el nombre. En el ASG toda página es una obra y la etiqueta nombra su TEMA, así que
      // si el tema no está en el ADI es un gap de verdad — la regla se tragaba «UI Component
      // Sheet», que es justo una de las páginas sin fuente.
      if (!r && deck !== 'asg' && RE_VISUAL.test(c.etiqueta)) {
        pag.llenos.push({ etiqueta: c.etiqueta, via: 'visual' })
        return { fijo: '[draw this from the data already on this slide — do not add text of your own]' }
      }
      if (!r) {
        pag.faltantes.push(c.etiqueta)
        return { fijo: `[UPSTREAM GAP: "${c.etiqueta}" — el documento del nodo ${cfg.fuente} no lo produjo. NO lo inventes: escribe «TBD».]` }
      }
      pag.llenos.push({ etiqueta: c.etiqueta, via: r.via, chars: r.texto.length })
      return { texto: r.texto }
    })

    // Recorte por CAMPO, no por línea: la sección más gorda puede ser cientos de líneas cortas
    // (así se escapó la página 19 con 64.000 caracteres). Se acorta siempre el campo más grande,
    // para no vaciar uno entero mientras otro se lleva 20.000.
    // El reemplazo va por función para que un `$&` dentro del documento no se interprete.
    const armar = () => {
      let k = 0
      const cuerpo = intake.bloque.replace(RE_CAMPO, (_, lab) => {
        const v = valores[k++]
        const t = v.fijo ?? v.texto
        // Un valor multilínea baja de renglón; uno corto se queda junto a su etiqueta.
        return `${lab}:${t.includes('\n') ? '\n' : ' '}${t}`
      })
      return prompt.replace(intake.bloque, () => cuerpo)
    }
    let vueltas = 0
    while (armar().length > MARGEN && vueltas++ < 200) {
      const gordos = valores.filter(v => !v.fijo)
      if (!gordos.length) break
      const max = gordos.reduce((a, b) => (b.texto.length > a.texto.length ? b : a))
      if (max.texto.length < 300) break                     // ya no hay de dónde recortar
      pag.recortado = true
      // Se quita la marca anterior antes de volver a cortar: si no, cada vuelta rebana la marca
      // por la mitad y deja basura a medias dentro del texto.
      const limpio = max.texto.replace(/\n\[…recortado[^\]]*\]$/, '')
      max.texto = limpio.slice(0, Math.floor(limpio.length * 0.85)).trimEnd() + '\n[…recortado por el límite de 32.000 caracteres]'
    }
    pag.prompt = armar()
    if (pag.prompt.length > LIMITE) avisos.push(`página ${i + 1} ${p.name}: ${pag.prompt.length} chars > ${LIMITE}`)
    return pag
  })

  // `solo` deja huecos en el arreglo (una pasada compone su subconjunto); se descartan acá para
  // que quien consuma reciba solo páginas reales.
  const vivas = paginas.filter(Boolean)

  // Verificación de tamaño ANTES de despachar, que es lo que pide la DNA: el límite es de entrada
  // a ComfyUI y una sola página excedida hace fallar el job entero.
  for (const p of vivas) {
    if (p.prompt.length > LIMITE) avisos.push(`page ${p.indice} ${p.nombre}: ${p.prompt.length} chars > ${LIMITE}`)
  }

  // La medición de los fills viaja con el resultado: es lo que hay que poder mirar antes de
  // despachar, y lo mismo que va a mostrar el panel de revisión.
  const medida = mapaFills.size ? (() => {
    const propias = [...mapaFills.entries()].filter(([k]) => mapaFills.propias.has(normalizar(k)))
    const digest  = [...mapaFills.entries()].filter(([k]) => !mapaFills.propias.has(normalizar(k)))
    return {
      digest_chars: digest.reduce((n, [, v]) => n + v.length, 0),
      digest_limite: LIMITE_DIGEST,
      lineas: propias.length,
      linea_max: propias.reduce((n, [, v]) => Math.max(n, v.length), 0),
      linea_limite: LIMITE_LINEA,
    }
  })() : null

  return { deck, workflow: cfg.workflow, fuente: cfg.fuente, paginas: vivas, avisos, fills: medida }
}

module.exports = {
  composeDeck, parsearIntake, parsearFills, seccionPorNombre,
  DECKS, MAPA_ASG, MAPA_GDD, LIMITE_DIGEST, LIMITE_LINEA, LIMITE,
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const path = require('path'), fs = require('fs')
  require('dotenv').config({ path: path.join(__dirname, '../../.env') })
  const { db } = require('./supabase.service')
  const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null }
  const deck = arg('--workflow') || 'asg'
  const projectId = arg('--project') || process.env.ASG_PROJECT || '8884b396-11c6-49dc-867a-f81eed897257'
  const una = Number(arg('--page')) || null
  const dump = arg('--dump')

  composeDeck({ db, projectId, deck }).then(r => {
    if (una) {
      const p = r.paginas.find(x => x.indice === una)
      console.log(`\n═══ ${p.indice} · ${p.nombre} · ${p.prompt.length} chars ═══\n`)
      console.log(p.prompt)
      return
    }
    console.log(`\n${r.workflow} · proyecto ${projectId.slice(0, 8)} · fuente ${r.fuente || '(imágenes)'}\n`)
    console.log('  #  página                    prompt  llenos  faltan')
    console.log('  ' + '─'.repeat(56))
    for (const p of r.paginas) {
      console.log(`  ${String(p.indice).padStart(2)}  ${String(p.nombre).padEnd(24)} ${String(p.prompt.length).padStart(6)}` +
        `${String(p.llenos.length).padStart(8)}${p.faltantes.length ? String(p.faltantes.length).padStart(8) : '       ·'}` +
        (p.recortado ? '  ✂' : ''))
    }
    const largos = r.paginas.map(p => p.prompt.length)
    console.log('  ' + '─'.repeat(56))
    console.log(`  prompt: min ${Math.min(...largos)} · max ${Math.max(...largos)} · límite ${LIMITE}`)
    const gaps = {}
    r.paginas.forEach(p => p.faltantes.forEach(f => { (gaps[f] ??= []).push(p.indice) }))
    const ent = Object.entries(gaps).sort((a, b) => b[1].length - a[1].length)
    console.log(`  páginas con faltante: ${r.paginas.filter(p => p.faltantes.length).length}/${r.paginas.length}`)
    ent.forEach(([f, ps]) => console.log(`     ${f.padEnd(30)} ${ps.length}×  págs ${ps.join(', ')}`))
    r.avisos.forEach(a => console.log(`  ⚠ ${a}`))
    if (dump) {
      fs.mkdirSync(dump, { recursive: true })
      r.paginas.forEach(p => fs.writeFileSync(path.join(dump, `${String(p.indice).padStart(2, '0')}_${p.nombre}.txt`), p.prompt, 'utf8'))
      console.log(`\n  ${r.paginas.length} prompts escritos en ${dump}`)
    }
  }).catch(e => { console.error('ERR', e.message); process.exit(1) })
}
