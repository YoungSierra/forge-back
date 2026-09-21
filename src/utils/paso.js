// Nombrar el paso que falló.
//
// Una corrida que sale al mundo son varias llamadas seguidas —subir la imagen de origen, despachar
// el workflow, esperarlo, bajar las salidas, guardarlas— y cada una falla por su cuenta. Desde el
// navegador los cinco fallos se leen igual, y peor: `fetch()` de Node tira «fetch failed» a secas
// para cualquier problema de red, sin decir contra qué host.
//
// Eso es el punto 4 del informe v11 de Miguel: «The step failed: fetch failed» en el paso de
// producción 3D. Con el paso delante —«3D production · uploading the source image to ComfyUI:
// fetch failed»— el mensaje dice a dónde mirar. Sin él hay que ir al log del servidor, que es lo
// que ya costó cuatro informes seguidos (v4·14, v6·2, v7·3, v8·9).
//
// No se inventa diagnóstico: se conserva el mensaje original y se le antepone el paso. Y se marca
// `publico` para que la ruta lo reenvíe tal cual en vez de taparlo con un genérico.
function crearPaso(ambito) {
  return async function paso(nombre, fn) {
    try {
      return await fn()
    } catch (e) {
      console.error(`[${ambito}] falló en «${nombre}»:`, e)
      const err = new Error(`${nombre}: ${e?.message || 'unknown error'}`)
      err.publico = true
      err.status  = e?.status || 502
      err.code    = e?.code || 'PASO_FALLIDO'
      err.cause   = e
      throw err
    }
  }
}

module.exports = { crearPaso }
