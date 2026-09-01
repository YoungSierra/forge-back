// Deja un nodo de un proyecto como si nunca se hubiera corrido: borra sus sesiones, sus mensajes
// y sus assets. NO toca la DNA ni los cables, solo lo producido.
//
// Las imágenes en R2 no se borran: cuestan lo mismo estén o no, y borrarlas rompería cualquier
// documento viejo que las enlace. Lo que se va son las filas que hacen que el canvas las muestre.
//
// Uso:  node scripts/limpiar-nodo.js <node_key> <project_id>            (simula)
//       node scripts/limpiar-nodo.js <node_key> <project_id> --apply
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const CLAVE   = process.argv[2]
const PROY    = process.argv[3]
const APLICAR = process.argv.includes('--apply')
if (!CLAVE || !PROY) { console.error('uso: <node_key> <project_id> [--apply]'); process.exit(1) }

;(async () => {
  const { data: n } = await db().from('forge_nodes').select('id,title').eq('node_key', CLAVE).single()
  const { data: p } = await db().from('projects').select('name').eq('id', PROY).single()
  console.log(`${CLAVE} ${n.title} · proyecto ${p.name}\n`)

  const { data: ss } = await db().from('forge_sessions')
    .select('id,output_key,status,created_at').eq('project_id', PROY).eq('node_id', n.id).order('created_at')
  const ids = (ss || []).map(s => s.id)

  const { data: ms } = ids.length
    ? await db().from('forge_messages').select('id,session_id').in('session_id', ids)
    : { data: [] }
  const { data: as } = await db().from('forge_assets')
    .select('id,name,format,storage_url').eq('project_id', PROY).eq('node_id', n.id)

  console.log(`sesiones: ${(ss || []).length}`)
  for (const s of ss || []) console.log(`   ${s.created_at.slice(11, 19)} ${(s.output_key ?? 'general').padEnd(18)} ${s.status}`)
  console.log(`mensajes: ${(ms || []).length}`)
  console.log(`assets:   ${(as || []).length}${(as || []).length ? ' → ' + (as || []).map(a => a.format).join(', ') : ''}`)
  const conUrl = (as || []).filter(a => a.storage_url).length
  console.log(`   de esos, con archivo en R2: ${conUrl} (el archivo se queda; se va la fila)`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para borrar)')

  // Orden: primero lo que apunta a otra cosa. Un asset referenciado por `output_asset_id` bloquea
  // el borrado de su sesión, y un mensaje huérfano queda invisible pero presente.
  await db().from('forge_sessions').update({ output_asset_id: null }).in('id', ids.length ? ids : ['-'])
  if ((as || []).length) await db().from('forge_assets').delete().eq('project_id', PROY).eq('node_id', n.id)
  if ((ms || []).length) await db().from('forge_messages').delete().in('session_id', ids)
  if (ids.length)        await db().from('forge_sessions').delete().in('id', ids)

  // El nodo vuelve a estar «sin correr»: sin la marca, el canvas lo pinta desactualizado en vez
  // de listo para correr.
  await db().from('forge_project_nodes').update({ is_stale: false })
    .eq('project_id', PROY).eq('node_id', n.id)

  const { count: cs } = await db().from('forge_sessions').select('*', { count: 'exact', head: true }).eq('project_id', PROY).eq('node_id', n.id)
  const { count: ca } = await db().from('forge_assets').select('*', { count: 'exact', head: true }).eq('project_id', PROY).eq('node_id', n.id)
  console.log(`\n=== verificación ===\n  sesiones que quedan: ${cs} · assets que quedan: ${ca}`)
})()
