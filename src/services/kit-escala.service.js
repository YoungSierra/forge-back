// ─── Escala real de un kit: del grafo de proporciones al factor de cada objeto ─
//
// JSON #1 del proceso Forge → Blender (`kit_scale/1.1`). Cierra el hueco que ningún framework
// resuelve: un `.glb` generativo llega normalizado por su cuenta —medido sobre los seis modelos
// almacenados, los seis miden 0,998 en su eje mayor— así que su tamaño absoluto es arbitrario y
// la proporción ENTRE assets del mismo kit se perdió.
//
// El método es el de la skill `forge_scale_anchor_protocol`, en dos fases:
//
//   A · grafo de proporciones — «la mesa mide 0,43 de lo que mide la puerta», leído de una imagen
//       donde los dos aparecen juntos. Ninguna cifra absoluta todavía. Lo produce un modelo con
//       visión mirando el Environment Sheet; es la única parte que no es determinista.
//   B · anclaje — UN objeto con medida real conocida, y desde él se propaga por el grafo. Esta
//       parte es aritmética y vive acá: mismas entradas, mismo resultado.
//
// Lo que Forge aporta y antes obligaba a pasar por Blender: `dim_actual_m`, cuánto mide HOY cada
// modelo. Sale de leer la caja declarada en el propio `.glb` (glb-medidas.service). Con eso el
// factor de Tool 1 es una división, y nadie tiene que medir nada dos veces.

const { medirActivo } = require('./glb-medidas.service')

const CONTRATO = 'kit_scale/1.1'
const EJES = ['x', 'y', 'z']
// Dos caminos del grafo que no coincidan dentro de este margen son una lectura mala, no un
// promedio: la skill lo dice explícito, y promediar en silencio esconde el error de lectura.
const TOLERANCIA = 0.10

/**
 * Fase B. Propaga la medida real del ancla por el grafo.
 *
 * Una arista `{de, a, proporcion}` dice: tamaño(de) = proporcion × tamaño(a). Se camina en los
 * dos sentidos —una arista sirve igual para bajar que para subir, invirtiendo la proporción— y se
 * guardan TODOS los caminos que llegan a cada objeto, no el primero: que dos caminos discrepen es
 * justamente la señal de que una proporción está mal leída.
 */
function resolverEscala(ancla, grafo) {
  const vecinos = new Map()
  const agregar = (a, b, p, arista) => {
    if (!(p > 0)) return
    if (!vecinos.has(a)) vecinos.set(a, [])
    vecinos.get(a).push({ hacia: b, factor: p, arista })
  }
  for (const e of grafo || []) {
    // tamaño(de) = p · tamaño(a)  ⇒  desde `a` se llega a `de` multiplicando por p,
    // y desde `de` se llega a `a` dividiendo.
    agregar(e.a, e.de, e.proporcion, e)
    agregar(e.de, e.a, 1 / e.proporcion, e)
  }

  const caminos = new Map([[ancla.objeto_id, [{ valor: ancla.valor_m, via: ['(ancla)'] }]]])
  const cola = [ancla.objeto_id]
  const visitados = new Set([ancla.objeto_id])
  while (cola.length) {
    const actual = cola.shift()
    const base = caminos.get(actual)[0]
    for (const v of vecinos.get(actual) || []) {
      const valor = base.valor * v.factor
      if (!caminos.has(v.hacia)) caminos.set(v.hacia, [])
      caminos.get(v.hacia).push({ valor, via: [...base.via, `${v.arista.de}/${v.arista.a}`] })
      if (!visitados.has(v.hacia)) { visitados.add(v.hacia); cola.push(v.hacia) }
    }
  }

  const medidas = {}, conflictos = []
  for (const [id, lista] of caminos) {
    const valores = lista.map(x => x.valor)
    const min = Math.min(...valores), max = Math.max(...valores)
    // Se conserva el PRIMER camino, el más corto: promediar es exactamente lo que la skill prohíbe.
    medidas[id] = redondear(lista[0].valor)
    if (min > 0 && (max - min) / min > TOLERANCIA) {
      conflictos.push({
        objeto: id,
        caminos: lista.map(x => ({ valor: redondear(x.valor), via: x.via.join(' → ') })),
        dispersion: +(((max - min) / min) * 100).toFixed(1),
      })
    }
  }
  return { medidas, conflictos }
}

const redondear = v => Math.round(v * 1e4) / 1e4

/**
 * Arma el `kit_scale_spec.json` completo.
 *
 * `objetos` es la lista del kit: `{ id, asset_id, archivo_fuente?, eje_calibrado?, clase? }`.
 * De cada uno se lee su caja ya medida; si todavía no la tiene, se mide en el momento.
 */
