// Registra un workflow de ComfyUI que renderiza un DECK: una o muchas páginas en un solo grafo,
// cada una con su prompt, su salida y —a veces— un hueco para una imagen de referencia del proyecto.
//
// El `inject_config` se DERIVA del grafo, nunca se escribe a mano. Escribir esa tabla a mano es
// como se llegó a un config que apuntaba a nodos inexistentes y a láminas con el marcador sin
// reemplazar.
//
// Se reconoce por FORMA, no por nombre de clase. La versión anterior buscaba `GPTImage|KSampler`
// colgando de un `SaveImage`, y con eso solo veía decks de imagen: el 09-09 los workflows de
// Marketing_Video (`GeminiVideoOmni` → `SaveVideo`) y Audio_Base (`ByteDanceSeedAudio` →
// `SaveAudioAdvanced`) daban «0 páginas» y no se podían registrar, aunque los archivos estaban
// bien. Ahora una página es CUALQUIER nodo `Save*` con algo colgando, y el prompt es el string
// literal que trae la caja del intake, esté en el propio nodo del modelo (`text_prompt` en Audio)
// o tres nodos aguas arriba, detrás de dos `StringConcatenate` (`value` en Video).
//
// Registra una fila NUEVA por nombre. Reemplazar el deck que un nodo ya usa lo deja pidiendo
// páginas que no existen: los outputs fijan `pages` por índice y `image_count` por número, así que
// el maestro nuevo convive con el viejo hasta que la DNA apunte a él.
//
// Uso:  node scripts/registrar-deck.js <workflow_api.json> <nombre> ["descripción"]
//       node scripts/registrar-deck.js <workflow_api.json> <nombre> ["descripción"] --apply
require('dotenv').config()
const fs = require('fs')
const { db } = require('../src/services/supabase.service')

const [, , RUTA, NOMBRE, DESCRIPCION] = process.argv
const APLICAR = process.argv.includes('--apply')
if (!RUTA || !NOMBRE) {
  console.error('uso: node scripts/registrar-deck.js <workflow_api.json> <nombre> ["descripción"] [--apply]')
  process.exit(1)
}

// De dónde saca su referencia una página que tiene hueco. El motor lo lee del propio prompt, así
// que una página con hueco y sin esta frase se renderiza solo con la plantilla, en silencio.
// Dos convenciones vivas: la del ASG/Art Bible y la que traen las láminas de Marketing.
const RX_FUENTE = /IMAGE (\d+) = [^\n]*coming from ([^.]+)\./gi
const RX_REFIMG = /reference image (\d+)\s*(?:=|\()\s*([^)\n]+)/gi
// Y el slot que el prompt MENCIONA aunque no diga de dónde sale. Es la diferencia entre una
// maqueta del estudio y un hueco que nadie llenó: si el prompt habla de «reference image 2», esa
// imagen es del proyecto. Sin esto, Marketing_Video pasaba como si sus dos LoadImage fueran
// maquetas y se habría renderizado con las dos imágenes de muestra del autor, en silencio.
const RX_MENCION = /reference image (\d+)/gi
// Y la tercera forma viva, la del UIUX: «IMAGE 2 = The VISUAL REFERENCE, LOGO & CONCEPT ART (from
// Pitch/GDD)». Dice de dónde sale, solo que entre paréntesis y sin la palabra «coming».
const RX_PAREN = /IMAGE (\d+) = [^\n]*?\(from ([^)\n]+)\)/gi
// El Art Bible cita en cambio la página del ASG que le sirve de canon.
const RX_ASG = /Art Style Guide \(ASG\s*[·.\-]?\s*(\d{1,2})\s*([^)]*)\)/i

const esSave = c => /^Save/i.test(c || '')
const esLoad = c => /^LoadImage/i.test(c || '')
const CAMPOS = ['prompt', 'text_prompt', 'value', 'text', 'string', 'positive']
const enlaces = n => Object.entries(n?.inputs || {}).filter(([, v]) => Array.isArray(v) && typeof v[0] === 'string')

