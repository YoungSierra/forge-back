// ─── Servicio de generación de imágenes ───────────────────────────────────────
// Núcleo reutilizable extraído de la ruta generate-item-image. Lo usan:
//  · la ruta on-demand /generate-item-image (botón ✦ del frontend)
//  · executeImageOutput() en el auto-run (Run All / scoped runs)
//
// Principio: el ADN manda. El conteo de imágenes NO se hardcodea — sale de cuántos
// ítems produzca el contenido del output (parseOutputItems), tal como pida su prompt.

const { logExecution } = require('./execution-log.service')

// ─── Filtro estricto de outputs de imagen auto-generables ──────────────────────
// Solo png/image con image_gen:true. Los outputs prose/markdown con image_gen:true
// (botón ✦ manual) quedan user-decided y NO se auto-generan.
function imageOutputsOf(node) {
  const outs = (Array.isArray(node?.outputs) ? node.outputs : []).map(o => ({ ...o, key: o.key || o.name }))
  // Lo que decide es `image_gen`, NO el formato. Exigir png/image dejaba fuera a los documentos
  // que generan sus propias imágenes —2.1/pitch_document es docx con image_gen: true— y con eso
  // quedaban invisibles para TODO el motor: el Run del nodo, el del lane y el post-pass del chat.
  // El nodo corría, el texto salía, y las imágenes no las pedía nadie.
  return outs.filter(o => o.key && o.image_gen === true)
}

