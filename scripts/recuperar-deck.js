// Rescata un deck que ComfyUI YA renderizó pero que el motor no llegó a guardar.
//
// Las páginas se bajan de ComfyUI y se suben a R2 dentro del poll. Si el proceso muere en esa
// ventana —un reinicio de nodemon, por ejemplo: vigila TODO el directorio, así que cualquier
// archivo que se toque durante una corrida la mata— el trabajo queda completo del lado de
// ComfyUI y la sesión se queda en `active` con cero imágenes para siempre. Nadie lo reintenta.
//
// Volver a correr el nodo re-renderiza y se paga otra vez. Esto no: las imágenes ya existen en el
// trabajo, solo hay que bajarlas. Medido el 01-09 en el 3.20: 31 páginas rendidas en 121s,
// perdidas por un reinicio, recuperadas sin costo.
//
// Uso:  node scripts/recuperar-deck.js <session_id> [job_id]        (simula)
//       node scripts/recuperar-deck.js <session_id> [job_id] --apply
//
// Sin `job_id` se toma el trabajo COMPLETADO más reciente de ComfyUI cuyo número de salidas
// coincida con lo que el output espera.
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { uploadToStorage } = require('../src/services/storage.service')
const { composeDeck } = require('../src/services/slide-composer.service')

const SES = process.argv[2]
const JOB = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null
const APLICAR = process.argv.includes('--apply')
if (!SES) { console.error('uso: <session_id> [job_id] [--apply]'); process.exit(1) }

const BASE = (process.env.COMFYUI_BASE_URL || '').replace(/\/$/, '')
const KEY  = process.env.COMFYUI_API_KEY
const H    = () => (KEY ? { Authorization: `Bearer ${KEY}` } : {})