// Qué clase de activo produce esta página. Lo dice el nodo que lo guarda.
const tipoDe = c => /Audio/i.test(c) ? 'audio'
  : /Video|WEBM|AnimatedWEBP|Gif/i.test(c) ? 'video'
    : 'image'

// Todo lo alcanzable caminando hacia atrás por los inputs, CON su distancia al productor. Es el
// mismo paseo que hace el podado del motor, y sirve igual para un grafo de tres nodos que para el
// ASG de 25 páginas. La distancia importa cuando un deck encadena etapas: la sprite sheet del
// UIUX cuelga de la pantalla, así que el prompt de la pantalla también le queda aguas arriba.
function aguasArriba (wf, raiz) {
  const dist = new Map(), cola = [[raiz, 0]]
  while (cola.length) {
    const [id, d] = cola.shift()
    if (!id || dist.has(id) || !wf[id]) continue
    dist.set(id, d)
    for (const [, v] of enlaces(wf[id])) cola.push([v[0], d + 1])
  }
  return dist
}

// El prompt de la página: el string literal que trae la caja del intake. Si ninguno la trae —un
// deck viejo, sin caja— se cae al literal más largo de los campos conocidos, que es lo que la
// versión anterior asumía sin decirlo.
function hallarPrompt (wf, ids) {
  const cand = []
  for (const [id, d] of ids) {
    for (const [campo, v] of Object.entries(wf[id]?.inputs || {})) {
      if (Array.isArray(v) || typeof v !== 'string') continue
      if (!CAMPOS.includes(campo) && !/prompt|text/i.test(campo)) continue
      cand.push({ id, campo, texto: v, caja: /╔/.test(v), dist: d })
    }
  }
  const conCaja = cand.filter(c => c.caja)
  const pool = conCaja.length ? conCaja : cand
  // Manda la CERCANÍA, no el tamaño. Las cuatro sprite sheets del UIUX cuelgan de su pantalla, y
  // el prompt de la pantalla es más largo que el suyo: por tamaño, las ocho páginas del deck
  // terminaban compartiendo cuatro prompts y las sprite sheets quedaban sin el suyo.
  return pool.sort((a, b) => a.dist - b.dist || b.texto.length - a.texto.length)[0] || null
}