async function armarKitScaleSpec({ db, kit_id, objetos, ancla, grafo = [], fuente_visual = null }) {
  if (!kit_id) throw new Error('falta kit_id')
  if (!ancla?.objeto_id || !(ancla.valor_m > 0)) throw new Error('el ancla necesita objeto_id y valor_m')
  if (!objetos?.length) throw new Error('el kit no tiene objetos')
  if (!objetos.some(o => o.id === ancla.objeto_id)) {
    throw new Error(`el objeto ancla "${ancla.objeto_id}" no está entre los objetos del kit`)
  }

  const { medidas, conflictos } = resolverEscala(ancla, grafo)

  const salida = {}
  const avisos = []
  for (const o of objetos) {
    const { data: asset } = await db().from('forge_assets')
      .select('id, name, format, storage_url, metadata').eq('id', o.asset_id).single()
    if (!asset) throw new Error(`no existe el activo de "${o.id}"`)

    const m = asset.metadata?.medidas || await medirActivo(db, asset)
    // El eje vertical de un `.glb` es Y: glTF es Y-up. Se puede declarar otro, pero por defecto es
    // el que corresponde a la altura, que es lo que se calibra.
    const eje = o.eje_calibrado || 'y'
    if (!EJES.includes(eje)) throw new Error(`eje inválido en "${o.id}": ${eje}`)
    const actual = m.dim?.[eje]
    if (!(actual > 0)) throw new Error(`"${o.id}" no tiene medida en el eje ${eje}`)
    if (!m.exacta) avisos.push(`la caja de "${o.id}" es aproximada: ${m.nodos_transformados} nodo(s) con transformación`)

    const objetivo = medidas[o.id]
    if (objetivo === undefined) {
      avisos.push(`"${o.id}" no está conectado al ancla por ninguna proporción — queda sin tamaño objetivo`)
    }

    salida[o.id] = {
      archivo_fuente: o.archivo_fuente || `modelos_origen/${o.id}.glb`,
      eje_calibrado: eje,
      ...(o.clase ? { clase: o.clase } : {}),
      dim_actual_m: actual,
      ...(objetivo !== undefined ? { dim_objetivo_m: objetivo } : {}),
      // No es del contrato, pero es lo que Tool 1 va a aplicar y conviene que se pueda leer sin
      // recalcularlo: si el número no cuadra, se ve acá antes de escalar nada.
      ...(objetivo !== undefined ? { factor: redondear(objetivo / actual) } : {}),
      forge_asset_id: asset.id,
      forge_asset_nombre: asset.name,
    }
  }

  const spec = {
    contrato: CONTRATO,
    kit_id,
    pivote_estandar: true,
    // Las cajas se leyeron del archivo, que es Y-up. Tool 1 convierte al importar a Blender, que
    // es Z-up; decirlo acá es lo que evita que el factor se aplique al eje equivocado.
    convencion_ejes: 'gltf_y_up',
    ...(fuente_visual ? { fuente_visual } : {}),
    ancla: {
      objeto_id: ancla.objeto_id,
      eje: ancla.eje || 'y',
      valor_m: ancla.valor_m,
      metodo: ancla.metodo || 'clase_canonica',
      ...(ancla.justificacion ? { justificacion: ancla.justificacion } : {}),
    },
    ...(grafo?.length ? { grafo_de_proporciones: grafo } : {}),
    objetos: salida,
  }

  return { spec, conflictos, avisos, valido: validar(spec) }
}

/** Validación contra lo que el contrato declara obligatorio. Sin dependencias: los errores tienen
 *  que leerse en los términos del proceso, no en los de un validador genérico. */
function validar(spec) {
  const errores = []
  if (spec.contrato !== CONTRATO) errores.push(`contrato debe ser "${CONTRATO}"`)
  if (!spec.kit_id) errores.push('falta kit_id')
  for (const c of ['objeto_id', 'eje', 'valor_m', 'metodo']) {
    if (spec.ancla?.[c] === undefined) errores.push(`falta ancla.${c}`)
  }
  if (spec.ancla && !EJES.includes(spec.ancla.eje)) errores.push(`ancla.eje inválido: ${spec.ancla.eje}`)
  if (spec.ancla && !['reticula', 'declarado', 'clase_canonica'].includes(spec.ancla.metodo)) {
    errores.push(`ancla.metodo inválido: ${spec.ancla.metodo}`)
  }
  if (!spec.objetos || !Object.keys(spec.objetos).length) errores.push('objetos vacío')
  for (const [id, o] of Object.entries(spec.objetos || {})) {
    if (!o.archivo_fuente) errores.push(`${id}: falta archivo_fuente`)
    if (!EJES.includes(o.eje_calibrado)) errores.push(`${id}: eje_calibrado inválido`)
    if (o.dim_actual_m !== undefined && !(o.dim_actual_m > 0)) errores.push(`${id}: dim_actual_m debe ser > 0`)
  }
  for (const e of spec.grafo_de_proporciones || []) {
    for (const c of ['de', 'a', 'proporcion', 'leida_en']) {
      if (e[c] === undefined) errores.push(`una arista del grafo no declara "${c}"`)
    }
  }
  return { ok: errores.length === 0, errores }
}

module.exports = { armarKitScaleSpec, resolverEscala, validar, CONTRATO, TOLERANCIA }