// ─── Port de parseOutputItems (frontend NodeChatWindow.tsx) ────────────────────
// Diferencia clave con el frontend: NO se colapsa png/image a 1 ítem. El contenido
// se parsea en N ítems (la lista de prompts que escribe el agente) → N imágenes.
// Respeta el ADN: si el prompt pide "2–3 imágenes", el agente produce 2–3 prompts.
// Bloques encabezados que enumeran entidades: «## SEED 01», «### Angle 2», «### Image 3».
// Cuando existen, ESOS son los ítems y no se discute.
//
// Iban últimos, así que las viñetas ganaban siempre — y un documento de semillas está lleno de
// viñetas que no son semillas. Medido: a ComfyUI se le mandó «Primary: Arcade / Action» y
// «Celeste (Extremely OK Games, 2018) — precision platformer…» como prompts de imagen. Eran la
// clasificación de género y los comparables; las semillas, que son encabezados, nunca se miraron.
//
// Se exige el MISMO nivel de encabezado en todos: un `### Rationale` dentro de un `## SEED 04` es
// parte de la semilla, no otra semilla.
// El SUSTANTIVO importa. «Cualquier palabra + número» tomaba también el título del documento
// —«Concept Seeds · Pass 3»— y para protegerse había que exigir dos bloques. Con el vocabulario
// que la DNA usa de verdad, UN bloque ya alcanza: una corrida incremental agrega una sola semilla
// y las anteriores no se repiten, y ahí exigir dos volvía a caer en las viñetas.
// El encabezado EMPIEZA con el sustantivo. Eso separa «## SEED I» —que nombra una entidad— de
// «# SMACK — Concept Seeds · Iteration 4», que la menciona al pasar.
//
// Antes se exigía además un NÚMERO, y las semillas nombradas con letra (SEED I, J, L) no
// matcheaban: caían a viñetas y el nodo ofrecía quince imágenes de la lista de mecánicas. Aceptar
// la letra en cualquier posición fue peor —se comía el título del documento y colapsaba todo a un
// ítem, medido en 28 de 64 outputs—. Lo que identifica al ítem es cómo ABRE el encabezado.
// Y después del sustantivo tiene que venir un número, una letra sola o un separador — NO otra
// palabra. Sin eso entraban «Seed Comparison at a Glance» y «Seed Shortlist», que son una tabla y
// un índice: cada uno se llevaba un hueco de imagen que nadie pidió.
const RX_ENUMERADO = /^(#{1,4})\s+\**\s*(?:seeds?|variations?|concepts?|angles?|images?|options?|pages?)\s*(?:[·:.\-—]|\d|[A-Z]\b)/i
// Un encabezado que ES un identificador: «### pitch_01_hook». Desde v2.9.13 el título de cada
// entrada del plan ES el id de la imagen, y el 3.20 lo cita verbatim en su reference_map. No
// empieza con ninguna palabra del vocabulario, así que la regla del sustantivo no lo veía: el plan
// del 2.1 salía como UN ítem («DECISION RECORD») en vez de sus cuatro entradas.
const RX_IDENTIFICADOR = /^(#{1,4})\s+\**\s*[a-z][a-z0-9]*(?:_[a-z0-9]+)+\**\s*$/

// Agrupa los encabezados que marcan entidad y devuelve un bloque por cada uno. Se exige el MISMO
// nivel en todos: un `### Rationale` dentro de un `## SEED 04` es parte de la semilla.
function bloquesPorMarcas(lineas, marcas, minimo = 1) {
  if (marcas.length < minimo) return null
  const nivel   = Math.min(...marcas.map(m => m.nivel))
  const propias = marcas.filter(m => m.nivel === nivel)
  if (propias.length < minimo) return null
  return propias.map((p, k) => {
    const hasta = k + 1 < propias.length ? propias[k + 1].i : lineas.length
    return lineas.slice(p.i, hasta).join('\n').trim()
  })
}

function bloquesEnumerados(texto) {
  const lineas = String(texto || '').split('\n')
  const porSustantivo = [], porIdentificador = []
  for (let i = 0; i < lineas.length; i++) {
    const m = RX_ENUMERADO.exec(lineas[i])
    if (m) { porSustantivo.push({ i, nivel: m[1].length }); continue }
    const d = RX_IDENTIFICADOR.exec(lineas[i])
    if (d) porIdentificador.push({ i, nivel: d[1].length })
  }
  // El sustantivo manda; los identificadores son el respaldo y piden DOS o más, porque un
  // `## concept_seeds` suelto es el ancla de un output, no una entrada.
  return bloquesPorMarcas(lineas, porSustantivo, 1) ?? bloquesPorMarcas(lineas, porIdentificador, 2)
}

// Un objeto del array, escrito como se lo lee una persona. Mandarle `JSON.stringify` al modelo de
// imagen le da llaves y comillas en vez de un sujeto: el prompt tiene que ser el título y lo que
// lo describe, no su serialización.
const OCULTO = new Set(['id', 'key', 'index', 'seed_id', 'uuid', 'gaps_for_downstream'])
const CABECERA = ['title', 'name', 'one_liner', 'oneLiner', 'summary', 'description', 'label']
const rotulo = k => String(k).replace(/_/g, ' ').replace(/\w/g, c => c.toUpperCase())
const plano = v =>
  Array.isArray(v) ? v.filter(x => x != null).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' · ')
  : typeof v === 'string' ? v
  : (typeof v === 'number' || typeof v === 'boolean') ? String(v)
  : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${rotulo(k)}: ${plano(x)}`).join(' · ')
  : ''
function textoDeItem(el) {
  if (typeof el === 'string') return el
  if (!el || typeof el !== 'object') return String(el ?? '')
  const cab = CABECERA.map(k => el[k]).filter(v => typeof v === 'string' && v.trim())
  const resto = Object.entries(el)
    .filter(([k, v]) => !CABECERA.includes(k) && !OCULTO.has(k) && plano(v).trim())
    .map(([k, v]) => `${rotulo(k)}: ${plano(v)}`)
  return (cab.length || resto.length) ? [cab.join(' — '), ...resto].filter(Boolean).join('\n\n') : ''
}

function parseOutputItems(content, format, outputKey = null) {
  // Fuera antes de mirar nada: `gaps_for_downstream` —que la enmienda M-8 obliga a emitir al
  // cierre de todo output de concepto— son huecos pendientes para los nodos de abajo, no
  // contenido ilustrable. Sus líneas empiezan con «- gap:», así que la regla de viñetas las tomaba
  // y el nodo ofrecía una imagen POR CADA HUECO. El front ya lo descartaba; el backend no, y es el
  // que corre el auto-run.
  content = String(content || '').replace(/^#{1,4}[ \t]+gaps_for_downstream[\s\S]*$/im, '').trim()

  // Un array declarado manda sobre cualquier lectura de la prosa — y se busca en TODOS los
  // bloques cercados, no en el primero. Medido: una respuesta abría con un diagrama ASCII y traía
  // las semillas en JSON más abajo; mirar solo el primero las perdía. Y `format` acá casi nunca es
  // 'json': `concept_seeds` es `list<concept_seed>`, así que exigirlo dejaba el JSON sin leer
  // justo en las corridas que SÍ lo emitieron.
  if (format === 'json' || /^list</.test(String(format || '')) || format === 'structured') {
    const bloques = [...content.matchAll(/```(\w*)\s*([\s\S]*?)```/g)]
      .map(m => ({ lang: (m[1] || '').toLowerCase(), cuerpo: m[2] }))
    const candidatos = [
      ...bloques.filter(b => b.lang === 'json').map(b => b.cuerpo),
      ...bloques.filter(b => b.lang === '').map(b => b.cuerpo),
      ...(bloques.length ? [] : [content]),
    ]
    // El array se busca POR SU NOMBRE, no por ser el primero. Toda respuesta de concepto cierra
    // con `gaps_for_downstream`, que también es un array de objetos, y el 1.1 lo emite ANTES de
    // las semillas: pidiendo «el primer array» se ofrecía una imagen por cada hueco pendiente.
    // Medido el 01-09: diez ítems, los diez gaps, cero semillas.
    const esHueco = o => o && typeof o === 'object' && ('gap' in o || 'node_that_needs_it' in o)
    const arrayPorNombre = texto => {
      if (!outputKey) return null
      const rx = new RegExp('"' + outputKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*\\[')
      const m = rx.exec(texto)
      if (!m) return null
      const desde = texto.indexOf('[', m.index)
      // Cierre por conteo de corchetes: `lastIndexOf` se pasa al siguiente array del documento.
      let nivel = 0
      for (let i = desde; i < texto.length; i++) {
        if (texto[i] === '[') nivel++
        else if (texto[i] === ']' && --nivel === 0) {
          try { const v = JSON.parse(texto.slice(desde, i + 1)); return Array.isArray(v) ? v : null } catch { return null }
        }
      }
      return null
    }

    for (const texto of candidatos) {
      const nombrado = arrayPorNombre(texto)
      if (nombrado?.length) {
        const items = nombrado.map(textoDeItem).filter(x => x.trim())
        if (items.length) return items
      }
    }
    for (const texto of candidatos) {
      const a = texto.indexOf('['), b = texto.lastIndexOf(']')
      if (a === -1 || b <= a) continue
      try {
        const arr = JSON.parse(texto.slice(a, b + 1))
        if (!Array.isArray(arr) || !arr.length) continue
        if (arr.every(esHueco)) continue   // son huecos pendientes, no contenido ilustrable
        const items = arr.map(textoDeItem).filter(x => x.trim())
        if (items.length) return items
      } catch { /* no era éste */ }
    }
  }

  // Un output de IMAGEN también puede declarar sus imágenes en un bloque JSON, y hasta ahora nadie
  // lo leía porque su `format` es 'png'. El 2.2 cerró su respuesta declarando UNA imagen con su
  // prompt completo, y como el parseo cayó a la prosa se ofrecieron OCHO — entre ellas las viñetas
  // que dicen «No image needed». Dos renders se pagaron con la frase «Setting / Art & Audio… No
  // gap.» como prompt.
  //
  // Se exige que sea un arreglo de objetos donde la mayoría trae `prompt`: eso distingue una
  // declaración de imágenes de un arreglo de paleta, de gaps o de cualquier otro JSON suelto.
  // Medido sobre las 33 respuestas de outputs de imagen de la base: 32 no cambian, 1 pasa de 8 a 1
  // ítem, ninguna sube.
  if (format === 'png' || format === 'image') {
    // El sobre se busca SIN depender de los cercados. Emparejar ``` funciona hasta que el modelo
    // abre un bloque y no lo cierra: ahí el número de marcas queda impar, todo el emparejamiento
    // se corre y el sobre se vuelve invisible. Medido el 01-09 en el 2.2 — el modelo truncó su
    // `concept_data` a mitad de una URL, la respuesta quedó con cinco marcas, y ni el back ni el
    // front vieron las tres imágenes que el sobre declaraba con su id: el back despachó cuatro
    // renders de las secciones del documento y el front ofreció seis huecos sacados de la prosa.
    //
    // Los cercados son decoración; el dato es el arreglo. Se ancla en la sección DEL OUTPUT y se
    // lee el primer arreglo balanceado que venga después, cerrando por conteo de corchetes.
    const sobreDeLaSeccion = () => {
      if (!outputKey) return null
      const esc = outputKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const anc = new RegExp(`^#{1,4}[ \\t]+\\**\\s*${esc}\\b.*$`, 'im').exec(content)
      if (!anc) return null
      const desde = content.slice(anc.index + anc[0].length)

      // No vale «el primer arreglo después del encabezado»: la sección del 2.4 abre con su tabla
      // de paleta y una lista de tres hex, y esa se llevaba el cupo — a ComfyUI le habrían llegado
      // «#E8930A», «#04060F» y «#7B2FBE» como prompts. Un sobre de imágenes se reconoce por lo que
      // trae dentro: objetos con `prompt`/`image_prompt`/`depicts`. Se recorren todos los arreglos
      // balanceados de la sección y se toma el PRIMERO que lo parezca.
      // No se exige NINGÚN nombre de campo. Perseguirlos fue perder un día entero: cuatro corridas
      // del 2.2, la misma DNA, cuatro esquemas — `subject`+`composition_notes`, luego `prompt`,
      // luego `subject`+`composition`+`mood`+`negative`, y ahora `purpose`+`type`+
      // `style_inheritance`+`placement_in_concept_document`. Cada nombre nuevo era otro arreglo, y
      // el que faltaba dejaba el output en cero.
      //
      // Lo que SÍ define un sobre, y no cambia: está dentro de la sección de este output, sus
      // entradas son objetos, y cada una se identifica y se describe. Un `id` y un texto con
      // cuerpo suficiente para ser una imagen. La lista de paleta del 2.4 —tres cadenas de hex
      // sueltas— no pasa: ni son objetos ni tienen id.
      const describe = o => Object.entries(o).some(([k, v]) =>
        k !== 'id' && typeof v === 'string' && v.trim().length >= 40)
      const esSobre = v => Array.isArray(v) && v.length
        && v.every(o => o && typeof o === 'object' && !Array.isArray(o))
        && v.filter(o => typeof o.id === 'string' && o.id.trim()).length >= Math.ceil(v.length / 2)
        && v.some(describe)

      for (let ini = desde.indexOf('['); ini !== -1; ini = desde.indexOf('[', ini + 1)) {
        let nivel = 0
        for (let i = ini; i < desde.length; i++) {
          if (desde[i] === '[') nivel++
          else if (desde[i] === ']' && --nivel === 0) {
            try {
              const v = JSON.parse(desde.slice(ini, i + 1))
              if (esSobre(v)) return v
            } catch { /* no era un arreglo legible; se prueba el siguiente */ }
            break
          }
        }
      }
      return null
    }
    {
      const arr = sobreDeLaSeccion()
      if (arr) {
        // Una entrada que trae URL y no trae prompt NO es un encargo: es una REFERENCIA a arte que
        // ya existe. El 2.4 —Visual Convergence— no genera nada: converge el arte aprobado del 2.2
        // y su sobre es un manifiesto `{ role, url, source }`. Sin distinguirlo, el motor lo trató
        // como tres encargos y le mandó a ComfyUI la URL COMO TEXTO: medido el 02-09, el prompt de
        // una de las imágenes era literalmente «role: splash_art_wide  url: https://…png».
        //
        // Es la misma regla que v2.9.27 le puso al sobre por el lado de la DNA —«no URL, no path
        // dentro del bloque; el sobre transporta ids y texto de prompt»—, aplicada acá para los
        // nodos que ese delta todavía no cubre.
        const esReferencia = o => o && typeof o === 'object'
          && ['url', 'path', 'src', 'image_url'].some(k => typeof o[k] === 'string' && /^(https?:|\/)/.test(o[k].trim()))
          && !['prompt', 'image_prompt'].some(k => typeof o[k] === 'string' && o[k].trim())
        const refs = arr.filter(esReferencia).length
        if (refs) {
          console.warn(`[img] ${outputKey}: ${refs} de ${arr.length} entrada(s) son REFERENCIAS a arte ya existente`
            + ' (traen url y no prompt) — no se renderizan.')
        }

        // Un `prompt` declarado va tal cual. Sin él, la entrada se arma con sus campos —sujeto,
        // composición, ánimo, paleta— que es exactamente lo que describe la imagen; serializar el
        // objeto entero le mandaría llaves y comillas al modelo de imagen.
        const items = arr.filter(o => !esReferencia(o)).map(o => {
          if (typeof o === 'string') return o
          for (const campo of ['prompt', 'image_prompt']) {
            const v = o?.[campo]
            if (typeof v === 'string' && v.trim()) return v.trim()
          }
          return textoDeItem(o)
        }).filter(x => String(x).trim())
        if (items.length) {
          console.log(`[img] ${outputKey}: sobre leído desde su propia sección — ${items.length} ítem(s)`)
          return items
        }
        // Sobre entero de referencias: el output no encarga nada. Cero, y se corta acá — dejarlo
        // seguir lo mandaría a los lectores de prosa, que ilustrarían el documento.
        if (refs === arr.length) {
          console.log(`[img] ${outputKey}: el sobre son ${refs} referencia(s) a arte existente — 0 encargos.`)
          return []
        }
      }
    }

    const bloques = [...content.matchAll(/```(\w*)\s*([\s\S]*?)```/g)]
      .map(m => ({ lang: (m[1] || '').toLowerCase(), cuerpo: m[2] }))
    const cercados = [
      ...bloques.filter(b => b.lang === 'json').map(b => b.cuerpo),
      ...bloques.filter(b => b.lang === '').map(b => b.cuerpo),
    ]

    // El bloque declarado tiene que ser EL DE ESTE OUTPUT, no cualquier arreglo de la respuesta.
    // El 2.2 decidió `development_images: []` —cero imágenes, y lo argumenta— y a continuación
    // emitió `approved_images`, que es el INVENTARIO de lo ya aprobado que le pasa a los nodos de
    // abajo. Tomar ese inventario como encargo hizo ofrecer un hueco donde el nodo dijo cero, y
    // se generó un duplicado de la semilla. Si el output se nombra a sí mismo, esa lista manda —
    // incluso vacía, que es una respuesta legítima.
    // La declaración de CERO no siempre va en un cercado: el 2.2 la escribe en prosa, como
    // «`development_images: []` — no images added». Es inequívoca —el output se nombra a sí mismo
    // con la lista vacía— y su DNA dice que cero es una respuesta válida y común. Sin leerla se
    // ofrecía un hueco de todos modos.
    if (outputKey && new RegExp(`\`?"?${outputKey}"?\\s*:\\s*\\[\\s*\\]`).test(content)) return []

    if (outputKey) {
      const rx = new RegExp(`"${outputKey}"\\s*:\\s*\\[`)
      for (const texto of cercados) {
        const m = rx.exec(texto)
        if (!m) continue
        const desde = texto.slice(m.index + m[0].length - 1)
        let prof = 0, fin = -1
        for (let i = 0; i < desde.length; i++) {
          if (desde[i] === '[') prof++
          else if (desde[i] === ']') { prof--; if (!prof) { fin = i; break } }
        }
        if (fin < 0) continue
        let arr
        try { arr = JSON.parse(desde.slice(0, fin + 1)) } catch { continue }
        if (!Array.isArray(arr)) continue
        return arr.map(o => (typeof o === 'string' ? o : textoDeItem(o))).filter(x => String(x).trim())
      }
    }

    for (const texto of cercados) {
      const a = texto.indexOf('['), b = texto.lastIndexOf(']')
      if (a === -1 || b <= a) continue
      let arr
      try { arr = JSON.parse(texto.slice(a, b + 1)) } catch { continue }
      if (!Array.isArray(arr) || !arr.length) continue
      if (!arr.every(x => x && typeof x === 'object' && !Array.isArray(x))) continue
      // `prompt` primero —es el texto listo para renderizar— y `depicts` como segunda opción: la
      // DNA del 2.2 declara sus imágenes con `depicts` y sin `prompt`, y exigir `prompt` dejaba
      // esa declaración sin leer. Medido sobre las 33 respuestas de la base: 32 no cambian, la
      // del 2.2 pasa de 3 ítems a 2, ninguna sube.
      const prompts = arr.map(o => {
        for (const campo of ['prompt', 'image_prompt', 'depicts']) {
          const v = o[campo]
          if (typeof v === 'string' && v.trim()) return v.trim()
        }
        return ''
      })
      if (prompts.filter(Boolean).length * 2 < arr.length) continue
      // Sin recorte: un prompt declarado va COMPLETO. El tope de 700 del respaldo existe para no
      // mandar un documento entero, no para cortar a la mitad un prompt que el modelo escribió.
      const items = arr.map((o, i) => prompts[i] || textoDeItem(o)).filter(x => x.trim())
      if (items.length) return items
    }
  }

  // Un bloque cercado SIN lenguaje, en un output de imagen, ES el prompt: el modelo lo delimita a
  // propósito para separarlo de su razonamiento. La regla general los descarta —un ```json o un
  // ```yaml son datos, nunca un sujeto de imagen— y por eso el 2.4 mandaba a ComfyUI 337
  // caracteres de análisis («Diagram 1 confirms the three-phase pulse cycle…») mientras su prompt
  // real, de 1.400 caracteres con paleta en hex, iluminación y negative prompt, quedaba adentro
  // del cercado sin que nadie lo leyera.
  //
  // Se exige: sin lenguaje declarado, que no parsee como JSON, y con cuerpo suficiente para ser un
  // prompt y no una etiqueta suelta. Medido sobre las 34 respuestas de outputs de imagen de la
  // base: 33 no cambian; el 2.4 pasa de 6 ítems de 215 chars a 5 de 1.882.
  if (format === 'png' || format === 'image') {
    const cercados = []
    for (const m of content.matchAll(/```(\w*)\s*([\s\S]*?)```/g)) {
      if ((m[1] || '').trim()) continue
      const cuerpo = m[2].trim()
      if (cuerpo.length < 120) continue
      try { JSON.parse(cuerpo); continue } catch { /* no es dato: es prosa, sirve */ }
      cercados.push(cuerpo)
    }
    if (cercados.length) return cercados
  }

  // Un output de IMAGEN nunca saca sus prompts de la prosa. Si llegamos hasta acá, el sobre no se
  // pudo leer, y lo que sigue abajo son lectores de prosa —viñetas, numeradas, encabezados— que se
  // llevan CUALQUIER lista que encuentren. Eso no es un respaldo: es gasto en arte equivocado.
  //
  // Medido el 01-09 en el 2.2. El modelo abrió un bloque JSON y no lo cerró, así que la respuesta
  // quedó con un número IMPAR de marcas de cercado y el emparejamiento se descolocó: ni el back ni
  // el front encontraron el sobre. El back devolvió las cuatro secciones del documento como
  // sujetos de imagen y despachó cuatro renders del texto del propio documento; el front devolvió
  // seis, las mecánicas y las entradas del plan en prosa. Ninguno de los dos vio las tres imágenes
  // que el sobre declaraba con su id.
  //
  // Lo que arregla el caso del 2.2 es el lector de arriba, que ya no depende de emparejar cercados.
  // Esta compuerta se queda como estaba: solo corta cuando el sobre EXISTE y no se pudo usar.
  // Probé hacerla incondicional y fue peor — medido sobre los 144 pares vivos, 46 se iban a cero,
  // entre ellos `3.9 reference_images` (24 → 0) y `3.3 item_catalog_sheet` (14 → 0), que declaran
  // sus imágenes en prosa por diseño. Matar la prosa para todos arreglaba un nodo y rompía tres.
  if (format === 'png' || format === 'image') {
    const traeSobre = [...content.matchAll(/```(\w*)\s*([\s\S]*?)```/g)].some(m => {
      try {
        const v = JSON.parse(m[2])
        return Array.isArray(v) && v.length && v.every(o => o && typeof o === 'object' && !Array.isArray(o))
      } catch { return false }
    })
    if (traeSobre) {
      console.warn(`[img] ${outputKey || '(sin clave)'}: hay un sobre pero no se pudo usar — 0 ítems, no se adivina.`)
      return []
    }
  }

  // Entidades enumeradas por encabezado — antes que las viñetas, que se llevan cualquier lista.
  const enumerados = bloquesEnumerados(content)
  if (enumerados) return enumerados

  // Bullet list: "- item", "* item", "• item"
  const bulletRx   = /^[ \t]*[-*•][ \t]+(.+)$/gm
  // Numbered list: "1. item", "1) item"
  const numberedRx = /^[ \t]*\d+[.)]\s+(.+)$/gm
  // Markdown heading con número: "## 1. title", "### Variation 1: title"
  const headingRx  = /^#{1,4}\s+(?:\*{0,2})(?:[A-Za-z]+\s+)?\d+[:.)]?\s+(.+)$/gm

  const bullets = [...content.matchAll(bulletRx)].map(m => m[1].trim())
  if (bullets.length > 0) return bullets

  const numbered = [...content.matchAll(numberedRx)].map(m => m[1].trim())
  if (numbered.length > 0) return numbered

  // Labeled con descripción: dividir por cada "Variation N:" y capturar el bloque completo
  const labeledParts = content
    .split(/(?=^[A-Za-z]+[ \t]+\d+[:.]\s)/m)
    .map(p => p.trim())
    .filter(p => /^[A-Za-z]+[ \t]+\d+[:.]\s/.test(p))
  if (labeledParts.length > 0) return labeledParts

  // Heading con número + contenido subsiguiente (bloque completo por ítem)
  const richBlocks = []
  const richRx = /^#{1,4}[ \t]+([^\n]+(?:\n(?!#{1,4}[ \t])[^\n]*)*)/gm
  for (const m of content.matchAll(richRx)) {
    const block = m[1].trim()
    if (/^(?:\*{0,2})(?:[A-Za-z]+[ \t]+)+\d+/.test(block)) richBlocks.push(block)
  }
  if (richBlocks.length > 0) return richBlocks

  const headings = [...content.matchAll(headingRx)].map(m => m[1].trim())
  if (headings.length > 0) return headings

  // Bloques tipo "Seed 001" / "Concept 002" — encabezado plano sin # ni delimitador
  const seedBlocks = content
    .split(/(?=^[A-Za-z][A-Za-z ]*[ \t]+\d{1,4}\s*$)/m)
    .map(p => p.trim())
    .filter(p => /^[A-Za-z][A-Za-z ]*[ \t]+\d{1,4}/.test(p) && p.length > 40)
  if (seedBlocks.length > 1) return seedBlocks

  // Fallback: el contenido completo es un solo prompt → 1 imagen
  const trimmed = content.trim()
  return trimmed ? [trimmed.slice(0, 700)] : []
}

