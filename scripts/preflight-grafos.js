// Comprueba cada workflow registrado CONTRA EL CATÁLOGO VIVO de ComfyUI, en frío y sin gastar.
//
// POR QUÉ: ComfyUI no tiene forma de validar un grafo sin ejecutarlo —probados el 01-10,
// `/api/validate_prompt`, `/api/prompt/validate` y `/api/dry_run` devuelven 404—, así que entre
// registrar un workflow y confiar en él hay una corrida pagada de por medio. Esto adelanta todo lo
// que SÍ se puede saber antes de pagar:
//
//   · que cada `class_type` exista en el ComfyUI de hoy;
//   · que cada campo escrito exista en esa clase —incluidos los que cuelgan de un combo dinámico,
//     que es donde viven los ajustes de Tripo y de los nodos de imagen nuevos—;
//   · que cada valor de un desplegable esté entre los admitidos;
//   · que cada enlace apunte a un nodo que existe y a una RANURA que existe;
//   · que el `inject_config` apunte a nodos y campos reales.
//
// Lo que NO puede saber: si el resultado es bueno. Eso solo lo dice una corrida.
//
// Nació el 01-10 con la migración de Tripo P1 a la serie P: ahí el `.glb` se mueve de la ranura 2
// a la 1, y un enlace por índice que no se remapee no da error — el paso siguiente recoge otra
// cosa y nadie se entera hasta mirar el modelo.
//
// Uso:  node scripts/preflight-grafos.js [nombre-del-workflow]
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const BASE = () => (process.env.COMFYUI_BASE_URL || '').replace(/\/$/, '')
const KEY = () => process.env.COMFYUI_API_KEY

/**
 * La declaración de un campo, siguiendo los combos dinámicos hacia adentro.
 *
 * `entradas` son las del PROPIO nodo, y hacen falta para saber por qué rama bajar: el combo
 * `format` de `SaveAudioAdvanced` declara `quality` distinto en mp3 (`V0, 128k, 320k`) y en opus
 * (`64k … 320k`). Mezclando las ramas, un `V0` perfectamente válido se leía como inválido porque
 * se comparaba contra la lista de opus. Se baja por la rama que el nodo tiene elegida.
 */
function declaracionDe(declarados, ruta, entradas = {}) {
  let nivel = declarados, def = null, recorrido = []
  for (const parte of ruta.split('.')) {
    def = nivel?.[parte]
    if (!def) return null
    recorrido.push(parte)
    const opts = def[1]?.options
    if (Array.isArray(opts) && opts.length && typeof opts[0] === 'object') {
      const elegida = entradas[recorrido.join('.')]
      const rama = opts.find(o => o.key === elegida)
      const fuentes = rama ? [rama] : opts        // sin rama elegida se admite cualquiera
      const hijos = {}
      for (const r of fuentes) Object.assign(hijos, r.inputs?.required || {}, r.inputs?.optional || {})
      nivel = hijos
    } else nivel = null
  }
  return def
}

