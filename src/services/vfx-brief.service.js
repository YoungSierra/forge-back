// ─── El Brief y la descripción del Run de la VFX Sheet ───────────────────────
//
// De dónde salen. De los `asg_fills` del 3.20 de ESA instancia, no del ADI. Lo decidió Miguel León
// el 13-oct y la razón es buena: los fills son el texto con el que se dibujó esa hoja, así que el
// video y la hoja dicen lo mismo. El ADI es el catálogo de TODOS los efectos y obligaría a adivinar
// cuál es la fila que toca.
//
// OJO, lo que hoy no funciona y conviene no descubrir corriendo: **los fills no traen estos
// campos**. Medido el 13-oct sobre los seis proyectos que tienen `asg_fills` producido — cero
// EFFECT, cero TRIGGER, cero PARTICLE BUDGET, cero LIFECYCLE, cero COLOR USAGE. El prompt del 3.20
// sí los pide; el modelo no los escribe. Así que esto devuelve el Brief con casi todo en blanco
// hasta que eso se arregle del lado de Pedro.
//
// Eso NO es un fallo de acá: es la regla de Miguel aplicada —«deja un campo en blanco si la hoja no
// lo tiene, no inventes valores»— y por eso el Brief sale editable en la ventana de Run, para que
// Dirección de Arte complete a mano lo que falte.

const { parsearFills, fillDe } = require('./slide-composer.service')

/**
 * La equivalencia que fijó Miguel (§3.3 del documento v1.1).
 *
 * `rotulo` es la línea del nodo 200, tal cual, con su flecha. `de` son los nombres con los que ese
 * dato puede venir en los fills: se prueban en orden y gana el primero que exista, porque la hoja
 * no siempre los llama igual y `fillDe` ya tolera diferencias de forma.
 */
const EQUIVALENCIAS = [
  { rotulo: 'ASSET / ID',        de: ['EFFECT NAME', 'EFFECT ID', 'EFFECT NAME/ID', 'ASSET / ID', 'ASSET ID'] },
  { rotulo: 'EFFECT (what it is)', de: ['EFFECT'] },
  { rotulo: 'TRIGGER / EVENT',   de: ['TRIGGER / EVENT', 'TRIGGER', 'EVENT'] },
  { rotulo: 'CATEGORY',          de: ['CATEGORY'] },
  { rotulo: 'PRIORITY TIER',     de: ['PRIORITY TIER', 'PRIORITY'] },
  { rotulo: 'PARTICLE BUDGET',   de: ['PARTICLE BUDGET'] },
  { rotulo: 'READABILITY RULES', de: ['READABILITY', 'READABILITY RULES'] },
  { rotulo: 'COLOR USAGE (hex · role · limits)', de: ['COLOR USAGE'] },
]

// El ciclo de vida se parte en tres renglones del Brief. En los fills viene junto, bajo LIFECYCLE.
const CICLO = [
  { rotulo: 'START keyframe',     parte: 'START' },
  { rotulo: 'PEAK keyframe',      parte: 'PEAK' },
  { rotulo: 'DISSIPATE keyframe', parte: 'DISSIPATE' },
]

// Nunca se rellena: no está en los fills y Miguel pidió explícitamente dejarlo vacío antes que
// deducirlo. Un host inventado es justo lo que el workflow tiene prohibido dibujar.
const HOST = 'HOST ASSET (… CONTEXT ONLY, NEVER RENDER IT)'

/** De «START: una gota cae / PEAK: estalla / DISSIPATE: se desvanece» saca el tramo pedido. */
function tramoDelCiclo(texto, parte) {
  const t = String(texto || '')
  if (!t.trim()) return ''
  const rx = new RegExp(`\\b${parte}\\b\\s*[:：—-]?\\s*([\\s\\S]*?)(?=\\b(?:START|PEAK|DISSIPATE)\\b\\s*[:：—-]|$)`, 'i')
  const m = rx.exec(t)
  return m ? m[1].trim().replace(/\s+/g, ' ') : ''
}

/**
 * Arma el Brief y el borrador de la descripción para UNA instancia de la VFX Sheet.
 *
 * Devuelve siempre los dos textos, aunque salgan vacíos: la ventana de Run los enseña editables y
 * quien sabe los completa. Y devuelve los `avisos` para que esa ventana pueda decir por qué está
 * vacío en vez de parecer rota.
 *
 * `asset` es la lámina sobre la que se pulsó Run. Sirve para dos cosas distintas: recuperar lo que
 * ya se escribió a mano para ESA instancia, y avisar si la lámina se editó después de que el 3.20
 * escribiera los fills — ver abajo.
 */
