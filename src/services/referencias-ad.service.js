// ─── El registro de referencias de Dirección de Arte, por página o instancia de hoja ─────────────────────
//
// Spec de Miguel León del 21-10 (Reference Image, §4): UNA referencia vigente por página del ASG o por instancia
// de hoja, compartida por los dos canales que la cargan —Add Context y Design Edits— y con un solo historial. Es
// lo que va a USERREF (IMAGE 3 del maestro de 34, v2.9.60) y a la IMAGE 2 de Design Edits (v2.9.61).
//
// No hay tabla nueva: cada referencia es una pieza de `forge_assets` con `metadata.contexto` (la misma forma que
// ya escribe Add Context), y la instancia va en `metadata.contexto.instancia { pagina, item, id }`.
//   · Registrar una nueva la deja `primary` y se lo quita a las demás de esa página o instancia: la última
//     aprobada gana, y las anteriores quedan en el historial.
//   · Restaurar una del historial es lo mismo: vuelve a ser la `primary`.
//   · Quitar marca `retirada` a todas: la página vuelve a ir sin referencia (§4.4) y nada se borra.
'use strict'

const { historialDeReferencias, mismaInstancia, soloPagina } = require('../utils/userref')

/**
 * La página del ASG (o la instancia de hoja) que ES un activo, o null si no es una página del ASG.
 *
 * Una instancia lo lleva escrito (`metadata.instancia`, lo pone el motor al instanciar). Una página fija se llama
 * «Art Style Guide — 09_ColorSystem», justo dos tramos: con más, es una pieza derivada («— Segmented»,
 * «— Concept art»), que la spec deja fuera de la v1 (§6).
 */
function destinoDeAsset(asset) {
  const tramos = String(asset?.name || '').split(/\s+[—–]\s+/).map(t => t.trim())
  if (!/^art style guide$/i.test(tramos[0] || '')) return null
  const inst = asset?.metadata?.instancia || null
  if (inst) {
    const pagina = inst.pagina || tramos.find(t => /^\d+_\S+$/.test(t)) || null
    if (!pagina) return null
    return { pagina, instancia: { pagina, item: inst.item || null, ...(inst.id ? { id: inst.id } : {}) } }
  }
  if (tramos.length !== 2 || !/^\d+_\S+$/.test(tramos[1])) return null
  return { pagina: tramos[1], instancia: null }
}

/** Las piezas del registro del proyecto (todas las de Add Context con imagen), de la más nueva a la más vieja. */
async function piezasDelRegistro(db, project_id) {
  const { data, error } = await db().from('forge_assets')
    .select('id, name, storage_url, status, metadata, created_at')
    .eq('project_id', project_id)
    .not('metadata->contexto', 'is', null)
    .not('storage_url', 'is', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`could not read the reference registry: ${error.message}`)
  return data || []
}

/** Cómo se enseña una pieza del registro: lo que el modal y Add Context necesitan, y nada más. */
function aVista(r, vigente) {
  const c = r.metadata?.contexto || {}
  const via = (c.inbound || [])[0] || {}
  return {
    id: r.id, nombre: r.name, url: r.storage_url,
    canal: c.canal || via.via || 'add_context',
    fecha: via.en || r.created_at,
    vigente: !!vigente && vigente.id === r.id,
    retirada: !!c.retirada,
  }
}

/** La vigente y el historial de una página o instancia. */
async function registroDe(db, project_id, pagina, instancia = null) {
  const { vigente, todas } = historialDeReferencias(await piezasDelRegistro(db, project_id), pagina, instancia)
  return { vigente: vigente ? aVista(vigente, vigente) : null, historial: todas.map(r => aVista(r, vigente)), _vigente: vigente }
}

/** Escribe `metadata.contexto` de varias piezas con el cambio que pida cada una. */
async function marcar(db, piezas, cambio) {
  for (const r of piezas) {
    const metadata = { ...(r.metadata || {}), contexto: { ...(r.metadata?.contexto || {}), ...cambio(r) } }
    const { error } = await db().from('forge_assets').update({ metadata }).eq('id', r.id)
    if (error) throw new Error(`could not update the reference registry: ${error.message}`)
  }
}

