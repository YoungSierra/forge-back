// ─── Rastro de una generación que falló ──────────────────────────────────────
//
// Hasta hoy, cuando el proveedor fallaba o el usuario paraba, el catch del chat hacía `next(err)` y
// nada más: la sesión quedaba `active` para siempre (sin `completed_at`, sin mensajes, sin fila en el
// log, sin asset). Medido el 07-10 en Professor_Wort_&_Sprat_world: dos intentos del 3.9 de 12,7 y
// 9,5 minutos desaparecieron sin dejar nada, y en la base hay sesiones `active` del 3.9 desde julio.
//
// Esto deja los tres rastros que sí se pueden dejar sin inventar estados: la sesión pasa a
// `abandoned` (el único estado de fallo que admite el check de forge_sessions y que el front ya pinta
// como fallo) si no llegó a producir nada; un aviso con la causa queda en el hilo con role `system`
// (permitido por el check de forge_messages; GET /session lo entrega como `aviso`, así Accept nunca lo
// toma por la respuesta del nodo y el historial que se le pasa al modelo lo omite); y el log guarda la
// llamada con status `error` (o `timeout`) y su error_code — un Stop es status `error` con error_code
// ABORTED. Nunca lanza: un fallo al anotar el fallo no puede tapar el error original.

async function marcarSesionFallida(db, {
  session_id, project_id, node_id, node_key = null, output_key = null, member_id = null,
  trigger_type = 'chat', error, provider = null, model = null, started_at = null, iteraciones_previas = 0,
}) {
  if (!session_id) return
  const code = String(error?.code || error?.status || 'ERROR').slice(0, 64)
  const causa = String(error?.message || error || 'unknown error').slice(0, 400)
  const detenida = code === 'ABORTED'
  const ahora = new Date().toISOString()

  // Una sesión de chat que ya tenía una respuesta buena (iteraciones previas) sigue `active`: esa
  // respuesta puede estar esperando Accept, y abandonarla la haría inaceptable por un fallo posterior.
  // Solo se abandona la sesión que no llegó a producir nada.
  if (!(iteraciones_previas > 0)) {
    try {
      await db().from('forge_sessions')
        .update({ status: 'abandoned', completed_at: ahora })
        .eq('id', session_id).eq('status', 'active')
    } catch (e) { console.error('[sesion-fallida] no se pudo marcar la sesión:', e.message) }
  }

  try {
    // El siguiente índice del hilo, no 0: en una sesión con turnos previos el aviso va al final.
    const { data: ultimo } = await db().from('forge_messages').select('order_index')
      .eq('session_id', session_id).order('order_index', { ascending: false }).limit(1).maybeSingle()
    const orden = Number.isInteger(ultimo?.order_index) ? ultimo.order_index + 1 : 0
    await db().from('forge_messages').insert({
      session_id, role: 'system', order_index: orden, tool_calls: [],
      content: detenida
        ? '_Generation stopped by the user. Nothing was saved for this output._'
        : `_Generation failed — ${causa}_\n\nNothing was saved for this output. Run it again.`,
    })
  } catch (e) { console.error('[sesion-fallida] no se pudo escribir el mensaje:', e.message) }

  try {
    const { logExecution } = require('./execution-log.service')
    const inicio = started_at ? new Date(started_at) : null
    logExecution({
      project_id, node_id, session_id, triggered_by: member_id || null,
      trigger_type, executor_type: 'llm', provider, model,
      tokens: null, cost_usd: 0, duration_ms: inicio ? Date.now() - inicio.getTime() : null,
      started_at: inicio ? inicio.toISOString() : ahora,
      // 021_execution_log: status text — 'success' | 'error' | 'timeout'. Un Stop es 'error' con
      // error_code ABORTED: no se inventa un estado nuevo.
      status: code === 'TIMEOUT' ? 'timeout' : 'error', error_code: code,
      metadata: { node_key, output_key, message: causa.slice(0, 300) },
    })
  } catch (e) { console.error('[sesion-fallida] no se pudo escribir el log:', e.message) }
}

module.exports = { marcarSesionFallida }