// ─── ¿El contenido trae ENTIDADES, o es un documento suelto? ──────────────────
//
// Un output `list<...>` promete varias piezas —semillas, vistas, páginas—. Cuando el modelo
// devuelve prosa sin entidades, o directamente «I need more information about your concept», el
// parser cae a su último recurso: tomar los primeros 700 caracteres como un prompt. Eso genera una
// imagen de un párrafo cualquiera, la cobra, y nadie se entera de que el nodo corrió sin datos.
//
// Medido el 26-08 sobre 45 corridas per-output: 34 salieron sin estructura, y varias eran
// pedidos de información, no contenido.
//
// Solo aplica a los que PROMETEN varias: un output de una sola imagen que trae su prompt en prosa
// está perfecto y no hay que tocarlo.
function esperaVarias(formato) {
  return /^list</.test(String(formato || ''))
}

function tieneEntidades(content, formato, outputKey = null) {
  const txt = String(content || '').trim()
  if (!txt) return false
  if (!esperaVarias(formato)) return true
  const items = parseOutputItems(txt, formato, outputKey)
  // Un output que se declara VACÍO —«development_images: []», que su propia DNA acepta como
  // respuesta legítima— no tiene nada que ilustrar. Sin esto se ofrecía un hueco donde el nodo
  // había dicho cero, y se pagó un duplicado de la semilla.
  if (!items.length) return false
  // El último recurso devuelve UN ítem que es el propio documento recortado. Si eso es todo lo que
  // hay, no hay entidades que ilustrar.
  return !(items.length === 1 && txt.startsWith(items[0].slice(0, 60)))
}

