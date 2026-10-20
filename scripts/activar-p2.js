// ─── Activa Tripo P2 en los tres pasos de 3D (props, personajes, entornos) ──────
//
// W43 #7 de Miguel León, OK de Young el 20-10. Dos cambios por workflow, además de encenderlo:
//   · `model.quad` a false. Con quad Tripo entrega SOLO FBX y la salida GLB que guardan estos grafos
//     queda vacía: ComfyUI aborta la corrida (falló así la prueba del 19-10).
//   · `oculta: ['quad']`, para que el diálogo de Run no lo ofrezca. La malla en quads está en
//     Edit 3D → Retopo, que sí sabe guardar el FBX.
//
// Ojo con a quién le toca: `workflowDelProyecto` da P2 a los proyectos creados DESPUÉS del registro
// del sucesor (01-10). Encenderlo los pasa a P2 en su próximo 3D; lo ya generado no se toca.
//
// Uso:  node scripts/activar-p2.js [--apply]
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const APPLY = process.argv.includes('--apply')
const NOMBRES = ['V57_STUDIO_3D_Production_Props_P2', 'V57_STUDIO_3D_Production_Characters_P2', 'V57_STUDIO_3D_Production_Environment_P2']

;(async () => {
  for (const name of NOMBRES) {
    const { data: w, error } = await db().from('comfyui_workflows').select('id, is_active, workflow_json, inject_config').eq('name', name).single()
    if (error || !w) { console.error('ABORTA: no está', name); process.exit(1) }
    const g = w.workflow_json
    const nodos = Object.entries(g).filter(([, n]) => /^TripoPSeries/.test(n.class_type))
    if (!nodos.length) { console.error('ABORTA: sin nodo de la serie P en', name); process.exit(1) }
    for (const [, n] of nodos) n.inputs['model.quad'] = false
    const inject = { ...(w.inject_config || {}), oculta: [...new Set([...(w.inject_config?.oculta || []), 'quad'])] }
    console.log(`${name}: activo ${w.is_active} → true · quad → false en ${nodos.map(([k]) => k).join(', ')} · oculta ${JSON.stringify(inject.oculta)}`)
    if (!APPLY) continue
    const r = await db().from('comfyui_workflows').update({ workflow_json: g, inject_config: inject, is_active: true }).eq('id', w.id)
    if (r.error) { console.error('ERR', name, r.error.message); process.exit(1) }
  }
  console.log(APPLY ? '✔ aplicado' : '→ correr con --apply')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