;(async () => {
  const soloEste = process.argv.find(a => !a.startsWith('-') && !/node(\.exe)?$/.test(a) && !a.endsWith('preflight-grafos.js')) || null
  const verAvisos = process.argv.includes('--avisos')
  let totalAvisos = 0

  const r = await fetch(`${BASE()}/api/object_info`, { headers: { Authorization: `Bearer ${KEY()}` } })
  if (!r.ok) { console.error(`object_info: ${r.status}`); process.exit(1) }
  const oi = await r.json()
  console.log(`catálogo de ComfyUI: ${Object.keys(oi).length} clases\n`)

  let q = db().from('comfyui_workflows').select('name, workflow_json, inject_config, is_active').order('name')
  if (soloEste) q = q.eq('name', soloEste)
  const { data: wfs, error } = await q
  if (error) throw error

  const problemas = []
  for (const w of wfs) {
    const wf = w.workflow_json || {}
    const cfg = typeof w.inject_config === 'string' ? JSON.parse(w.inject_config) : w.inject_config
    const malos = []     // rompen de verdad
    const avisos = []    // no impiden correr, pero conviene verlos

    for (const [id, n] of Object.entries(wf)) {
      const clase = oi[n.class_type]
      if (!clase) { malos.push(`#${id}: la clase «${n.class_type}» no existe en ComfyUI`); continue }
      const declarados = { ...(clase.input?.required || {}), ...(clase.input?.optional || {}) }

      for (const [campo, valor] of Object.entries(n.inputs || {})) {
        // Un enlace: tiene que apuntar a un nodo que existe y a una ranura que existe.
        if (Array.isArray(valor)) {
          const destino = wf[valor[0]]
          if (!destino) { malos.push(`#${id}.${campo} apunta al nodo #${valor[0]}, que no está en el grafo`); continue }
          const salidas = oi[destino.class_type]?.output || []
          if (salidas.length && valor[1] >= salidas.length) {
            malos.push(`#${id}.${campo} pide la ranura ${valor[1]} de #${valor[0]} (${destino.class_type}), que solo tiene ${salidas.length}`)
          }
          continue
        }
        const def = declaracionDe(declarados, campo, n.inputs)
        if (!def) {
          // Un campo que el esquema no declara NO impide correr: los exports de la interfaz dejan
          // restos —`SaveGLB` arrastra un `image: ""`— y ComfyUI los ignora. Comprobado en
          // workflows que corren hoy. Se avisa para poder limpiarlos, no se trata como fallo.
          avisos.push(`#${id}: «${campo}» no está en el esquema de ${n.class_type} (ComfyUI lo ignora)`)
          continue
        }
        // Un desplegable con valor fuera de su lista: ComfyUI lo rechaza al despachar, o sea al pagar.
        const opts = def[1]?.options
        if (Array.isArray(opts) && opts.length && typeof opts[0] !== 'object' && !opts.includes(valor)) {
          malos.push(`#${id}.${campo} = ${JSON.stringify(valor)} no está entre ${JSON.stringify(opts)}`)
        }
      }
    }

    // El `inject_config`: si apunta a un nodo o a un campo que ya no existe, el motor escribe en la
    // nada y el grafo sale con el valor de muestra del autor.
    const apunta = []
    if (cfg?.seed?.node) apunta.push(['seed', cfg.seed.node, cfg.seed.field])
    if (cfg?.image?.node) apunta.push(['image', cfg.image.node, cfg.image.field])
    for (const [k, e] of Object.entries(cfg?.extra || {})) if (e?.node) apunta.push([`extra.${k}`, e.node, e.field])
    for (const p of (cfg?.pages || [])) {
      if (p.prompt_node) apunta.push([`page ${p.name}`, p.prompt_node, p.prompt_field || 'prompt'])
      if (p.save_node) apunta.push([`page ${p.name} save`, p.save_node, null])
    }
    for (const [etq, nodo, campo] of apunta) {
      const n = wf[nodo]
      if (!n) { malos.push(`inject_config.${etq} apunta al nodo #${nodo}, que no está en el grafo`); continue }
      if (!campo) continue
      const clase = oi[n.class_type]
      if (!clase) continue
      const declarados = { ...(clase.input?.required || {}), ...(clase.input?.optional || {}) }
      if (!declaracionDe(declarados, campo, n.inputs)) {
        malos.push(`inject_config.${etq} escribe «${campo}» en #${nodo} (${n.class_type}), que no lo declara`)
      }
    }
    for (const nodo of Object.keys(cfg?.salidas || {})) {
      if (!wf[nodo]) malos.push(`inject_config.salidas nombra el nodo #${nodo}, que no está en el grafo`)
    }

    const marca = malos.length ? '✗' : avisos.length ? '~' : '✓'
    console.log(`  ${marca} ${w.name.padEnd(44)} ${Object.keys(wf).length} nodos`
      + `${avisos.length ? `  ${avisos.length} aviso(s)` : ''}${w.is_active === false ? '  (inactivo)' : ''}`)
    malos.slice(0, 6).forEach(m => console.log(`       ✗ ${m}`))
    if (malos.length > 6) console.log(`       … y ${malos.length - 6} más`)
    if (verAvisos) avisos.slice(0, 4).forEach(m => console.log(`       · ${m}`))
    problemas.push(...malos.map(m => `${w.name}: ${m}`))
    totalAvisos += avisos.length
  }

  console.log(`
${wfs.length} workflow(s) · ${problemas.length} problema(s) · ${totalAvisos} aviso(s)` + `${totalAvisos && !verAvisos ? ' — con --avisos se listan' : ''}`)
  if (problemas.length) process.exit(1)
  console.log('todos los grafos casan con el catálogo vivo ✓')
})().catch(e => { console.error(e); process.exit(1) })
