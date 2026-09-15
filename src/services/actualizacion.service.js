// ─── Sistema de actualización conectada ──────────────────────────────────────
//
// Un archivo gráfico no es una isla: al ajustar una página, las que dependen de ella quedan
// desactualizadas y el juego pierde coherencia visual —se cambia la paleta y los personajes
// siguen llevando los colores viejos.
//
// **Nada se auto-regenera.** Es la política de la §2.1 del documento de Miguel y no un detalle de
// implementación: generar cuesta y NO es reproducible —el mismo prompt da otra imagen y no hay
// caché—, así que regenerar sin permiso destruiría arte aprobado que nadie puede recuperar. Todo
// lo que esta cascada hace es MARCAR, con la acción sugerida:
//
//   [R] regenerar — el contenido depende del cambio; hay que volver a generar (pago, irreversible).
//   [V] revalidar — probablemente sigue valiendo; una persona lo mira y confirma. No cuesta nada.
//
// La matriz de abajo es la §2 del documento, fila por fila. No se deduce de los nombres ni de una
// heurística de parecido: es una relación declarada por dirección de arte, y cada arista lleva su
// acción. Lo que no está en la matriz no se marca.
//
// Identidad de página: el DOCUMENTO más el número. Nunca el número solo — el 3.20 emite tres decks
// y sus páginas colisionan en `NN_`, que es exactamente lo que hizo que el Art Bible citara
// páginas del GDD. Acá la cascada es del Art Style Guide y solo de él.

const DOCUMENTO = 'Art Style Guide'

// Las hojas de instancia: no propagan hacia adelante dentro de la guía, pero lo que salió de ellas
// —las tres vistas, el modelo 3D, el teaser— queda para revalidar, y además revalidan la 17, que
// es su espejo.
const HOJAS = ['18', '19', '20', '21', '22', '23', '24', '25']

const MATRIZ = {
  // 01 solo propaga en una redefinición de identidad, que es una decisión humana y no un efecto
  // de haber tocado la portada. Se declara para poder decirlo, no para dispararlo.
  '01': { rol: 'Gobernanza / estática', terminal: true, condicional: [
    { pagina: '02', accion: 'V' }, { pagina: '03', accion: 'V' },
  ] },

  '02': { rol: 'Fundacional', destinos: [
    { pagina: '01', accion: 'R' },
    ...['04', '05', '06', '07', '09', '10', '11', '12', '13', '15', '16'].map(p => ({ pagina: p, accion: 'R' })),
    ...['18', '19', '20', '21', '22', '24', '25'].map(p => ({ pagina: p, accion: 'R' })),
  ] },
  '03': { rol: 'Fundacional', destinos: [
    { pagina: '01', accion: 'R' },
    ...['04', '05', '06', '07', '09', '10', '11', '12', '13', '15', '16'].map(p => ({ pagina: p, accion: 'R' })),
    ...['18', '19', '20', '21', '22', '24', '25'].map(p => ({ pagina: p, accion: 'R' })),
  ] },

  '04': { rol: 'Lenguaje', destinos: [
    { pagina: '05', accion: 'R' }, { pagina: '07', accion: 'R' },
    { pagina: '18', accion: 'R' }, { pagina: '20', accion: 'R' },
  ] },
  '05': { rol: 'Lenguaje', destinos: [{ pagina: '18', accion: 'R' }, { pagina: '12', accion: 'V' }] },
  '06': { rol: 'Lenguaje', destinos: [
    { pagina: '19', accion: 'R' }, { pagina: '09', accion: 'V' }, { pagina: '11', accion: 'V' },
  ] },
  '07': { rol: 'Lenguaje', destinos: [{ pagina: '20', accion: 'R' }] },

  '08': { rol: 'Fundacional', destinos: [
    ...['18', '19', '20', '21', '22', '24', '25'].map(p => ({ pagina: p, accion: 'R' })),
    { pagina: '13', accion: 'V' }, { pagina: '16', accion: 'V' },
  ] },

  '09': { rol: 'Lenguaje', destinos: [{ pagina: '19', accion: 'R' }, { pagina: '08', accion: 'V' }] },
  // Condicional 2D en el documento: se marca igual, porque marcar no cuesta y la persona decide.
  '10': { rol: 'Lenguaje', destinos: [{ pagina: '20', accion: 'R' }] },
  '11': { rol: 'Lenguaje', destinos: [
    { pagina: '19', accion: 'R' },
    ...['18', '20', '21', '22', '24', '25'].map(p => ({ pagina: p, accion: 'V' })),
  ] },
  '12': { rol: 'Lenguaje', destinos: [{ pagina: '24', accion: 'R' }, { pagina: '18', accion: 'V' }],
    fuera: ['ADI §11.6 Framework [V]'] },
  '13': { rol: 'Lenguaje', destinos: [{ pagina: '22', accion: 'R' }, { pagina: '08', accion: 'V' }] },
  '14': { rol: 'Lenguaje (audio)', destinos: [{ pagina: '23', accion: 'R' }], fuera: ['TDD §10 Audio'] },
  '15': { rol: 'Lenguaje', destinos: [{ pagina: '25', accion: 'R' }, { pagina: '02', accion: 'V' }] },
  '16': { rol: 'Lenguaje', destinos: [{ pagina: '21', accion: 'R' }, { pagina: '08', accion: 'V' }] },

  // La 17 espeja las ocho hojas: no propaga, se revalida cuando cambia cualquiera de ellas.
  '17': { rol: 'Divisoria', terminal: true, destinos: [] },

  // Las ocho hojas. Terminales dentro de la guía; lo que produjeron queda para revalidar.
  ...Object.fromEntries(HOJAS.map(p => [p, {
    rol: 'Instancia (hoja)', terminal: true,
    destinos: [{ pagina: '17', accion: 'V' }],
    derivados: 'V',
  }])),
}

