// Borra los cables cuyo extremo ya no existe en el proyecto.
//
// Al quitar un nodo del canvas su fila se va, pero los cables que salían de él pueden quedarse
// apuntando al vacío. No rompen nada —el canvas los descarta al dibujar— pero el front avisa en
// cada repintado, así que la consola se llena de un aviso que es correcto y no se puede atender
// desde la interfaz. La causa está en la base; se arregla en la base.
//
// El aviso NO se toca: sirve para distinguir «el cable se descartó porque le falta un extremo» de
// «el cable se dibujó oculto porque cruza un lane», que en pantalla se ven igual.
//
// Uso:  node scripts/limpiar-cables-huerfanos.js <project_id>            (simula)
//       node scripts/limpiar-cables-huerfanos.js <project_id> --apply
//       node scripts/limpiar-cables-huerfanos.js --todos                 (audita todos)
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const APLICAR = process.argv.includes('--apply')
const TODOS = process.argv.includes('--todos')
const PROY = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null
if (!PROY && !TODOS) { console.error('uso: <project_id> [--apply]  |  --todos'); process.exit(1) }

;(async () => {
  let proyectos = [PROY]
  if (TODOS) {
    const { data } = await db().from('projects').select('id,name').order('created_at')
    proyectos = (data || []).map(p => p.id)
  }

  const aBorrar = []
  for (const pid of proyectos) {
    const { data: pns } = await db().from('forge_project_nodes').select('id,removed').eq('project_id', pid)
    // Un nodo `removed` sigue en la tabla pero fuera del canvas: sus cables también son huérfanos.
    const vivos = new Set((pns || []).filter(p => !p.removed).map(p => p.id))
    const { data: eds } = await db().from('forge_project_edges')
      .select('id,source_node_id,target_node_id').eq('project_id', pid)
    const huer = (eds || []).filter(e => !vivos.has(e.source_node_id) || !vivos.has(e.target_node_id))
    if (!huer.length) continue
    const { data: p } = await db().from('projects').select('name').eq('id', pid).maybeSingle()
    console.log(`${(p?.name || pid).slice(0, 34).padEnd(36)} ${String((eds || []).length).padStart(3)} cables · ${huer.length} huérfano(s)`)
    for (const h of huer) {
      const falta = [!vivos.has(h.source_node_id) && 'origen', !vivos.has(h.target_node_id) && 'destino'].filter(Boolean).join(' y ')
      console.log(`     ${h.id.slice(0, 8)} — le falta el ${falta}`)
      aBorrar.push(h.id)
    }
  }

  console.log(`\ntotal a borrar: ${aBorrar.length}`)
  if (!aBorrar.length) return
  if (!APLICAR) return console.log('(simulación — usar --apply para borrar)')

  const { error } = await db().from('forge_project_edges').delete().in('id', aBorrar)
  if (error) { console.error('fallo:', error.message); process.exit(1) }

  // Relectura: que no quede ninguno de los que dijimos que íbamos a borrar.
  const { data: quedan } = await db().from('forge_project_edges').select('id').in('id', aBorrar)
  console.log(`\n=== verificación ===\n  borrados: ${aBorrar.length - (quedan || []).length} de ${aBorrar.length}`)
})()
