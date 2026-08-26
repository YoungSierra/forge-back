// ─── Registra los workflows de la cadena Character Sheet (§10) ───────────────
//
// Los tres pasos que define el documento de menús radiales. El primero ya estaba registrado como
// `V57_STUDIO_Moodboard_Iteration`; acá entran los dos que faltaban.
//
// El `inject_config` de siempre asume UN prompt, UN tamaño y UNA semilla. Estos no: el de Concept
// Art tiene cuatro nodos `OpenAIGPTImage1`, cada uno con su prompt escrito adentro y su semilla, y
// el de 3D recibe TRES imágenes distintas. Por eso todo va por `extra`, que es el mecanismo que ya
// usa `character-creator` para sus dos referencias.
//
// Los prompts NO se inyectan: son parte del workflow, no del pedido. El único paso que recibe texto
// del usuario es el 1, que ya está registrado.
//
// Uso:  node scripts/register-character-chain.js [--apply]

require('dotenv').config()
const fs   = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APPLY = process.argv.includes('--apply')
const DIR   = path.join(__dirname, '..', '..', 'P-25082026')

const PLAN = [
  {
    // El paso 1 ya estaba registrado y corriendo, pero SIN mapa de salidas: su única imagen queda
    // con el número de nodo como rol («28»). Funciona —el paso 2 pide `*`— pero etiqueta el activo
    // con un número que no le dice nada a quien lo lea después.
    //
    // `solo_salidas`: se le AGREGA el mapa y no se toca nada más. Reescribirle el workflow_json con
    // el archivo de la carpeta sería pisar lo que hoy funciona con una copia que nadie verificó que
    // sea la misma — el error que revirtió el 3.9 en su momento.
    solo_salidas: true,
    name: 'V57_STUDIO_Moodboard_Iteration',
    file: 'V57_STUDIO_Vertical Slice_Moodboard Iteration.json',
    description: 'Paso 1 de la cadena Character Sheet: aplica sobre la página el ajuste de diseño pedido.',
    inject_config: null,
    salidas: { '28': 'edited' },
  },
  {
    name: 'V57_STUDIO_ConceptArt_Characters',
    file: 'V57_STUDIO_Vertical Slice_Concept Art_Characters.json',
    description: 'Paso 2 de la cadena Character Sheet: de la hoja oficial a master + tres vistas (front, side_left, back).',
    inject_config: {
      // La semilla del maestro. Las de las vistas se pisan aparte para que un re-run no repita.
      seed: { node: '268', field: 'seed' },
      extra: {
        image:      { node: '272', type: 'image', field: 'image' },
        seed_front: { node: '281', type: 'int',   field: 'seed'  },
        seed_left:  { node: '283', type: 'int',   field: 'seed'  },
        seed_back:  { node: '286', type: 'int',   field: 'seed'  },
      },
    },
    // Qué nodo SaveImage produce qué. El paso 3 pide las vistas por rol, no por posición.
    salidas: { '269': 'master', '282': 'front', '284': 'left', '287': 'back' },
  },
  {
    name: 'V57_STUDIO_3D_Production_Characters',
    file: 'V57_STUDIO_Vertical Slice_3D Production_Characters.json',
    description: 'Paso 3 de la cadena Character Sheet: las tres vistas entran a Tripo y sale el .glb texturizado.',
    inject_config: {
      seed: { node: '46', field: 'model_seed' },
      extra: {
        image:      { node: '45', type: 'image', field: 'image' },
        image_left: { node: '47', type: 'image', field: 'image' },
        image_back: { node: '48', type: 'image', field: 'image' },
      },
    },
    salidas: { '32': 'glb' },
  },
]

;(async () => {
  for (const p of PLAN) {
    const ruta = path.join(DIR, p.file)
    if (!fs.existsSync(ruta)) { console.error('ABORTA: no existe', ruta); process.exit(1) }
    const wf = JSON.parse(fs.readFileSync(ruta, 'utf-8'))

    // Se verifica que cada punto de inyección exista de verdad en el JSON. Un punto que apunta a
    // un nodo inexistente no falla: `injectPoint` avisa por consola y sigue, así que el workflow
    // correría con la imagen de ejemplo que trae adentro y nadie se enteraría.
    const puntos = p.inject_config ? [p.inject_config.seed, ...Object.values(p.inject_config.extra || {})] : []
    for (const pt of puntos) {
      if (!wf[pt.node]) { console.error(`ABORTA: ${p.name} — el nodo "${pt.node}" no está en el JSON`); process.exit(1) }
      if (!(pt.field in (wf[pt.node].inputs || {}))) {
        console.error(`ABORTA: ${p.name} — el nodo "${pt.node}" (${wf[pt.node].class_type}) no tiene el campo "${pt.field}"`)
        process.exit(1)
      }
    }
    for (const nodo of Object.keys(p.salidas)) {
      if (!wf[nodo]) { console.error(`ABORTA: ${p.name} — la salida "${nodo}" no está en el JSON`); process.exit(1) }
    }

    // `inject_config` viene en el select porque el modo `solo_salidas` lo SUPERPONE: sin leerlo,
    // el update lo dejaría con solo el mapa de salidas y el workflow perdería sus puntos de
    // inyección — el paso 1 correría con la imagen de ejemplo que trae adentro.
    const { data: ya } = await db().from('comfyui_workflows').select('id, inject_config').eq('name', p.name).maybeSingle()
    if (p.solo_salidas && !ya) { console.error(`ABORTA: ${p.name} tenía que existir ya y no está`); process.exit(1) }
    console.log(`\n### ${p.name}  (${Object.keys(wf).length} nodos)  ${p.solo_salidas ? '→ SOLO AGREGA SALIDAS' : ya ? '→ ACTUALIZA' : '→ CREA'}`)
    console.log('    ', p.description)
    for (const [n, rol] of Object.entries(p.salidas)) console.log(`     salida  [${n}] ${wf[n].class_type}  → ${rol}`)
    for (const [k, pt] of Object.entries(p.inject_config?.extra || {})) console.log(`     entrada ${k.padEnd(11)} → [${pt.node}] ${wf[pt.node].class_type}.${pt.field}`)

    if (!APPLY) continue

    // Superponer sobre la fila viva, nunca reemplazarla entera.
    const fila = p.solo_salidas
      ? { inject_config: { ...(ya.inject_config || {}), salidas: p.salidas } }
      : { name: p.name, description: p.description, workflow_json: wf,
          inject_config: { ...p.inject_config, salidas: p.salidas }, is_active: true }
    const r = ya
      ? await db().from('comfyui_workflows').update(fila).eq('id', ya.id)
      : await db().from('comfyui_workflows').insert(fila)
    if (r.error) { console.error('ERR', p.name, r.error.message); process.exit(1) }
    console.log('     ✔ escrito')
  }
  console.log(APPLY ? '\n✔ aplicado' : '\n→ correr con --apply')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