/** El número de página dentro de SU documento, o null si la pieza no es una página del ASG. */
function paginaDe(asset) {
  const n = String(asset?.name || '')
  const m = /^\s*(.+?)\s*[—–-]\s*(\d{2})_/.exec(n)
  if (!m) return null
  if (m[1].trim().toLowerCase() !== DOCUMENTO.toLowerCase()) return null
  return m[2]
}

/** Qué dispara tocar esta página, sin tocar nada: es lo que el aviso previo necesita decir. */
function loQueDispara(pagina) {
  const fila = MATRIZ[pagina]
  if (!fila) return null
  return {
    pagina, rol: fila.rol, terminal: Boolean(fila.terminal),
    destinos: fila.destinos || [],
    condicional: fila.condicional || [],
    derivados: fila.derivados || null,
    fuera: fila.fuera || [],
  }
}

/**
 * Marca como desactualizado todo lo que depende de la página que acaba de cambiar.
 *
 * La marca vive en el propio activo —`metadata.desactualizado`— y no en una tabla aparte porque es
 * un estado de la pieza: quien la mira tiene que verlo ahí, y quien la regenera tiene que poder
 * limpiarlo sin coordinar dos escrituras.
 *
 * Una marca nueva NO pisa una anterior sin decirlo: si una página ya estaba marcada [R] por otro
 * cambio, se queda en [R] —la acción más fuerte manda— y se suma el origen. Bajarla a [V] porque
 * llegó después un cambio menor perdería el trabajo que ya se debía.
 */