async function briefDeInstancia({ db, project_id, item, asset = null }) {
  const avisos = []

  // Lo que alguien ya escribió para esta instancia manda sobre lo derivado. Si no, la segunda
  // corrida borraría la corrección de la primera y nadie entendería por qué.
  const guardado = asset?.metadata?.vfx || null

  const { data: nodo } = await db().from('forge_nodes').select('id').eq('node_key', '3.20').maybeSingle()
  if (!nodo?.id) return { brief: '', descripcion: '', avisos: ['node 3.20 is not registered'], campos: {} }

  // Por CLAVE, no por nombre. El 3.20 produce DOS juegos de fills —`asg_fills` y
  // `gdd_art_style_fills`— y los dos se llaman «… Fills»: buscando por nombre gana el que devuelva
  // la base primero, y la primera prueba de esto se trajo los del GDD Art Style. Son documentos
  // distintos y el Brief habría salido de la hoja equivocada.
  //
  // La clave vive en DOS sitios —en la pieza desde la migración 054 y en su sesión desde siempre—
  // y se aceptan los dos, que es la misma mordida que ya arregló el manifiesto. El nombre queda
  // como último recurso para piezas viejas que no la declaran en ninguno.
  const { data: piezas } = await db().from('forge_assets')
    .select('name, content, created_at, output_key, forge_sessions!session_id(output_key)')
    .eq('project_id', project_id).eq('node_id', nodo.id)
    .not('content', 'is', null).order('created_at', { ascending: false })
  const clave = a => a.output_key ?? a.forge_sessions?.output_key ?? null
  const doc = (piezas || []).find(a => clave(a) === 'asg_fills')
           || (piezas || []).find(a => !clave(a) && /(^|[^a-z])asg[^a-z].*fills/i.test(a.name))
  if (!doc) {
    return { brief: '', descripcion: '', campos: {},
      avisos: ['This project has no asg_fills yet: run the Art Style Guide first.'] }
  }

  const fills = parsearFills(doc.content)
  const campos = {}
  for (const eq of EQUIVALENCIAS) {
    let valor = ''
    for (const nombre of eq.de) {
      const v = fillDe(fills, nombre)
      if (v && String(v).trim()) { valor = String(v).trim(); break }
    }
    campos[eq.rotulo] = valor
  }

  const ciclo = fillDe(fills, 'LIFECYCLE') || ''
  for (const c of CICLO) campos[c.rotulo] = tramoDelCiclo(ciclo, c.parte)
  campos[HOST] = ''

  const vacios = Object.entries(campos).filter(([k, v]) => k !== HOST && !v).map(([k]) => k)
  if (vacios.length === Object.keys(campos).length - 1) {
    avisos.push('The asg_fills do not carry the VFX Sheet fields yet: fill the Brief by hand.')
  } else if (vacios.length) {
    avisos.push(`Empty in the sheet: ${vacios.join(', ')}`)
  }

  // El Brief, con la forma exacta que espera el nodo 200: el rótulo, la flecha, y el valor detrás.
  const brief = [...EQUIVALENCIAS.map(e => e.rotulo), ...CICLO.map(c => c.rotulo), HOST]
    .map(r => `${r} → ${campos[r] || ''}`).join('\n')

  // El borrador de la descripción sale de EFFECT, TRIGGER, LIFECYCLE y COLOR USAGE — los cuatro que
  // nombró Miguel. No se redacta prosa falsa: se pegan los datos en el orden en que el modelo los
  // necesita —qué es, qué lo dispara, cómo evoluciona, de qué color— y Dirección de Arte lo
  // reescribe. Inventar el movimiento sería ponerle palabras a algo que nadie decidió.
  const partes = [
    campos['EFFECT (what it is)'],
    campos['TRIGGER / EVENT'] && `Triggered by: ${campos['TRIGGER / EVENT']}.`,
    [campos['START keyframe'] && `Starts: ${campos['START keyframe']}.`,
     campos['PEAK keyframe'] && `Peak: ${campos['PEAK keyframe']}.`,
     campos['DISSIPATE keyframe'] && `Fades: ${campos['DISSIPATE keyframe']}.`].filter(Boolean).join(' '),
    campos['COLOR USAGE (hex · role · limits)'] && `Colour: ${campos['COLOR USAGE (hex · role · limits)']}.`,
  ].filter(Boolean)
  const descripcion = partes.length
    ? `${partes.join(' ')} It loops seamlessly: the end returns to the start.`
    : ''

  // ── «Esto puede no corresponder a lo que se ve en la lámina» ────────────────
  //
  // El Brief sale del TEXTO con el que se dibujó la hoja. Si después alguien la editó —Design
  // Edits o New Art Style— la imagen cambió y el texto no: el video se pediría con la descripción
  // de una lámina que ya no es esa. Lo pidió Miguel y es el caso que más barato sale avisar.
  //
  // Se mide contra las VERSIONES de la pieza, que es donde los dos editores escriben, y contra la
  // fecha del documento de fills, no la de la lámina: lo que importa es cuál de los dos es más
  // nuevo.
  let edicionesPosteriores = []
  if (asset?.id) {
    const { data: vers } = await db().from('forge_asset_versions')
      .select('version_number, created_at, metadata')
      .eq('asset_id', asset.id).order('created_at', { ascending: false })
    edicionesPosteriores = (vers || [])
      .filter(v => v.metadata?.editor && new Date(v.created_at) > new Date(doc.created_at))
      .map(v => ({
        version: v.version_number,
        editor: v.metadata.editor === 'estilo' ? 'New Art Style' : 'Design Edits',
        cuando: v.created_at,
      }))
    if (edicionesPosteriores.length) {
      avisos.push(`This sheet was edited after the text it is based on`
        + ` (${edicionesPosteriores.map(e => e.editor).join(', ')}):`
        + ' the Brief may not match what the page looks like now.')
    }
  }

  return {
    brief: typeof guardado?.brief === 'string' ? guardado.brief : brief,
    descripcion: typeof guardado?.descripcion === 'string' ? guardado.descripcion : descripcion,
    // Lo derivado viaja igual aunque haya algo guardado: la ventana ofrece volver a él sin tener
    // que acordarse de qué decía.
    brief_derivado: brief,
    descripcion_derivada: descripcion,
    segundos: Number(guardado?.segundos) > 0 ? Number(guardado.segundos) : null,
    editado: !!guardado,
    campos, avisos, ediciones_posteriores: edicionesPosteriores,
    item: item || null, fuente: doc.name,
  }
}

module.exports = { briefDeInstancia, EQUIVALENCIAS, CICLO, HOST }
