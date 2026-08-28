// ─── Preflight: ¿algún documento se quedaría sin sus imágenes? ────────────────
// Tres veces arreglamos esto por el síntoma —un PDF sin imágenes— y cada vez la causa fue la
// misma forma de error: las imágenes EXISTEN y el resolvedor no las ve, porque están en una
// sesión distinta de la que mira. Esto lo comprueba de una vez, para cada instancia y cada modo.
//
// Compara, por output que pueda llevar imágenes:
//   · cuántas hay guardadas para esa instancia del nodo (en cualquier sesión, general o por output)
//   · cuántas encuentra `resolverImagenesDeItems`, que es lo que ve el PDF
// Un output con imágenes guardadas y 0 resueltas es el fallo que buscamos.
//
// Uso:  node scripts/preflight-images.js [project_id]      (sin id: todos los proyectos)
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { resolverImagenesDeItems } = require('../src/services/canvas-chat.service')

const PROY = process.argv[2] || null
const P = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }

;(async () => {
  let q = db().from('forge_project_nodes')
    .select('id, project_id, node_id, forge_nodes(node_key, title, outputs)')
    .eq('removed', false).eq('node_type', 'forge_node')
  if (PROY) q = q.eq('project_id', PROY)
  const { data: pns } = await q

  const filas = []
  for (const pn of pns || []) {
    const outs = P(pn.forge_nodes?.outputs) || []
    if (!outs.length) continue

    // Outputs que PUEDEN llevar imágenes: los que las generan, y los DOCUMENTOS que declaran un
    // hermano que las genera. El formato importa: `2.1/elevator_line` declara al pitch_document
    // como hermano pero es una frase —nadie le pide un PDF—, y contarlo solo mete ruido.
    const ESDOC = f => ['docx', 'pdf', 'markdown', 'md', 'document', 'pptx'].includes(String(f || '').toLowerCase())
    const conImagen = outs.filter(o => {
      if (o.image_gen === true) return true
      if (!ESDOC(o.format)) return false
      const herm = o.uses?.siblings_if_present ?? o.uses?.siblings ?? []
      return herm.some(k => outs.find(x => (x.key || x.name) === k)?.image_gen === true)
    })
    if (!conImagen.length) continue

    const { data: ss } = await db().from('forge_sessions')
      .select('id, output_key, status, output_images').eq('project_node_id', pn.id)
    if (!ss?.length) continue

    // Todo lo guardado para esta instancia, por clave de output
    const guardadas = {}
    for (const s of ss) {
      for (const [k, v] of Object.entries(s.output_images || {})) {
        guardadas[k] = (guardadas[k] || 0) + (Array.isArray(v) ? v.filter(i => i?.variations?.length || i?.url).length : 0)
      }
    }
    if (!Object.values(guardadas).some(n => n > 0)) continue

    const gen = ss.find(s => !s.output_key)
    for (const o of conImagen) {
      const clave = o.key || o.name
      const herm = (o.uses?.siblings_if_present ?? o.uses?.siblings ?? [])
        .filter(k => outs.find(x => (x.key || x.name) === k)?.image_gen === true)
      const disponibles = (guardadas[clave] || 0) + herm.reduce((n, k) => n + (guardadas[k] || 0), 0)
      if (!disponibles) continue

      // El contenido que vería el PDF: la sesión del output si existe, si no la general
      const propia = ss.find(s => s.output_key === clave) || gen
      if (!propia) continue
      const { data: ms } = await db().from('forge_messages').select('role, content')
        .eq('session_id', propia.id).order('created_at', { ascending: false }).limit(4)
      const contenido = (ms || []).find(m => m.role === 'agent')?.content || ''
      if (!contenido) continue

      let resueltas = 0
      try {
        resueltas = (await resolverImagenesDeItems({
          db, projectId: pn.project_id, nodeId: pn.node_id, sessionId: propia.id, outKey: clave, contenido,
        })).length
      } catch (e) { resueltas = -1 }

      filas.push({
        nodo: pn.forge_nodes.node_key, clave, pn: pn.id.slice(0, 8),
        modo: propia.output_key ? 'por output' : 'nodo entero',
        disponibles, resueltas,
      })
    }
  }

  const malas = filas.filter(f => f.resueltas === 0 || f.resueltas === -1)
  console.log(`outputs con imágenes guardadas: ${filas.length}\n`)
  console.log('nodo   output                 modo          guardadas  resueltas')
  for (const f of filas.sort((a, b) => a.nodo.localeCompare(b.nodo, undefined, { numeric: true }))) {
    const señal = f.resueltas === 0 ? ' ✗ el PDF saldría sin imágenes' : f.resueltas === -1 ? ' ✗ el resolvedor falló' : ''
    console.log(`${f.nodo.padEnd(6)} ${f.clave.padEnd(22)} ${f.modo.padEnd(13)} ${String(f.disponibles).padStart(9)}  ${String(f.resueltas).padStart(9)}${señal}`)
  }
  console.log(`\n${malas.length ? '✗ ' + malas.length + ' output(s) perderían sus imágenes' : '✔ ninguno pierde sus imágenes'}`)
  process.exit(malas.length ? 1 : 0)
})()