async function propagarDesdePagina({ db, project_id, asset_id, motivo = null, member_id = null }) {
  const { data: origen } = await db().from('forge_assets')
    .select('id, name, project_id').eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!origen) return { aplica: false, motivo: 'Asset not found' }

  const pagina = paginaDe(origen)
  if (!pagina) return { aplica: false }
  const fila = MATRIZ[pagina]
  if (!fila) return { aplica: false, motivo: `page ${pagina} is not in the trigger matrix` }

  const destinos = fila.destinos || []
  if (!destinos.length && !fila.derivados) {
    return { aplica: true, pagina, marcadas: [], condicional: fila.condicional || [], fuera: fila.fuera || [] }
  }

  // Las páginas del MISMO documento y proyecto. Se piden todas de una y se resuelven por número
  // en memoria: una consulta por destino serían veinte viajes para un cambio de la 02.
  const { data: hermanas } = await db().from('forge_assets')
    .select('id, name, metadata')
    .eq('project_id', project_id)
    .like('name', `${DOCUMENTO} — %`)
  const porPagina = {}
  for (const h of hermanas || []) {
    const p = paginaDe(h)
    // De cada página vale la última: una regenerada convive con la anterior y marcar la vieja no
    // le sirve a nadie. Vienen ordenadas por inserción, así que la última gana.
    if (p) porPagina[p] = h
  }

  const sello = new Date().toISOString()
  const marcadas = []
  const ausentes = []

  const marcar = async (pieza, accion, por) => {
    const previa = pieza.metadata?.desactualizado
    // La acción más fuerte manda: [R] no baja a [V] porque llegó un cambio menor después.
    const final = previa?.accion === 'R' ? 'R' : accion
    const origenes = [...new Set([...(previa?.origenes || []), por])]
    const metadata = {
      ...(pieza.metadata || {}),
      desactualizado: {
        accion: final, origenes, desde: previa?.desde || sello, marcado_en: sello,
        por_pagina: pagina, motivo: motivo || previa?.motivo || null, marcado_por: member_id,
      },
    }
    const { error } = await db().from('forge_assets').update({ metadata }).eq('id', pieza.id)
    if (error) throw error
    pieza.metadata = metadata
    marcadas.push({ id: pieza.id, nombre: pieza.name, accion: final })
  }

  for (const d of destinos) {
    const pieza = porPagina[d.pagina]
    if (!pieza) { ausentes.push(d.pagina); continue }
    if (pieza.id === origen.id) continue           // una página no se marca a sí misma
    await marcar(pieza, d.accion, origen.id)
  }

  // Lo que ESTA hoja produjo: las tres vistas, el modelo, el teaser. Se revalida, no se regenera:
  // es arte pago y puede seguir valiendo.
  if (fila.derivados) {
    const { data: hijos } = await db().from('forge_assets')
      .select('id, name, metadata').eq('project_id', project_id).eq('derived_from_id', origen.id)
    for (const h of hijos || []) await marcar(h, fila.derivados, origen.id)
  }

  return {
    aplica: true, pagina, rol: fila.rol,
    marcadas, ausentes,
    condicional: fila.condicional || [],
    fuera: fila.fuera || [],
  }
}

/** Lo que está marcado hoy en el proyecto, para el panel y para los badges del lienzo. */
async function pendientesDelProyecto({ db, project_id }) {
  const { data } = await db().from('forge_assets')
    .select('id, name, storage_url, metadata')
    .eq('project_id', project_id)
    .not('metadata->desactualizado', 'is', null)
  return (data || []).map(a => ({
    id: a.id, nombre: a.name, url: a.storage_url,
    accion: a.metadata.desactualizado.accion,
    desde: a.metadata.desactualizado.desde,
    por_pagina: a.metadata.desactualizado.por_pagina || null,
    origenes: a.metadata.desactualizado.origenes || [],
  }))
}

/**
 * Levanta la marca de una pieza.
 *
 * Es el gate humano de la §2.1: revalidar es mirar y confirmar, y confirmar es esto. Regenerar
 * limpia la marca también, pero por el camino normal —la pieza nueva nace sin marca— así que acá
 * solo se registra quién la dio por buena y cuándo.
 */
async function revalidar({ db, project_id, asset_id, member_id = null }) {
  const { data: pieza } = await db().from('forge_assets')
    .select('id, name, metadata').eq('id', asset_id).eq('project_id', project_id).maybeSingle()
  if (!pieza) { const e = new Error('Asset not found'); e.code = 'NO_ASSET'; throw e }
  const marca = pieza.metadata?.desactualizado
  if (!marca) return { id: pieza.id, nombre: pieza.name, ya_estaba: true }

  const metadata = { ...(pieza.metadata || {}) }
  delete metadata.desactualizado
  // Queda el rastro de que alguien la miró: sin esto, «no está marcada» y «nadie la revisó» se
  // leen igual.
  metadata.revalidada = { en: new Date().toISOString(), por: member_id, venia_de: marca.accion }

  const { error } = await db().from('forge_assets').update({ metadata }).eq('id', asset_id)
  if (error) throw error
  return { id: pieza.id, nombre: pieza.name, accion_previa: marca.accion }
}

module.exports = {
  MATRIZ, DOCUMENTO, paginaDe, loQueDispara,
  propagarDesdePagina, pendientesDelProyecto, revalidar,
}
