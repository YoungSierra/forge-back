// ─── El manifiesto de instancias del 3.20 ────────────────────────────────────
//
// De dónde sale cuántas hojas hay que instanciar. Hasta ahora se contaba leyendo las TABLAS del
// Vertical Slice Specification, que es prosa con tablas dentro: funciona, pero depende de que el
// documento traiga el inventario §A7.1 y de que las clases se llamen como el lector espera.
//
// Pedro lo movió al sitio correcto en la v2.9.35: el propio nodo 3.20 emite `sheet_instance_manifest`,
// un MAPA —hermano de `reference_map`— que dice, página por página, qué instancias hay y qué lleva
// cada una. Su propia nota lo explica: «previously from the VS Specification, which is prose the
// Moodboard cannot count from». Miguel lo aprobó el 16-09.
//
// Este servicio lo lee. Manda el manifiesto cuando existe, y si no existe se sigue contando desde
// el spec como hasta ahora — que un proyecto no haya vuelto a correr el 3.20 no puede dejarlo sin
// instanciar.
//
// OJO, lo que todavía NO está comprobado: ningún proyecto ha producido un manifiesto (medido el
// 16-09: cero filas con ese `output_key`). Lo de acá está escrito contra la especificación del
// output y probado contra manifiestos de ejemplo que la cumplen. El primero de verdad hay que
// mirarlo: si el modelo se sale de la forma, se ve en `avisos` y se cae al spec, no se rompe.

const YAML = require('yaml')

/** El bloque yaml del manifiesto dentro del documento. */
function bloqueYaml(texto) {
  const t = String(texto || '')
  // Con vallas, que es como lo pide el prompt. Se acepta ```yaml y ``` a secas.
  const conValla = [...t.matchAll(/```(?:ya?ml)?\s*\n([\s\S]*?)```/g)]
    .map(m => m[1])
    .find(b => /^\s*sheet_instance_manifest\s*:/m.test(b))
  if (conValla) return conValla
  // Sin vallas: desde la clave raíz hasta el final. Un modelo que olvida la valla no debería
  // costar un re-run.
  const i = t.search(/^\s*sheet_instance_manifest\s*:/m)
  return i === -1 ? null : t.slice(i)
}

/**
 * De `page: '19_EnvironmentSheet'` a la hoja tal como la nombra el deck.
 *
 * El manifiesto habla del maestro de 25 páginas. Si el proyecto corre otro, el número cambia y el
 * NOMBRE no: `19_EnvironmentSheet` y `29_EnvironmentSheet` son la misma hoja. Es la misma trampa
 * que rompía la cascada de actualización, y se resuelve igual — por nombre, nunca por número.
 */
