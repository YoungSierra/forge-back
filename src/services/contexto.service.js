// ─── «Agregar contexto»: dónde va lo que alguien sube ────────────────────────
//
// Subir una referencia no es adjuntarla: es decidir A QUÉ PÁGINA entra, con qué estado y bajo qué
// sección del ADI queda anclada. Esa decisión la tomaba una persona de memoria y por eso el sector
// del radial nunca se encendió.
//
// El flujo son cuatro pasos (handoff de Miguel del 14-09, §2): entrada → dos o tres preguntas →
// destino propuesto → aprobación. Acá vive el tercero, que es el único con reglas: cruzar el rol y
// el ámbito contra el catálogo de fuentes y el mapeo página→§ADI, y proponer UN destino principal
// con dos o tres alternativas. Nunca decide solo: propone y una persona confirma.
//
// Lo que este archivo NO hace, a propósito: inventar un destino cuando no lo sabe. Si el rol pide
// inyección directa y la página todavía no tiene su hueco `REF_*` —17 de las 25 no lo tienen—, el
// destino cae al bloque de identidad y se DICE. Es el fallback que el propio handoff fija: el
// contexto influye por el §ADI en vez de inyectarse, y nadie se queda pensando que entró donde no.

// Página del ASG → sección(es) del ADI V6 que la gobiernan. Es la §5 del documento del sistema de
// actualización, que existe justamente para esto: es el ancla que cada activo lleva de metadato.
const ADI_DE_PAGINA = {
  '01_KeyArt':                '§1.2 Core Fantasy · §2.1 Visual Pillars · §5.1 Approved Style · §6.1 Hero Asset Targets',
  '02_VisualDNA':             '§2.1 Visual Pillars · §2.2 Tone & Mood · §2.3 Visual Keywords · §5.1 Approved Style',
  '03_VisualPillars':         '§2.1 Visual Pillars · §2.1.1 Narrative/Progression Visual Arc',
  '04_ShapeLanguage':         'ADI Shape Language · §5.1 Approved Style · §7.1 Gameplay Readability',
  '05_CharacterDesign':       '§7.2 Character Visual Language · §7.2.1',
  '06_EnvironmentLanguage':   '§7.3 Environment Visual Language · §6.2 Environment Targets',
  '07_PropLanguage':          '§7.7 Item & Collectible Visual Language',
  '08_ColorSystem':           '§2.2 Tone & Mood Matrix · §5.1 Approved Style',
  '09_LightingLanguage':      '§7.5 Material & Rendering Philosophy · §6.2 Environment Targets',
  '10_TextureStyle':          '§7.5 Material & Rendering Philosophy',
  '11_Readability':           '§7.1 Gameplay Readability Standards',
  '12_AnimationLanguage':     '§7.9 Animation Style Direction',
  '13_VFXLanguage':           '§8.4 VFX Breakdown · §7.6 Feedback Visual Standards',
  '14_AudioLanguage':         '§7.10 Audio Direction',
  '15_VideoMarketing':        '§7.11 Marketing Video Direction',
  '16_UILanguage':            '§6.3 UI Visual Direction · §8.3 UI Asset Breakdown',
  '17_AssetSheets':           '§8 Asset Breakdown (overview)',
  '18_CharacterSheet':        '§8.1 Character Asset Breakdown (consume §7.2)',
  '19_EnvironmentSheet':      '§8.2 Environment Asset Breakdown (consume §7.3)',
  '20_PropSheet':             '§8.1 / §8.5 (consume §7.7; material §7.5)',
  '21_UIComponentSheet':      '§8.3 UI Asset Breakdown (consume §6.3)',
  '22_VFXSheet':              '§8.4 VFX Breakdown (consume §7.6)',
  '23_AudioSheet':            '§7.10.1 Audio Asset Breakdown (consume §7.10)',
  '24_AnimationSheet':        '§7.9.1 Animation Asset Breakdown (consume §7.9)',
  '25_VideoMarketingSheet':   '§7.11.1 Marketing Video Breakdown (consume §7.11)',
}

// Las ocho páginas que YA tienen hueco de referencia en el workflow. Las otras diecisiete lo
// necesitan y es un cambio del `.json` que le toca a dirección de arte (§3 del handoff); hasta que
// llegue, el destino cae al bloque de identidad en vez de prometer una inyección que no ocurre.
const CON_SLOT_REF = new Set([
  '01_KeyArt', '02_VisualDNA', '03_VisualPillars', '04_ShapeLanguage',
  '05_CharacterDesign', '06_EnvironmentLanguage', '08_ColorSystem', '09_LightingLanguage',
])