;(async () => {
  const { data: s } = await db().from('forge_sessions')
    .select('id,project_id,node_id,output_key,status,output_images').eq('id', SES).single()
  if (!s) { console.error('sesión no encontrada'); process.exit(1) }
  const { data: dna } = await db().from('forge_nodes').select('node_key,title,outputs').eq('id', s.node_id).single()
  const def = (dna.outputs || []).find(o => (o.key || o.name) === s.output_key)
  if (!def) { console.error(`el output "${s.output_key}" no está en la DNA de ${dna.node_key}`); process.exit(1) }

  const yaTiene = Object.values(s.output_images || {}).flat().reduce((a, it) => a + (it.variations || []).length, 0)
  console.log(`${dna.node_key} ${dna.title} · ${s.output_key}`)
  console.log(`sesión ${s.id.slice(0, 8)} · estado=${s.status} · imágenes ya guardadas=${yaTiene}`)
  if (yaTiene) { console.error('\nesta sesión YA tiene imágenes: no se toca.'); process.exit(1) }

  // El mapa nodo-de-salida → página sale del mismo compositor que usó el despacho, con el mismo
  // `solo`: sin él las páginas se numerarían como si fueran las 34.
  const solo = Array.isArray(def.pages) && def.pages.length ? def.pages : null
  const armado = await composeDeck({ db, projectId: s.project_id, deck: 'asg', fills: null, solo })
  const porSaveNode = Object.fromEntries(armado.paginas.map(p => [p.save_node, p]))
  console.log(`páginas que espera el output: ${armado.paginas.length}`)

  // El trabajo
  let jobId = JOB
  if (!jobId) {
    const j = await (await fetch(`${BASE}/api/jobs`, { headers: H() })).json()
    const cand = (j.jobs || []).filter(t => /completed|success/i.test(t.status || t.execution_status || '')
      && t.outputs_count === armado.paginas.length)
    if (!cand.length) { console.error(`no hay trabajo completado con ${armado.paginas.length} salidas`); process.exit(1) }
    jobId = cand[0].id
    console.log(`trabajo elegido: ${jobId} (${cand.length} candidato(s), se toma el más reciente)`)
  }

  const job = await (await fetch(`${BASE}/api/jobs/${jobId}`, { headers: H() })).json()
  const salidas = []
  for (const [nodeId, nd] of Object.entries(job?.outputs || {})) {
    for (const f of (nd?.images || [])) if (f.filename) salidas.push({ nodeId, f })
  }
  console.log(`imágenes en el trabajo: ${salidas.length}`)

  const sinPagina = salidas.filter(x => !porSaveNode[x.nodeId]).length
  if (sinPagina) console.log(`  ¡ojo! ${sinPagina} salida(s) sin página conocida — se nombran por su archivo`)
  if (salidas.length !== armado.paginas.length) {
    console.log(`  ¡ojo! el trabajo trae ${salidas.length} y el output espera ${armado.paginas.length}`)
  }

  if (!APLICAR) return console.log('\n(simulación — usar --apply para bajar y guardar)')

  const paginas = []
  for (const { nodeId, f } of salidas) {
    const pag = porSaveNode[nodeId]
    const url = `${BASE}/api/view?filename=${encodeURIComponent(f.filename)}`
              + `&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${f.type || 'output'}`
    try {
      const ir = await fetch(url, { headers: H(), redirect: 'follow' })
      if (!ir.ok) { console.error(`  ${f.filename}: ComfyUI devolvió ${ir.status}`); continue }
      const buf = Buffer.from(await ir.arrayBuffer())
      // MISMA ruta que el despacho, con el job adentro: sin él cada render pisa al anterior.
      const dest = `projects/${s.project_id}/deck/${dna.node_key}/${s.output_key}/${pag?.nombre || f.filename}-${String(jobId).slice(0, 8)}.png`
      const url2 = await uploadToStorage(buf, dest, 'image/png')
      const item = { index: (pag?.indice ?? paginas.length + 1) - 1, name: pag?.nombre || f.filename, url: url2 }
      paginas.push(item)
      // Progresivo, igual que el poll: si esto se corta a la mitad, lo bajado no se pierde.
      await db().from('forge_sessions').update({
        output_images: {
          [s.output_key]: [...paginas].sort((x, y) => x.index - y.index)
            .map(p => ({ index: p.index, name: p.name, variations: [{ url: p.url, condition: null }] })),
        },
      }).eq('id', s.id)
      console.log(`  ${String(paginas.length).padStart(2)}/${salidas.length}  ${item.name}`)
    } catch (e) { console.error(`  ${f.filename}: ${e.message}`) }
  }

  // Una fila de asset por página, con el mismo nombre que pone el motor.
  let primero = null
  for (const p of [...paginas].sort((a, b) => a.index - b.index)) {
    const { data: a } = await db().from('forge_assets').insert({
      node_id: s.node_id, project_id: s.project_id, session_id: s.id,
      name: `${dna.title} — ${p.name}`, format: 'png', status: 'approved',
      storage_url: p.url, approved_at: new Date().toISOString(),
    }).select('id').single()
    if (!primero) primero = a?.id || null
  }

  await db().from('forge_messages').insert({
    session_id: s.id, role: 'agent', order_index: 1, tool_calls: [],
    content: `Recovered **${paginas.length}/${armado.paginas.length}** pages from job \`${jobId}\`.`
      + ' The render had completed on ComfyUI; the engine was interrupted before it could save them.'
      + ' Nothing was re-rendered.',
  })

  await db().from('forge_sessions').update({
    status: paginas.length === armado.paginas.length ? 'auto_approved' : 'active',
    output_asset_id: primero, completed_at: new Date().toISOString(), iteration_count: 1,
  }).eq('id', s.id)

  const { data: rel } = await db().from('forge_sessions').select('status,output_images').eq('id', s.id).single()
  const n = Object.values(rel.output_images || {}).flat().reduce((a, it) => a + (it.variations || []).length, 0)
  console.log(`\n=== verificación ===\n  estado=${rel.status} · imágenes=${n} · assets creados=${paginas.length}`)
})()