const sinNumero = s => String(s || '').replace(/^\d+[_\s-]*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Lee el manifiesto del proyecto y devuelve los ítems por hoja, en el mismo formato que
 * `itemsDelAlcance` — para que quien instancia no tenga que saber de dónde vino la cuenta.
 *
 * `soloDelSlice`: el manifiesto marca `in_slice` por instancia. Se instancia lo que ENTRA al
 * slice; lo que quedó fuera se cuenta aparte y se dice, porque instanciarlo es pagar hojas de
 * cosas que el slice no muestra. `unknown` cuenta como que entra: la spec dice explícitamente que
 * nunca se estime el corte, y dejar fuera lo dudoso sería estimarlo al revés.
 */
async function itemsDelManifiesto({ db, project_id }) {
  // La clave vive en DOS sitios: en la pieza desde la migración 054, y en su sesión desde siempre.
  // Exigirla solo en la pieza dejaba esto ciego del todo — medido el 30-09 contra la base viva:
  // CERO piezas la llevan y tres sesiones sí, así que el planificador nunca encontró un manifiesto
  // y siempre cayó al VS Spec. Lo reportó Pedro; es la misma familia de bug que ya mordió seis
  // veces, y el mismo arreglo que `b6e8536` le hizo al empaquetador.
  const { data, error } = await db().from('forge_assets')
    .select('id, name, content, created_at, output_key, forge_sessions!session_id(output_key)')
    .eq('project_id', project_id)
    .not('content', 'is', null)
    .order('created_at', { ascending: false })
  if (error) throw error

  const doc = (data || []).find(a =>
    (a.output_key ?? a.forge_sessions?.output_key) === 'sheet_instance_manifest')
  if (!doc) return { hay: false, motivo: 'This project has no sheet instance manifest yet', porHoja: {}, avisos: [] }

  const bloque = bloqueYaml(doc.content)
  if (!bloque) {
    return { hay: false, motivo: 'The sheet instance manifest has no `sheet_instance_manifest` block', porHoja: {}, avisos: [] }
  }

  let raiz
  try {
    const parsed = YAML.parse(bloque)
    raiz = parsed?.sheet_instance_manifest ?? parsed
  } catch (e) {
    return { hay: false, motivo: `The sheet instance manifest is not valid YAML: ${e.message}`, porHoja: {}, avisos: [] }
  }

  const paginas = Array.isArray(raiz?.pages) ? raiz.pages : null
  if (!paginas) {
    return { hay: false, motivo: 'The sheet instance manifest has no `pages` list', porHoja: {}, avisos: [] }
  }

  const porHoja = {}
  const avisos = []
  const pendientes = []
  let fuera = 0

  for (const pg of paginas) {
    // `page_key` ANTES que `page`. El modelo escribía el número en `page` —«page: 20»— y el nombre
    // en `page_key` —«20_PropSheet»—, y este lector solo miraba el primero: un número no casa con
    // ninguna hoja, así que el manifiesto entero se descartaba y el alcance caía al VS Spec. En
    // Wort eso daba UNA Prop Sheet donde el manifiesto declaraba once. Lo encontró Pedro, y su
    // v2.9.45 arregla el prompt para los manifiestos nuevos; esto rescata los YA escritos sin
    // volver a correr el nodo ni pagar nada.
    const hoja = String(pg?.page_key || pg?.page || '').trim()
    if (!hoja) continue

    const estado = String(pg?.status || '').toUpperCase()
    const instancias = Array.isArray(pg?.instances) ? pg.instances : []

    // Una página que dice PENDING_SPEC no es un error ni un cero: es «todavía no me toca». Se
    // nombra para que nadie la busque en el lienzo, y no se cuenta.
    if (!instancias.length) {
      if (estado === 'PENDING_SPEC') pendientes.push(hoja)
      else if (estado) avisos.push(`${hoja}: ${estado.toLowerCase().replace(/_/g, ' ')}, no instances`)
      continue
    }

    const items = []
    for (const inst of instancias) {
      // El título es lo que se lee en la hoja; el id es lo que la hace estable entre corridas.
      const nombre = String(inst?.title || inst?.instance_id || '').trim()
      if (!nombre) continue
      if (inst?.in_slice === false) { fuera++; continue }
      items.push({
        nombre,
        cuenta: 1,
        de: 'sheet_instance_manifest',
        instancia_id: inst?.instance_id ?? null,
        // Las páginas de lenguaje con las que esta instancia tiene que cumplir. Viajan porque son
        // las que la cascada marca [V] cuando cambian: es el mismo dato, declarado en el origen.
        must_comply_with: Array.isArray(inst?.must_comply_with) ? inst.must_comply_with : null,
      })
    }
    if (items.length) porHoja[hoja] = items

    // La cuenta declarada tiene que cuadrar con la lista. Su propia spec lo llama «conformance
    // failure», así que se dice en vez de confiar en el número.
    const declarada = Number(pg?.count_in_slice)
    if (Number.isFinite(declarada) && declarada !== items.length) {
      avisos.push(`${hoja}: the manifest says ${declarada} in-slice instances and lists ${items.length}`)
    }
  }

  if (pendientes.length) avisos.push(`pages still without their own spec: ${pendientes.join(', ')}`)
  if (fuera) avisos.push(`${fuera} instance${fuera === 1 ? '' : 's'} left out: the manifest marks them outside the slice`)

  const total = Object.values(porHoja).reduce((n, l) => n + l.length, 0)
  if (!total) {
    return {
      hay: false,
      motivo: pendientes.length
        ? `The sheet instance manifest has no instances yet: ${pendientes.join(', ')} are still PENDING_SPEC`
        : 'The sheet instance manifest lists no instances',
      porHoja: {}, avisos,
    }
  }

  // Un manifiesto que nombra sus hojas SOLO con el número —«19», «20»— no se puede usar: las hojas
  // se resuelven por nombre, precisamente porque el número cambia entre maestros. Lo escribían así
  // los manifiestos viejos, de antes de que la convención se fijara.
  //
  // Se devuelve como «no hay», no como un manifiesto vacío, para que el respaldo del VS Spec entre
  // solo y quede el aviso de que existe y no se está usando. Sin esto, arreglar la búsqueda del
  // manifiesto —que llevaba sin encontrar ninguno— hacía que uno viejo tapara al spec y dejara al
  // proyecto sin plan: se cambiaba un fallo silencioso por otro.
  const conNombre = Object.keys(porHoja).filter(k => /[a-z]/i.test(k))
  if (!conNombre.length) {
    return {
      hay: false,
      motivo: `its sheets are named by number only (${Object.keys(porHoja).join(', ')}), and sheets resolve by name`,
      porHoja: {}, avisos,
    }
  }

  return { hay: true, porHoja, avisos, sinClasificar: [], noSonLaminas: [], documento: doc.name }
}

module.exports = { itemsDelManifiesto, bloqueYaml, sinNumero }
