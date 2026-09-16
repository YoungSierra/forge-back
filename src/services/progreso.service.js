// ─── En qué va una corrida ───────────────────────────────────────────────────
//
// Correr un paso de cadena es UNA petición que puede tardar minutos: veinte despachos a ComfyUI,
// uno detrás de otro. Desde fuera eso era un botón girando, y si alguien cerraba la ventana o
// recargaba la página, la corrida seguía viva sin que nada lo dijera. Es el punto 4 del informe
// v6: una barra de progreso que se quede puesta.
//
// Lo que hace falta para eso no es inventar un porcentaje, es SACAR AFUERA lo que el servidor ya
// sabe mientras corre: cuántos despachos son, en cuál va, y si está esperando a ComfyUI o
// publicando. Se apunta acá y se pregunta por una ruta aparte.
//
// Vive en memoria y a propósito: es un dato de los próximos minutos, no un registro. Si el
// servidor se reinicia, se pierde — y es correcto, porque la corrida también se perdió. La tabla
// se limpia sola para que una corrida que se cortó sin avisar no deje una barra puesta para
// siempre.

const CORRIDAS = new Map()

// Una corrida que no da señales en diez minutos se da por muerta. El despacho más largo medido
// —un escenario entero— no llega a tres.
const CADUCA_MS = 10 * 60_000

const clave = (project_id, asset_id) => `${project_id}:${asset_id}`

function limpiar() {
  const ahora = Date.now()
  for (const [k, v] of CORRIDAS) if (ahora - v.actualizado > CADUCA_MS) CORRIDAS.delete(k)
}

/** Empieza a contar. `de` es cuántos despachos son en total. */
function iniciar({ project_id, asset_id, cadena, paso, etiqueta, de = 1 }) {
  limpiar()
  CORRIDAS.set(clave(project_id, asset_id), {
    project_id, asset_id, cadena, paso, etiqueta,
    hecho: 0, de: Math.max(1, de), estado: 'arrancando', que: null,
    desde: Date.now(), actualizado: Date.now(),
  })
}

/** Avisa de un cambio. Lo que no se pasa, no se toca. */
function marcar(project_id, asset_id, cambios) {
  const v = CORRIDAS.get(clave(project_id, asset_id))
  if (!v) return
  Object.assign(v, cambios, { actualizado: Date.now() })
}

function terminar(project_id, asset_id) {
  CORRIDAS.delete(clave(project_id, asset_id))
}

/** Lo que está corriendo en este proyecto. Normalmente una cosa o ninguna. */
function delProyecto(project_id) {
  limpiar()
  return [...CORRIDAS.values()]
    .filter(v => v.project_id === project_id)
    .map(v => ({
      asset_id: v.asset_id, cadena: v.cadena, paso: v.paso, etiqueta: v.etiqueta,
      hecho: v.hecho, de: v.de, estado: v.estado, que: v.que,
      segundos: Math.round((Date.now() - v.desde) / 1000),
    }))
}

module.exports = { iniciar, marcar, terminar, delProyecto }