/** Deja `elegida` como la vigente de su página o instancia: primary y no retirada; las demás pierden la primary. */
async function hacerVigente(db, project_id, elegidaId) {
  const piezas = await piezasDelRegistro(db, project_id)
  const elegida = piezas.find(r => r.id === elegidaId)
  if (!elegida) { const e = new Error('Reference not found in this project'); e.status = 404; e.publico = true; throw e }
  const c = elegida.metadata.contexto
  const { todas } = historialDeReferencias(piezas, c.pagina_destino, c.instancia || null)
  await marcar(db, todas.filter(r => r.id !== elegidaId && r.metadata.contexto.primary), () => ({ primary: false }))
  await marcar(db, [elegida], () => ({ primary: true, retirada: false }))
}

/** Quita la referencia de una página o instancia: todas pasan a `retirada` y la página va sin referencia. */
async function quitarReferencia(db, project_id, pagina, instancia = null) {
  const { todas } = historialDeReferencias(await piezasDelRegistro(db, project_id), pagina, instancia)
  const activas = todas.filter(r => !r.metadata.contexto.retirada)
  await marcar(db, activas, () => ({ primary: false, retirada: true, retirada_en: new Date().toISOString() }))
  return activas.length
}

/**
 * Registra una referencia nueva en una página o instancia, por cualquiera de los dos canales, y la deja vigente.
 * Pasa por `guardarContexto` para que la pieza sea idéntica a la de Add Context (3.9, Historial Inbound, §ADI).
 */
async function registrarReferencia(db, { project_id, url, nombre, pagina, instancia = null, canal, member_id = null, cascada = true }) {
  const { guardarContexto, seccionDe } = require('./contexto.service')
  const r = await guardarContexto({
    db, project_id, nombre: nombre || 'Art Direction reference', url,
    destino: destinoUserref(pagina, instancia, seccionDe(pagina)),
    rol: 'referencia_aprobada', ambito: instancia ? 'ficha' : 'pagina',
    member_id, canal, instancia, cascada,
  })
  return r
}

/** El destino «USERREF de esta página o instancia», tal como lo propone Add Context en el paso 3. */
function destinoUserref(pagina, instancia, adi) {
  const cual = instancia?.item ? `${pagina} — ${instancia.item}` : pagina
  return {
    clave: 'userref', titulo: `Art Direction reference of ${cual}`, pagina,
    ...(instancia ? { instancia } : {}), adi: adi || null, inyeccion: 'directa',
    porque: 'It becomes the current Art Direction reference of this page (USERREF): the model follows it for the subject it shows, and the pipeline reference (REF) is untouched.',
  }
}

/**
 * Si el maestro del ASG de ESTE proyecto tiene la ranura USERREF, y en qué páginas. Los proyectos del `_25` (y el
 * `_31` antes del v2.9.60) no la tienen: ahí Add Context sigue yendo al REF como siempre.
 */
async function paginasConUserref(db, project_id) {
  const { DECKS, maestroDelProyecto } = require('./slide-composer.service')
  const { esUserref } = require('../utils/userref')
  const cfg = await maestroDelProyecto({ db, projectId: project_id, deck: 'asg', cfg: DECKS.asg })
  const { data } = await db().from('comfyui_workflows').select('inject_config').eq('name', cfg.workflow).maybeSingle()
  const paginas = (data?.inject_config?.pages || []).filter(p => (p.image_inputs || []).some(esUserref)).map(p => soloPagina(p.name))
  return new Set(paginas)
}

module.exports = {
  destinoDeAsset, registroDe, hacerVigente, quitarReferencia, registrarReferencia, destinoUserref,
  paginasConUserref, piezasDelRegistro, mismaInstancia,
}