// ─── Limpieza de markdown del texto del ítem para usarlo como prompt visual ────
function cleanItemText(text) {
  return (text || '').trim()
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')  // quitar negrita/cursiva
    .replace(/^[-*]\s+/, '')                    // quitar bullet inicial
    // El bloque llega con su encabezado, que es lo que le da nombre al ítem — pero los `#` son
    // marcado y no tienen por qué viajar al modelo de imagen.
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^(Variation\s+\d+:\s*)/i, '')     // quitar prefijo "Variation N:"
}

// ─── Genera UNA imagen y devuelve { url } ──────────────────────────────────────
// No toca la base de datos (salvo el log de costo no bloqueante). El caller decide
// cómo persistir (output_images / forge_assets).
async function generateOneImage({
  project_id, node_id, session_id, node_key,
  output_key, image_gen_model, item_index, item_text, condition, member_id,
}) {
  if (!image_gen_model) {
    throw new Error(`Output "${output_key}" no tiene image_gen_model definido`)
  }

  // Parsear "provider:model_o_workflow"
  const colonIdx = image_gen_model.indexOf(':')
  if (colonIdx < 0) {
    throw new Error(`image_gen_model debe tener formato "provider:model" — recibido: "${image_gen_model}"`)
  }
  const provider  = image_gen_model.slice(0, colonIdx)
  const modelOrWf = image_gen_model.slice(colonIdx + 1)

  const storagePath = `projects/${project_id}/item-images/${node_key}/${output_key}-${session_id}-${item_index}-${Date.now()}.png`

  // Construir prompt final con la condición de variación opcional
  const cleanText = cleanItemText(item_text)
  const imagePrompt = condition?.trim()
    ? `${cleanText}\n\nAdditional visual requirement: ${condition.trim()}`
    : cleanText

  const imgStart = Date.now()

  let result
  if (provider === 'comfyui') {
    const { generateImageComfyUI } = require('./providers/comfyui.provider')
    // Arte del proyecto como segunda imagen, si el workflow lo pide.
    //
    // El one-pager del 2.5 recibe DOS imágenes con papeles distintos: la plantilla de layout, que
    // viene con el workflow y de la que se copia la composición, y el arte del juego, del que se
    // toma el aspecto. Ese segundo hueco viene desconectado a propósito: si no hay arte del
    // proyecto NO se enchufa nada. Conectar un relleno sería decirle al modelo «así se ve este
    // juego» con una imagen ajena — el error que nos costó una corrida del ASG.
    const refProyecto = await imagenDelProyecto(project_id, node_id).catch(() => null)
    result = await generateImageComfyUI(modelOrWf, imagePrompt, 1024, 1024, storagePath,
      refProyecto ? { ref_proyecto: refProyecto } : {})
  } else if (provider === 'openai') {
    const { generateImageOpenAI } = require('./providers/openai.image.provider')
    result = await generateImageOpenAI(modelOrWf, imagePrompt, 1024, 1024, storagePath)
  } else if (provider === 'fal') {
    const { generateImageFal } = require('./providers/fal.image.provider')
    result = await generateImageFal(modelOrWf, imagePrompt, 1024, 1024, storagePath)
  } else {
    throw new Error(`Provider de imagen no soportado: "${provider}"`)
  }

  // Registrar costo estimado (no bloqueante, nunca rompe el flujo)
  try {
    logExecution({
      project_id, node_id, session_id,
      triggered_by:  member_id || null,
      trigger_type:  'image_gen',
      executor_type: provider === 'openai' ? 'openai_image' : provider,
      provider,
      model:         modelOrWf,
      is_estimated:  true,
      duration_ms:   Date.now() - imgStart,
      started_at:    new Date(imgStart).toISOString(),
      status:        'success',
      metadata:      { output_key, item_index, width: 1024, height: 1024, node_key },
    })
  } catch (logErr) {
    console.error('[image-gen.service] logExec failed (non-fatal):', logErr.message)
  }

  return { url: result.url, provider, model: modelOrWf }
}

