// El acomodo del canvas, reducido a lo que ES un acomodo: dónde va cada cosa.
//
// `projects.canvas_layout` guardaba el array de nodos de React Flow tal cual, y cada nodo arrastra
// dentro su `data.canvasNode` — la DNA completa, sus salidas y sus sesiones. Medido el 21-09 en
// `13_lives_kitten_TEST`: UN nodo pesaba **738 KB** y los 21 sumaban **2.428 KB**. Lo que hace
// falta para volver a colocarlos son **1,5 KB**. Mil seiscientas veces más datos de los necesarios,
// reescritos enteros cada vez que alguien mueve un nodo.
//
// De ahí salía todo lo caro: los `PUT` que Postgres cancelaba a los 34 segundos
// (`canceling statement due to statement timeout`), las lecturas de 6 a 31 segundos, y la pérdida
// del acomodo cuando una de esas lecturas fallaba y la mezcla se hacía igual sobre la nada.
//
// Lo que se quita no se pierde: vive en la base y el front lo vuelve a pedir al cargar, que es de
// donde salió. Guardarlo acá era tener dos copias y mantener la mala.
//
// Se recorta en el SERVIDOR y en los TRES escritores a propósito: así ni un front viejo —una
// pestaña que lleva horas abierta, un despliegue a medias— ni un camino que nadie recuerde pueden
// volver a engordar la columna. Es idempotente: sobre algo ya magro no cambia nada.
function normalizarLayout(layout) {
  if (!layout || typeof layout !== 'object') return {}
  const out = { ...layout }

  if (Array.isArray(layout.nodes)) {
    out.nodes = layout.nodes.map(n => ({
      id: n.id,
      position: n.position,
      ...(n.type ? { type: n.type } : {}),
      // `measured` evita el salto del primer pintado mientras React Flow mide. Son dos números.
      ...(n.measured ? { measured: n.measured } : {}),
    }))
  }

  // Las aristas NO son el problema —154 pesaban 51 KB— pero llevan algo que no se puede tirar: los
  // `waypoints`, los puntos por los que alguien hizo pasar un cable a mano (ForgeCanvas.tsx:4477).
  // Quitarlos enderezaría en silencio todas las conexiones dibujadas. Se conservan esos y se deja
  // fuera el resto de su `data`, que se reconstruye al cargar.
  if (Array.isArray(layout.edges)) {
    out.edges = layout.edges.map(e => {
      const wp = e?.data?.waypoints
      return {
        id: e.id, source: e.source, target: e.target,
        ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
        ...(e.type ? { type: e.type } : {}),
        ...(Array.isArray(wp) && wp.length ? { data: { waypoints: wp } } : {}),
      }
    })
  }

  return out
}

module.exports = { normalizarLayout }