const IDENTIDAD = {
  clave: 'identidad',
  titulo: 'Identity block (ADI)',
  adi: '§5.1 Approved Style · §2.2 Tone & Mood · §7.5 Material & Rendering',
  porque: 'It governs every page that its ADI section covers, through the page→§ADI map.',
}

/** Los cuatro roles del paso 2, con lo que cada uno hace. Es la tabla del §2 del handoff. */
const ROLES = {
  referencia_aprobada: {
    etiqueta: 'Approved style reference',
    estado: 'approved',
    directo: true,
    porque: 'It goes into the page\'s REF_* slot, so the model sees it while generating.',
  },
  ejemplo_a_evitar: {
    etiqueta: 'Example to avoid',
    estado: 'rejected',
    directo: false,
    // No entra al modelo: gpt-image-2 no tiene prompt negativo, así que es filtro curatorial y
    // alimenta el §3.2 del ADI. Meterlo como referencia lograría lo contrario de lo que se pide.
    destinoFijo: { clave: 'negativas', titulo: 'ADI §3.2 Negative References', adi: '§3.2 Negative References',
                   porque: 'Rejected references never reach the model: they are a curatorial filter.' },
  },
  especificacion_de_asset: {
    etiqueta: 'Asset specification',
    estado: 'approved',
    directo: true,
    porque: 'It attaches to that asset sheet and inherits its §ADI anchor.',
  },
  identidad: {
    etiqueta: 'Identity (palette / light / material / style)',
    estado: 'approved',
    directo: false,
    destinoFijo: IDENTIDAD,
    porque: 'Identity is not one page: it governs every page its ADI section covers.',
  },
}

const AMBITOS = new Set(['proyecto', 'pagina', 'ficha'])

/**
 * A dónde va este contexto: un destino principal y dos o tres alternativas.
 *
 * `cual` es la página o la ficha que eligió el usuario en la P3. Si no la sabe —el propio handoff
 * lo contempla— el ámbito manda y el destino cae en identidad, que es el único sitio que vale para
 * cualquier página.
 */
function resolverDestino({ rol, ambito, cual = null, formato = 'imagen' }) {
  const def = ROLES[rol]
  if (!def) { const e = new Error(`unknown context role: "${rol}"`); e.code = 'ROL_DESCONOCIDO'; throw e }
  if (!AMBITOS.has(ambito)) { const e = new Error(`unknown scope: "${ambito}"`); e.code = 'AMBITO_DESCONOCIDO'; throw e }

  const avisos = []
  const alternativas = []

  // Los roles con destino fijo no dependen del ámbito: evitar es evitar, e identidad es identidad.
  if (def.destinoFijo) {
    return {
      rol, ambito, estado: def.estado,
      principal: { ...def.destinoFijo, inyeccion: 'indirecta' },
      alternativas: [], avisos, formato,
    }
  }

  // Texto nunca se inyecta como imagen: entra al §ADI y desde ahí influye. Lo dice el handoff
  // —«texto → se incorpora a la sección §ADI correspondiente vía el nodo 3.9»—, y es también lo
  // único que puede hacerse: un `Load Image` no carga un párrafo.
  if (formato === 'texto') {
    const pagina = ambito !== 'proyecto' && cual ? cual : null
    return {
      rol, ambito, estado: def.estado, formato,
      principal: pagina
        ? { clave: 'adi_pagina', titulo: `ADI section of ${pagina}`, adi: ADI_DE_PAGINA[pagina] || null,
            pagina, inyeccion: 'indirecta', porque: 'Text feeds the ADI section that governs this page, through node 3.9.' }
        : { ...IDENTIDAD, inyeccion: 'indirecta' },
      alternativas: pagina ? [{ ...IDENTIDAD, inyeccion: 'indirecta' }] : [],
      avisos,
    }
  }

  if (ambito === 'proyecto' || !cual) {
    if (ambito !== 'proyecto') avisos.push('No page or sheet was named, so it lands on the identity block')
    return { rol, ambito, estado: def.estado, formato, principal: { ...IDENTIDAD, inyeccion: 'indirecta' }, alternativas: [], avisos }
  }

  const adi = ADI_DE_PAGINA[cual] || null
  if (!adi) avisos.push(`“${cual}” is not one of the 25 ASG pages: its §ADI anchor is unknown`)

  // El hueco de referencia decide si la inyección es directa o cae al ADI. No prometerla cuando no
  // existe es el fallback declarado en el handoff.
  const tieneSlot = CON_SLOT_REF.has(cual)
  if (!tieneSlot) {
    avisos.push(`“${cual}” has no REF_* slot yet, so the reference cannot be injected into it directly; `
              + 'it lands on the identity block and influences the page through its ADI section')
  }

  const principal = tieneSlot
    ? { clave: 'pagina', titulo: `REF_* slot of ${cual}`, pagina: cual, adi, inyeccion: 'directa', porque: def.porque }
    : { ...IDENTIDAD, inyeccion: 'indirecta', pagina_pedida: cual, adi_de_la_pagina: adi }

  // Alternativas: lo que un humano elegiría si el principal no es lo que quería.
  if (tieneSlot) alternativas.push({ ...IDENTIDAD, inyeccion: 'indirecta' })
  else if (adi) alternativas.push({ clave: 'adi_pagina', titulo: `ADI section of ${cual}`, adi, pagina: cual, inyeccion: 'indirecta' })
  alternativas.push({ clave: 'negativas', titulo: 'ADI §3.2 Negative References', adi: '§3.2 Negative References',
                      inyeccion: 'ninguna', porque: 'If it is an example to avoid rather than a reference to follow.' })

  return { rol, ambito, estado: def.estado, formato, principal, alternativas, avisos }
}