// ¿Este output es un DECK? Lo decide el workflow que declara la DNA, no una lista de node_keys:
// si está registrado `per_page`, sus páginas van en un solo job. Devuelve false ante cualquier
// duda —modelo mal formado, workflow sin registrar— para que el camino de siempre siga andando.
async function esDeck(outDef) {
  const modelo = outDef?.image_gen_model
  if (!modelo || !String(modelo).startsWith('comfyui:')) return false
  try {
    const { getWorkflowByName } = require('./config.service')
    const entry = await getWorkflowByName(String(modelo).slice('comfyui:'.length))
    return entry?.inject_config?.mode === 'per_page'
  } catch { return false }
}

// ─── El arte del proyecto que le entra a un nodo ──────────────────────────────
// Se busca entre lo que ESTE nodo recibe por sus cables, no en todo el proyecto: el 2.5 declara
// `orientation_images` y `pitch_images` como entradas, y esas son las que deben ilustrarlo. Gana
// la más reciente aprobada; si no hay ninguna, se devuelve null y el hueco queda sin conectar.
async function imagenDelProyecto(projectId, nodeId) {
  const { db } = require('./supabase.service')
  const { data: pns } = await db()
    .from('forge_project_nodes').select('id').eq('project_id', projectId).eq('node_id', nodeId).eq('removed', false)
  if (!pns?.length) return null

  const { data: edges } = await db()
    .from('forge_project_edges').select('source_node_id')
    .eq('project_id', projectId).in('target_node_id', pns.map(p => p.id))
  if (!edges?.length) return null

  const { data: fuentes } = await db()
    .from('forge_project_nodes').select('node_id').in('id', [...new Set(edges.map(e => e.source_node_id))])
  const ids = [...new Set((fuentes || []).map(f => f.node_id).filter(Boolean))]
  if (!ids.length) return null

  const { data: png } = await db()
    .from('forge_assets').select('storage_url')
    .eq('project_id', projectId).in('node_id', ids)
    .eq('format', 'png').in('status', ['approved', 'auto_approved'])
    .not('storage_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  return png?.storage_url ?? null
}

// ─── La imagen de referencia de una página, por el NOMBRE del nodo que la produce ─────
//
// El prompt de la página nombra su fuente en prosa: «coming from Pitch Document», «coming from
// Concept Exploration + Visual Orientation». Se resuelve contra el título del nodo en el catálogo
// en vez de contra una tabla acá adentro: si mañana una página cambia de fuente, el motor la
// sigue sin tocar código.
//
// Con varias fuentes («A + B») gana la primera que tenga imagen: el orden en que están escritas
// es el orden de preferencia de quien armó la plantilla.
// ─── La página del ASG que una página del Art Bible toma como canon ───────────
//
// El Art Bible no parte de una plantilla: cada página recibe la página YA RENDERIZADA del Art
// Style Guide de ese mismo proyecto y pinta la obra final de ese tema. El prompt la cita por
// número y nombre —«Art Style Guide (ASG · 05 Character Design Language)»—, y el ASG guarda sus
// páginas como assets llamados «Art Style Guide — 05_CharacterDesign».
//
// El emparejamiento va por NÚMERO. Los nombres no coinciden entre los dos lados («05 Character
// Design Language» contra `05_CharacterDesign`) y el número sí es el mismo en ambos.
async function paginaDelASG(db, projectId, numero) {
  const { data: n } = await db().from('forge_nodes').select('id').eq('node_key', '3.20').maybeSingle()
  if (!n) return null
  const { data: assets } = await db()
    .from('forge_assets')
    .select('name, storage_url, created_at')
    .eq('project_id', projectId).eq('node_id', n.id)
    .eq('format', 'png').in('status', ['approved', 'auto_approved'])
    .not('storage_url', 'is', null)
    .order('created_at', { ascending: false })
  // Se busca el número y nada más. Atar el patrón al guion largo del nombre —«Art Style Guide —
  // 01_KeyArt»— es frágil: ese carácter ya causó un problema de emparejamiento antes, y basta que
  // alguien renombre el separador para que deje de encontrar nada.
  const dosDigitos = String(numero).padStart(2, '0')
  const hit = (assets || []).find(a => new RegExp(`(?:^|\\D)${dosDigitos}_`).test(a.name || ''))
  return hit?.storage_url ?? null
}

// Normaliza el título de un ítem para comparar. Mismo criterio que usa el emparejamiento por
// título de `resolverImagenesDeItems`: lo que separa a dos ítems es el nombre, no la puntuación.
const tituloItem = s => String(s || '')
  .replace(/^[\s\-*#>]+/, '')
  .replace(/^\d+[.)]\s*/, '')
  .replace(/\*+/g, '')
  .split(/\s+[—–-]\s+|\n/)[0]
  .split(':').slice(0, 2).join(':')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Índice título-de-ítem → imagen, para un nodo. Las imágenes viven en `output_images` indexadas
// por POSICIÓN, y el título correspondiente sale del documento del nodo leído en el mismo orden —
// que es como ya se resuelve en `resolverImagenesDeItems`. Un deck además guarda el `name` de la
// página, y ese manda cuando está.
async function imagenesPorItemDeNodo(db, projectId, nodeId) {
  const idx = new Map()
  const { data: sesiones } = await db()
    .from('forge_sessions')
    .select('output_images')
    .eq('project_id', projectId).eq('node_id', nodeId)
    .not('output_images', 'is', null)
    .order('created_at', { ascending: false })
  if (!sesiones?.length) return idx

  const { data: asset } = await db()
    .from('forge_assets')
    .select('content').eq('project_id', projectId).eq('node_id', nodeId)
    .not('content', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const items = asset?.content ? require('./fan-out.service').parseItemsFromContent(asset.content) : []

  for (const s of sesiones) {
    for (const lista of Object.values(s.output_images || {})) {
      for (const it of (lista || [])) {
        const url = it?.variations?.length ? it.variations[it.variations.length - 1]?.url : it?.url
        if (!url) continue
        const fuente = it?.name ?? items[it?.index]?.title ?? items[it?.index] ?? ''
        const t = tituloItem(fuente)
        // La sesión más reciente gana: se recorre en orden y no se pisa lo ya puesto.
        if (t && !idx.has(t)) idx.set(t, url)
      }
    }
  }
  return idx
}

async function imagenDeNodoPorTitulo(db, projectId, fuente) {
  const nombres = String(fuente || '').split('+').map(s => s.trim()).filter(Boolean)
  if (!nombres.length) return null

  // Solo entre los nodos que este proyecto tiene en el canvas. El catálogo repite títulos —hay un
  // «Pitch Document» archivado con clave 99.2.1 además del 2.1 vivo— y buscar en él a secas
  // devuelve el equivocado, que además nunca produjo nada en este proyecto.
  const { data: pns } = await db()
    .from('forge_project_nodes').select('node_id').eq('project_id', projectId).eq('removed', false)
  const enProyecto = new Set((pns || []).map(p => p.node_id).filter(Boolean))
  const { data: catalogo } = await db().from('forge_nodes').select('id, title, node_key')
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  // Se acepta el TÍTULO o la CLAVE del nodo. La plantilla del deck dice «coming from Pitch
  // Document», pero el `reference_map` que escribe el 3.20 cita «2.1 / pitch_01_hook» — la clave.
  // Reconocer sólo una de las dos formas deja media plataforma sin resolver, y el fallo es mudo:
  // sin nodo no hay imagen, y la página sale con plantilla sin decir por qué.
  const buscarNodo = nombre => (catalogo || []).find(n => enProyecto.has(n.id) &&
    (norm(n.title) === norm(nombre) || String(n.node_key) === String(nombre).trim()))

  for (const crudo of nombres) {
    // «Pitch Document / pitch_01_hook» — el nodo, y QUÉ imagen suya. Sin la segunda parte se
    // resuelve como siempre: la más reciente aprobada del nodo. Con ella, la página ancla en una
    // imagen concreta, que es lo que necesitan las 5 páginas del ASG que citan al Pitch Document:
    // pedir solo el nodo les daba la misma imagen a todas.
    const [nombre, item] = crudo.split('/').map(s => s.trim())
    const nodo = buscarNodo(nombre)
    if (!nodo) continue

    if (item) {
      const idx = await imagenesPorItemDeNodo(db, projectId, nodo.id)
      const url = idx.get(tituloItem(item))
      if (url) return url
      // Y si el ítem no está, NO se cae a «la primera del nodo»: devolver otra imagen sin avisar
      // es peor que no anclar. Sin ancla, el llamador lo reporta y la página sale con plantilla.
      console.warn(`[ref] "${item}" no está entre las imágenes de "${nombre}" (${idx.size} con título)`)
      continue
    }

    // Aprobadas primero, y la más reciente: es la que el usuario dejó como buena.
    const { data: png } = await db()
      .from('forge_assets')
      .select('storage_url, created_at')
      .eq('project_id', projectId).eq('node_id', nodo.id)
      .eq('format', 'png').in('status', ['approved', 'auto_approved'])
      .not('storage_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle()
    if (png?.storage_url) return png.storage_url

    // Sin asset png, las que viven en la sesión: un output de imagen recién corrido todavía no
    // pasó por Accept y aun así sirve como referencia.
    const { data: ses } = await db()
      .from('forge_sessions')
      .select('output_images')
      .eq('project_id', projectId).eq('node_id', nodo.id)
      .not('output_images', 'is', null)
      .order('created_at', { ascending: false })
    for (const s of (ses || [])) {
      for (const items of Object.values(s.output_images || {})) {
        for (const it of (items || [])) {
          const url = it?.variations?.length ? it.variations[it.variations.length - 1]?.url : it?.url
          if (url) return url
        }
      }
    }
  }
  return null
}

// ─── Despacho de un DECK (workflows `per_page`) ───────────────────────────────
// El modelo de arriba —un ítem, una llamada, una imagen— no sirve para los decks del 3.20: su
// workflow no es "una imagen por invocación", son 34 páginas fijas dentro del MISMO grafo, cada
// una con su plantilla y su prompt. Llamarlo 34 veces está mal por construcción; se manda UN
// job con las 34 páginas ya pobladas y las imágenes llegan progresivamente.
//
// Los prompts los arma `composeDeck` desde los documentos del proyecto, no el LLM: son ~6.000
// caracteres por página, y pedirle a un modelo que emita 34 de esos en una respuesta (~200.000
// caracteres) no es viable. El LLM sigue haciendo su trabajo en el nodo; lo que se resuelve por
// código es el poblado, que es determinista y verificable.
//
// Portado de `Moodboard/prueba_guia_completa.js`, que ya corrió 32/32 en 247 s.
async function generateDeck({
  db, project_id, node_id, session_id, node_key, output_key,
  image_gen_model, deck, member_id, onPage, fills = null, solo = null, outDef = null,
  extraPrompt = null,
}) {
  const { composeDeck, DECKS } = require('./slide-composer.service')
  const { getWorkflowByName } = require('./config.service')
  const { uploadToStorage } = require('./storage.service')

  const colonIdx = String(image_gen_model || '').indexOf(':')
  if (colonIdx < 0) throw new Error(`image_gen_model debe ser "provider:workflow" — recibido: "${image_gen_model}"`)
  const provider = image_gen_model.slice(0, colonIdx)
  const wfName   = image_gen_model.slice(colonIdx + 1)
  if (provider !== 'comfyui') throw new Error(`Un deck solo se despacha por comfyui, no por "${provider}"`)

  // El deck se deduce del workflow que declara la DNA: quien llama no tiene por qué saber que
  // `V57_STUDIO_ArtStyleGuide_Template` se llama 'asg' acá adentro.
  deck = deck || Object.entries(DECKS).find(([, c]) => c.workflow === wfName)?.[0]
  if (!deck) throw new Error(`No hay deck registrado para el workflow "${wfName}"`)

  const entry = await getWorkflowByName(wfName)
  if (!entry) throw new Error(`Workflow no registrado: "${wfName}"`)
  if (entry.inject_config?.mode !== 'per_page') {
    throw new Error(`El workflow "${wfName}" no está marcado per_page; no es un deck`)
  }

  // ¿Qué páginas del workflow le tocan a este output? El ASG se parte en 31 de contenido + 3 de
  // síntesis sobre el MISMO workflow, así que sin acotar cada output renderizaría las 34.
  //
  // Tiene que venir declarado en `outDef.pages`. NO se deduce: probamos las dos vías obvias y las
  // dos fallan. Por número, porque el prompt de la síntesis dice «summarise the other 31» y ese
  // 31 se cuela como si fuera una página. Por nombre, porque la pasada A no nombra sus slides
  // —solo da rangos— y la B las llama distinto que el workflow («One-Page Style Summary» contra
  // `26_OnePageSummary`). Adivinar acá cuesta renderizar 34 páginas cuando querías 3.
  if (!solo && outDef?.image_count && outDef.image_count !== entry.inject_config.pages.length) {
    throw new Error(
      `El output "${output_key}" declara ${outDef.image_count} de las ${entry.inject_config.pages.length} ` +
      `páginas del workflow, pero no dice CUÁLES. Hace falta el campo \`pages\` en la DNA del output.`)
  }

  // 1. Poblar: se clona el grafo y se le escribe a cada página su prompt.
  const armado = await composeDeck({ db, projectId: project_id, deck, fills, solo })
  let wf = JSON.parse(JSON.stringify(entry.workflow_json))
  // `extraPrompt` es lo que el usuario ya le pidió a ESTA página y quiere conservar al rehacerla.
  // Va DESPUÉS del prompt compuesto y anunciado: el prompt de la plantilla es el que garantiza que
  // la página siga siendo la página —mismo layout, mismas cajas, misma tipografía— y anteponerle
  // la instrucción del usuario la convertiría en el encargo principal.
  const cola = String(extraPrompt || '').trim()
  for (const p of armado.paginas) {
    if (!wf[p.prompt_node]?.inputs) continue
    wf[p.prompt_node].inputs.prompt = cola
      ? `${p.prompt}

ALREADY-APPLIED DESIGN EDIT — keep it in this render:
${cola}`
      : p.prompt
  }

  // 1a. El nombre del juego. Las 26 páginas del Art Bible abren con un recuadro «FILL IN ONCE ·
  // GAME NAME ▶ [ PASTE THE CURRENT GAME'S TITLE HERE ]» y todo el prompt se refiere después a
  // «the GAME NAME above». Sin rellenarlo, esa instrucción viaja literal al modelo.
  {
    const { data: proyecto } = await db().from('projects').select('name').eq('id', project_id).maybeSingle()
    const titulo = (proyecto?.name || '').trim()
    if (titulo) {
      for (const p of armado.paginas) {
        const n = wf[p.prompt_node]
        if (typeof n?.inputs?.prompt === 'string') {
          n.inputs.prompt = n.inputs.prompt.replace(/\[\s*PASTE THE CURRENT GAME'?S TITLE HERE\s*\]/gi, titulo)
        }
      }
    }
  }

  // 1b. La SEGUNDA imagen de las páginas que la piden.
  //
  // Desde la revisión del 24-ago, algunas páginas reciben dos imágenes: la plantilla y una
  // referencia de estilo. El propio prompt dice de dónde sale esa referencia —«IMAGE 2 = a VISUAL
  // REFERENCE for this page coming from Pitch Document»— y en el workflow viene con una imagen de
  // relleno, un caballero de fantasía que no tiene nada que ver con el juego. Sin reemplazarla, el
  // modelo tomaría ESA como el estilo del proyecto: peor que no darle ninguna referencia.
  //
  // El nodo de origen se resuelve por el nombre que declara el prompt, no por una tabla acá: si
  // mañana una página cambia de fuente, cambia sola.
  const avisosRef = []
  const sinRef    = new Set()
  {
    const conBatch = armado.paginas.filter(p => {
      const gpt = wf[p.prompt_node]
      const src = Object.values(gpt?.inputs || {}).find(v => Array.isArray(v))
      return wf[src?.[0]]?.class_type === 'ImageBatch'
    })

    if (conBatch.length) {
      const { uploadImageToComfyUI } = require('./providers/comfyui.provider')
      const subidas = new Map()   // url del proyecto → nombre ya subido a ComfyUI

      for (const p of conBatch) {
        const gpt   = wf[p.prompt_node]
        const batch = wf[Object.values(gpt.inputs).find(v => Array.isArray(v))[0]]
        // La segunda entrada del batch es la referencia; la primera es la plantilla.
        const refId = Object.values(batch.inputs).map(v => v?.[0])[1]
        if (!wf[refId] || wf[refId].class_type !== 'LoadImage') continue

        // Sin referencia, la página se renderiza SOLO con su plantilla — que es exactamente como
        // se renderizaba antes de que el workflow tuviera batches, así que es un resultado
        // conocido y bueno, no una degradación inventada.
        //
        // Hay que PUENTEAR el batch, no vaciarlo: `ImageBatch` declara `image1` e `image2` como
        // requeridos y no admite opcionales, así que dejarlo con una sola entrada es un grafo
        // inválido. Se reconecta el nodo del modelo directo a la plantilla y el batch queda
        // huérfano; la poda posterior lo descarta.
        const sinAncla = motivo => {
          const plantillaId = Object.values(batch.inputs).map(v => v?.[0])[0]
          const puerto = Object.entries(gpt.inputs).find(([, v]) => Array.isArray(v))?.[0]
          if (plantillaId && puerto) {
            gpt.inputs[puerto] = [String(plantillaId), 0]
            avisosRef.push(`${p.nombre}: ${motivo} — se renderiza solo con la plantilla`)
          } else {
            avisosRef.push(`${p.nombre}: ${motivo}`)
            sinRef.add(p.nombre)
          }
        }

        const fuente = (gpt.inputs.prompt || '').match(/IMAGE 2 = [^\n]*coming from ([^.]+)\./)?.[1] || ''
        const url    = await imagenDeNodoPorTitulo(db, project_id, fuente)
        if (!url) { sinAncla(`sin imagen de «${fuente.trim()}» en el proyecto`); continue }
        try {
          if (!subidas.has(url)) subidas.set(url, await uploadImageToComfyUI(url))
          wf[refId].inputs.image = subidas.get(url)
        } catch (e) {
          sinAncla(`no se pudo subir la referencia (${e.message})`)
        }
      }
      console.log(`[deck] referencias de estilo: ${conBatch.length - sinRef.size}/${conBatch.length} páginas`)
    }

    // 1c. El Art Bible: su ÚNICA entrada es la página ya renderizada del ASG que el prompt cita.
    // No hay plantilla que conservar —el prompt le pide descartar layout, marcos y todo el texto
    // de la referencia y pintar la obra nueva—, así que la imagen embebida en el workflow es un
    // relleno y reemplazarla no es opcional: sin esto el bible se pinta a partir de un ejemplo
    // ajeno al juego.
    const desdeASG = armado.paginas.filter(p => {
      const gpt = wf[p.prompt_node]
      const src = Object.values(gpt?.inputs || {}).find(v => Array.isArray(v))
      return wf[src?.[0]]?.class_type === 'LoadImage' && /Art Style Guide \(ASG/i.test(gpt?.inputs?.prompt || '')
    })

    if (desdeASG.length) {
      const { uploadImageToComfyUI } = require('./providers/comfyui.provider')
      const subidas = new Map()

      for (const p of desdeASG) {
        const gpt    = wf[p.prompt_node]
        const loadId = Object.values(gpt.inputs).find(v => Array.isArray(v))[0]
        const cita   = (gpt.inputs.prompt || '').match(/Art Style Guide \(ASG\s*[·.\-]?\s*(\d{1,2})/i)
        if (!cita) { avisosRef.push(`${p.nombre}: el prompt no dice qué página del ASG usa`); sinRef.add(p.nombre); continue }

        const url = await paginaDelASG(db, project_id, cita[1])
        if (!url) {
          avisosRef.push(`${p.nombre}: la página ${cita[1]} del ASG todavía no está renderizada`)
          sinRef.add(p.nombre)
          continue
        }
        try {
          if (!subidas.has(url)) subidas.set(url, await uploadImageToComfyUI(url))
          wf[loadId].inputs.image = subidas.get(url)
        } catch (e) {
          avisosRef.push(`${p.nombre}: no se pudo subir la página del ASG (${e.message})`)
          sinRef.add(p.nombre)
        }
      }
      console.log(`[deck] páginas del ASG como canon: ${desdeASG.length - sinRef.size}/${desdeASG.length}`)
    }
  }

  // Una página que pide referencia y no la consiguió NO se manda. Dejarla pasar significa
  // renderizarla contra la imagen de relleno del workflow —un caballero de fantasía— y presentar
  // eso como el estilo del juego: sale caro y hay que tirarlo. Mejor falta que equivocada.
  if (sinRef.size) {
    armado.paginas = armado.paginas.filter(p => !sinRef.has(p.nombre))
    armado.avisos  = [...(armado.avisos || []), ...avisosRef]
    console.log(`[deck] ${sinRef.size} página(s) omitidas por falta de referencia: ${[...sinRef].join(', ')}`)
    if (!armado.paginas.length) {
      throw new Error(
        `Ninguna página se puede renderizar: todas piden una imagen de referencia que el proyecto ` +
        `todavía no produjo.\n${avisosRef.join('\n')}`)
    }
  }

  // Con subconjunto hay que PODAR el grafo: si se manda entero, ComfyUI renderiza las 34 páginas
  // aunque solo queramos 31. Se conservan los nodos alcanzables desde los SaveImage elegidos,
  // caminando hacia atrás por los inputs — así sirve igual para el Art Bible, cuyas páginas
  // cuelgan de un ImageBatch con dos LoadImage.
  if (solo) {
    const vivos = new Set()
    const pendientes = armado.paginas.map(p => p.save_node)
    while (pendientes.length) {
      const id = pendientes.pop()
      if (!id || vivos.has(id) || !wf[id]) continue
      vivos.add(id)
      for (const v of Object.values(wf[id].inputs || {})) {
        if (Array.isArray(v) && typeof v[0] === 'string') pendientes.push(v[0])
      }
    }
    wf = Object.fromEntries(Object.entries(wf).filter(([id]) => vivos.has(id)))
  }

  const porSaveNode = Object.fromEntries(armado.paginas.map(p => [p.save_node, p]))

  const BASE = (process.env.COMFYUI_BASE_URL || '').replace(/\/$/, '')
  const KEY  = process.env.COMFYUI_API_KEY
  const H    = () => ({ 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) })

  const t0  = Date.now()
  const res = await fetch(`${BASE}/api/prompt`, {
    method: 'POST', headers: H(),
    body: JSON.stringify({ prompt: wf, ...(KEY ? { extra_data: { api_key_comfy_org: KEY } } : {}) }),
  })
  const txt = await res.text()
  if (!res.ok) throw new Error(`ComfyUI rechazó el deck: ${res.status} ${txt.slice(0, 400)}`)
  const jobId = JSON.parse(txt).prompt_id
  // Sin esto el despacho es invisible en la consola: cuatro minutos sin una línea se ven igual
  // que un proceso muerto, y eso llevó a disparar el mismo render tres veces.
  console.log(`[deck] ${output_key} · ${armado.paginas.length} páginas · job ${jobId} · workflow ${wfName}`)

  // 2. Poll con descarga PROGRESIVA: cada página se sube apenas llega, así una caída a mitad
  //    de camino no pierde lo ya rendido.
  const paginas = []
  const vistos  = new Set()
  const total   = armado.paginas.length
  for (let it = 0; it < 480 && vistos.size < total; it++) {
    await new Promise(r => setTimeout(r, 5000))
    let j = null
    try { j = await (await fetch(`${BASE}/api/jobs/${jobId}`, { headers: H() })).json() } catch { continue }
    const estado = j?.status || j?.execution_status || ''

    for (const [nodeId, nd] of Object.entries(j?.outputs || {})) {
      for (const f of (nd?.images || [])) {
        if (!f.filename || vistos.has(f.filename)) continue
        vistos.add(f.filename)
        const pag = porSaveNode[nodeId]
        const url = `${BASE}/api/view?filename=${encodeURIComponent(f.filename)}` +
                    `&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${f.type || 'output'}`
        try {
          const ir = await fetch(url, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {}, redirect: 'follow' })
          if (!ir.ok) continue
          const buf  = Buffer.from(await ir.arrayBuffer())
          // La ruta lleva el job: sin eso cada render pisa al anterior en R2 y el versionado es
          // mentira — las dos versiones terminan apuntando al mismo archivo y la imagen vieja se
          // pierde. Costó perder el primer render de la página 09 descubrirlo.
          const dest = `projects/${project_id}/deck/${node_key}/${output_key}/${pag?.nombre || f.filename}-${jobId.slice(0, 8)}.png`
          const url2 = await uploadToStorage(buf, dest, 'image/png')
          const item = { index: (pag?.indice ?? paginas.length + 1) - 1, name: pag?.nombre || f.filename, url: url2 }
          paginas.push(item)

          // Se anota en la sesión apenas llega, no al final: es lo que lee el modal del nodo
          // (`forge_sessions.output_images`), y escribirlo progresivamente hace que las páginas
          // aparezcan mientras el deck todavía se está rindiendo. Sin esto el nodo corre, sube
          // las imágenes y en pantalla no se ve nada.
          if (session_id) {
            try {
              await db().from('forge_sessions').update({
                output_images: {
                  [output_key]: [...paginas]
                    .sort((x, y) => x.index - y.index)
                    .map(p => ({ index: p.index, name: p.name, variations: [{ url: p.url, condition: null }] })),
                },
              }).eq('id', session_id)
            } catch (e) { console.error('[deck] no se pudo anotar la página en la sesión:', e.message) }
          }

          console.log(`[deck]   ${String(vistos.size).padStart(2)}/${total}  ${item.name}`)
          onPage?.(item, vistos.size, total)
        } catch (e) { console.error('[deck] página perdida:', e.message) }
      }
    }
    if (/error|fail/i.test(estado) && it > 3) break
    if (/completed|success/i.test(estado) && vistos.size >= total) break
  }

  try {
    logExecution({
      project_id, node_id, session_id,
      triggered_by: member_id || null,
      trigger_type: 'image_gen', executor_type: 'comfyui', provider: 'comfyui', model: wfName,
      is_estimated: true, duration_ms: Date.now() - t0,
      started_at: new Date(t0).toISOString(),
      status: paginas.length === total ? 'success' : 'partial',
      metadata: { output_key, node_key, deck, jobId, paginas: paginas.length, esperadas: total },
    })
  } catch (e) { console.error('[deck] logExec falló (no fatal):', e.message) }

  // Los huecos viajan con el resultado: son lo que hay que ver ANTES de aprobar, no algo que se
  // descubre tres semanas después mirando una página en blanco.
  const huecos = armado.paginas
    .filter(p => p.faltantes.length)
    .map(p => ({ pagina: p.nombre, falta: p.faltantes }))

  console.log(`[deck] ${output_key} · ${paginas.length}/${total} en ${Math.round((Date.now() - t0) / 1000)}s · job ${jobId}`)

  return {
    jobId, paginas, esperadas: total, huecos,
    // Lo que REALMENTE se le mandó a ComfyUI. Es el contenido del prompt set: el output existe
    // para poder auditar qué se pidió, y hasta ahora se lo pedíamos a un modelo que no puede
    // escribirlo. Se emite el que se usó.
    prompts: armado.paginas.map(p => ({ indice: p.indice, nombre: p.nombre, prompt: p.prompt })),
    segundos: Math.round((Date.now() - t0) / 1000), avisos: armado.avisos,
  }
}

module.exports = { imageOutputsOf, parseOutputItems, tieneEntidades, cleanItemText, generateOneImage, generateDeck, esDeck, paginaDelASG, imagenDeNodoPorTitulo }