;(async () => {
  const wf = JSON.parse(fs.readFileSync(RUTA, 'utf8'))

  // Puerta 1 · el export de API. El del editor trae `nodes`/`links` y ComfyUI lo rechaza.
  if (!Object.values(wf).some(n => n && n.class_type)) {
    console.error('*** ese archivo es el export del editor, no el de API (falta class_type) ***')
    process.exit(1)
  }

  const paginas = []
  for (const [sid, save] of Object.entries(wf)) {
    if (!esSave(save.class_type)) continue
    const productor = enlaces(save)[0]?.[1]?.[0]
    if (!productor) { console.warn(`el nodo ${sid} (${save.class_type}) no tiene nada colgando`); continue }

    const ids = aguasArriba(wf, productor)
    const nombre = String(save.inputs?.filename_prefix || '').split('/').pop() || `pagina_${sid}`
    const pr = hallarPrompt(wf, ids)
    if (!pr) { console.warn(`la página ${nombre} no tiene ningún prompt legible`); continue }

    // Las fuentes que se declaran, por número de slot. Se leen del prompt de la página y también
    // de los que le quedan aguas arriba, del más cercano al más lejano: en un deck encadenado la
    // página derivada no vuelve a nombrar la referencia —la sprite sheet del UIUX trabaja sobre la
    // pantalla ya generada— pero comparte su LoadImage, y quien la nombra es la pantalla.
    const fuentes = new Map()
    const mencionados = new Set()
    const textos = [...ids.entries()]
      .sort((a, b) => a[1] - b[1])
      .flatMap(([id]) => Object.entries(wf[id]?.inputs || {})
        .filter(([c, v]) => typeof v === 'string' && (CAMPOS.includes(c) || /prompt|text/i.test(c)))
        .map(([, v]) => v))
    for (const t of textos) {
      for (const m of t.matchAll(RX_FUENTE)) if (!fuentes.has(m[1])) fuentes.set(m[1], m[2].trim())
      for (const m of t.matchAll(RX_REFIMG)) if (!fuentes.has(m[1])) fuentes.set(m[1], m[2].trim())
      for (const m of t.matchAll(RX_PAREN)) if (!fuentes.has(m[1])) fuentes.set(m[1], m[2].trim())
      for (const m of t.matchAll(RX_MENCION)) mencionados.add(m[1])
    }

    // Los LoadImage alcanzables. Cuál es hueco del proyecto y cuál es la maqueta del estudio:
    //   · marcador REPLACE_WITH en el nombre del archivo → hueco declarado por el autor
    //   · segunda rama de un ImageBatch                  → la regla vieja, la del ASG/Art Bible
    //   · cableado a un slot `image_N`/`reference_image` cuya fuente el prompt nombra → hueco
    // Cualquier otro LoadImage es la maqueta del estudio y NO se inyecta.
    const refs = []
    for (const id of ids.keys()) {
      const n = wf[id]
      if (!esLoad(n?.class_type)) continue
      const archivo = String(n.inputs?.image || '')
      // El marcador dice «acá va una imagen», no de quién. `REPLACE_WITH__TEMPLATE_…` es la
      // maqueta del estudio —la lámina maestra del ASG— y NO se inyecta; sin esta salvedad el
      // ASG de 25 pasaba de 8 huecos a 25 y habría pisado sus propias maquetas.
      const marcador = /^REPLACE_WITH/i.test(archivo) && !/TEMPLATE/i.test(archivo)

      let slot = null, dueño = null
      for (const otro of ids.keys()) {
        for (const [campo, v] of enlaces(wf[otro])) {
          if (v[0] !== id) continue
          dueño = otro
          const m = /image_(\d+)|reference_image/i.exec(campo)
          if (m) slot = m[1] || '1'
        }
      }
      const lote = dueño && /ImageBatch/i.test(wf[dueño]?.class_type || '')
      const segundaRama = Boolean(lote) && enlaces(wf[dueño])[1]?.[1]?.[0] === id
      // En un ImageBatch el prompt las llama IMAGE 1 y IMAGE 2 por su rama: la segunda es la del
      // proyecto. Sin esto el hueco quedaba sin fuente aunque el prompt la nombrara.
      if (!slot && lote) slot = String(enlaces(wf[dueño]).findIndex(([, v]) => v[0] === id) + 1)
      const fuente = slot ? fuentes.get(slot) : null

      const hueco = marcador || segundaRama || Boolean(fuente) || (slot && mencionados.has(slot))
      refs.push({
        id: String(id), slot, archivo, hueco,
        fuente: fuente || (marcador ? archivo.replace(/^REPLACE_WITH_*/i, '').replace(/\.[a-z0-9]+$/i, '') : null),
      })
    }

    paginas.push({
      nombre, gid: String(pr.id), campo: pr.campo, save: String(sid),
      tipo: tipoDe(save.class_type), clase: save.class_type,
      refs, prompt: pr.texto,
    })
  }
  paginas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'en', { numeric: true }))

  const huecos = paginas.flatMap(p => p.refs.filter(r => r.hueco))
  console.log(`${NOMBRE}`)
  console.log(`  nodos: ${Object.keys(wf).length} · páginas: ${paginas.length}`
    + ` · con hueco de referencia: ${paginas.filter(p => p.refs.some(r => r.hueco)).length}`)
  console.log(`  tipos: ${[...new Set(paginas.map(p => p.tipo))].join(', ') || '—'}\n`)
  for (const p of paginas) {
    const asg = RX_ASG.exec(p.prompt)
    console.log(`  ${p.nombre.padEnd(28)} ${p.tipo.padEnd(5)} prompt=${p.gid.padStart(5)}.${p.campo.padEnd(11)}`
      + ` save=${p.save.padStart(3)} (${p.clase})`
      + (asg ? `  canon ← ASG ${asg[1]} ${(asg[2] || '').trim()}` : ''))
    for (const r of p.refs) {
      console.log(`      ${r.hueco ? 'hueco  ' : 'maqueta'} LoadImage ${r.id}${r.slot ? ` slot ${r.slot}` : ''}`
        + (r.hueco ? ` ← ${r.fuente || '¡no dice de dónde!'}` : ` (${r.archivo.slice(0, 40)})`))
    }
  }

  // Puerta 2 · una página con hueco tiene que declarar su fuente.
  const sinFuente = huecos.filter(r => !r.fuente)
  if (sinFuente.length) {
    console.error(`\n*** ${sinFuente.length} hueco(s) sin declarar su fuente ***`)
    process.exit(1)
  }
  if (!paginas.length) { console.error('\n*** no encontré ninguna página ***'); process.exit(1) }

  const inject_config = {
    mode: 'per_page',
    note: 'Un prompt por página. NO usar inject.prompt: este workflow no tiene un prompt único.'
      + (huecos.length
        ? ` Solo ${paginas.filter(p => p.refs.some(r => r.hueco)).length} página(s) admiten referencia del proyecto;`
          + ' en las demás el único LoadImage es la maqueta del estudio y no se inyecta.'
        : ''),
    seed: { field: 'seed' },
    pages: paginas.map(p => {
      const propios = p.refs.filter(r => r.hueco)
      const fila = { name: p.nombre, save_node: p.save, prompt_node: p.gid, kind: p.tipo }
      // El campo del prompt viaja siempre que no sea el de siempre: el inyector escribe
      // `.inputs.prompt` a ciegas, y en Audio el campo es `text_prompt` y en Video `value`.
      if (p.campo !== 'prompt') fila.prompt_field = p.campo
      // `image_input` sigue siendo el primero, por los consumidores que ya lo leen. `image_inputs`
      // viaja siempre que haya hueco: lleva la FUENTE de cada uno, que es lo que el motor necesita
      // para no renderizar con la imagen de muestra del autor.
      if (propios[0]) fila.image_input = propios[0].id
      if (propios.length) fila.image_inputs = propios.map(r => ({ node: r.id, slot: r.slot, source: r.fuente }))
      return fila
    }),
  }

  const { data: ya } = await db().from('comfyui_workflows').select('id,name').eq('name', NOMBRE).maybeSingle()
  console.log(`\n${ya ? 'ya existe una fila con ese nombre: se actualiza' : 'no existe: se crea'}`)
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const fila = {
    name: NOMBRE,
    description: DESCRIPCION && !DESCRIPCION.startsWith('--') ? DESCRIPCION : `Deck de ${paginas.length} páginas.`,
    workflow_json: wf,
    inject_config,
    is_active: true,
  }
  const { error } = ya
    ? await db().from('comfyui_workflows').update(fila).eq('id', ya.id)
    : await db().from('comfyui_workflows').insert(fila)
  if (error) { console.error(error.message); process.exit(1) }

  const { data: r } = await db().from('comfyui_workflows').select('name,is_active,inject_config').eq('name', NOMBRE).single()
  const cfg = typeof r.inject_config === 'string' ? JSON.parse(r.inject_config) : r.inject_config
  console.log(`\n=== verificación ===\n  ${r.name} · activo=${r.is_active} · ${cfg.pages.length} páginas`
    + ` · ${cfg.pages.filter(p => p.image_input).length} con hueco de referencia`)
})()