/**
 * Paso 4: aprobar. Deja el contexto guardado con sus metadatos y dispara lo que toca.
 *
 * Tres cosas, y las tres se devuelven dichas para que nadie tenga que suponer cuál ocurrió:
 *   · el activo queda escrito con su Historial Inbound, su estado, su página destino y su §ADI;
 *   · queda colgado del nodo 3.9, que es de donde el motor toma las referencias del proyecto;
 *   · si el destino es una página concreta, se dispara la cascada de actualización sobre ella.
 *
 * Un contexto rechazado —«ejemplo a evitar»— se guarda igual: es filtro curatorial, tiene que
 * poder consultarse, y es lo que alimenta el §3.2 del ADI. Lo que no hace es entrar al modelo.
 */
async function guardarContexto({
  db, project_id, nombre, url = null, texto = null, destino, rol, ambito,
  estado = 'approved', primary = false, member_id = null,
}) {
  if (!url && !texto) { const e = new Error('Nothing to store: neither a file nor text'); e.code = 'VACIO'; throw e }

  const { data: n39 } = await db().from('forge_nodes').select('id').eq('node_key', '3.9').maybeSingle()

  const { data: ses } = await db().from('forge_sessions').insert({
    project_id, node_id: n39?.id || null, output_key: 'reference_images',
    status: 'auto_approved', iteration_count: 1,
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    triggered_by: member_id,
  }).select('id').single()

  const { data: activo, error } = await db().from('forge_assets').insert({
    project_id, node_id: n39?.id || null, session_id: ses?.id || null,
    name: nombre,
    format: url ? 'png' : 'md',
    mime_type: url ? 'image/png' : 'text/markdown',
    storage_url: url, content: texto,
    // `rejected` es un estado real acá: el ejemplo a evitar se conserva y se consulta, no se borra.
    status: estado === 'rejected' ? 'rejected' : 'approved',
    approved_by: estado === 'rejected' ? null : member_id,
    approved_at: estado === 'rejected' ? null : new Date().toISOString(),
    metadata: {
      contexto: {
        rol, ambito, estado,
        primary: Boolean(primary),
        pagina_destino: destino?.pagina || destino?.pagina_pedida || null,
        ancla_adi: destino?.adi || destino?.adi_de_la_pagina || null,
        inyeccion: destino?.inyeccion || 'indirecta',
        // Historial Inbound: de dónde vino y cuándo. Es lo que pide el §1 del documento del
        // sistema de actualización como metadato de trazabilidad.
        inbound: [{ en: new Date().toISOString(), por: member_id, via: 'add_context', destino: destino?.clave || null }],
        nodos_heredados: ['3.9'],
      },
    },
  }).select('id, name, storage_url, status').single()
  if (error) throw error

  // La cascada: si el contexto entra en una página concreta, lo que depende de ella queda para
  // revisar. No se regenera nada — es marca y gate humano, como en todo el sistema.
  let cascada = null
  const pagina = destino?.pagina || null
  if (pagina) {
    const { data: hoja } = await db().from('forge_assets').select('id')
      .eq('project_id', project_id).like('name', `%${pagina}%`).limit(1).maybeSingle()
    if (hoja) {
      const { propagarDesdePagina } = require('./actualizacion.service')
      cascada = await propagarDesdePagina({
        db, project_id, asset_id: hoja.id, member_id,
        motivo: `new context: ${nombre}`,
      }).catch(e => ({ aplica: false, motivo: e.message }))
    }
  }

  return { activo, cascada, alimenta_3_9: Boolean(n39?.id) }
}

module.exports = { resolverDestino, guardarContexto, ROLES, AMBITOS, ADI_DE_PAGINA, CON_SLOT_REF, IDENTIDAD }
