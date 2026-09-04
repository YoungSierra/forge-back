// Cuántas imágenes declara un output.
//
// Hasta v2.9.31 `image_count` era siempre un entero y el motor lo leía como tal. Desde v2.9.31
// hay dos formas, porque hay dos clases de contrato:
//
//   · fijo    →  1                                     (3.3 item_catalog_sheet, 3.7 hud_schematic)
//   · variable→  { min: 3, max: 5, per: "design_pillars" }
//
// El `per` nombra al hermano del que sale la cantidad —los pilares, las pantallas, las entradas
// del plan—. No lo usa este módulo: queda escrito para que el aviso pueda decir de dónde salía
// el número cuando no cuadra.
//
// Todo el motor pasa por acá. Leerlo suelto es lo que rompe: `def.image_count || null` con un
// objeto devuelve el objeto, y de ahí sale «un deck de [object Object] páginas» o una guarda
// comparando un número contra `{min,max}`, que en JavaScript no falla — da `false` en silencio.

// Normaliza a `{ min, max, per }`, o null si el output no declara nada.
function cuantasDeclara(def) {
  const v = def?.image_count
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return { min: v, max: v, per: null }
  if (typeof v === 'object') {
    const min = Number(v.min), max = Number(v.max)
    if (!Number.isFinite(min) && !Number.isFinite(max)) return null
    return {
      min: Number.isFinite(min) ? min : Number.isFinite(max) ? max : 0,
      max: Number.isFinite(max) ? max : Number.isFinite(min) ? min : 0,
      per: v.per || null,
    }
  }
  // Un entero escrito como texto es un error de la DNA, no una forma más: se acepta pero se avisa.
  const n = Number(v)
  if (Number.isFinite(n)) {
    console.warn(`[image_count] "${def.key || def.name}" lo declara como texto («${v}»), no como número`)
    return { min: n, max: n, per: null }
  }
  return null
}

// El techo: cuántas puede llegar a producir. Es lo que usan las guardas que preguntan «¿ya está
// completo?» — con un rango, cortar en el mínimo rechazaría imágenes legítimas.
const techoDeclarado = def => cuantasDeclara(def)?.max ?? null

// El piso, para avisar cuando salieron de menos.
const pisoDeclarado = def => cuantasDeclara(def)?.min ?? null

// Cómo se escribe para una persona: «1», «3–5».
function textoDeCuenta(def) {
  const c = cuantasDeclara(def)
  if (!c) return null
  return c.min === c.max ? String(c.min) : `${c.min}–${c.max}`
}

// ¿La cantidad generada respeta lo declarado? Devuelve null cuando no hay nada declarado —no
// saber no es lo mismo que estar mal— y si no, el veredicto con un motivo listo para loguear.
function verificarCuenta(def, generadas) {
  const c = cuantasDeclara(def)
  if (!c) return null
  const clave = def.key || def.name || '?'
  if (generadas < c.min) {
    return { ok: false, motivo: `"${clave}" declara ${textoDeCuenta(def)} imagen(es) y se generaron ${generadas}`
      + (c.per ? ` — la cantidad sale de \`${c.per}\`` : '') }
  }
  if (generadas > c.max) {
    return { ok: false, motivo: `"${clave}" declara ${textoDeCuenta(def)} imagen(es) y se generaron ${generadas}`
      + (c.per ? ` — la cantidad sale de \`${c.per}\`` : '') }
  }
  return { ok: true, motivo: null }
}

module.exports = { cuantasDeclara, techoDeclarado, pisoDeclarado, textoDeCuenta, verificarCuenta }
