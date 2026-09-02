// Quita el lote DUPLICADO de imágenes de un output y rehace el documento con el bueno.
//
// Cuando un output se despachó dos veces quedan dos tandas: la del sobre, con el `id` de cada
// imagen por nombre —la que el documento cita en sus anclas—, y otra sin nombre, generada con
// otros prompts. Medido el 02-09 en el 2.2: la buena era el océano bioluminiscente que pedía el
// prompt; la duplicada, un taller de alta costura parisino con el cartel «DEVANLAY PARIS».
//
// La duplicada es la que suele tener las filas de asset, así que es la que se llevan el PDF y los
// nodos de abajo aunque en pantalla se vean las otras. Esto la borra —filas, no archivos de R2— y
// vuelve a armar el documento con las buenas ancladas.
//
// Uso:  node scripts/quitar-lote-duplicado.js <node_key> <project_id> <output_key>            (simula)
//       node scripts/quitar-lote-duplicado.js <node_key> <project_id> <output_key> --apply
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const [CLAVE, PROY, OUT] = process.argv.slice(2)
const APLICAR = process.argv.includes('--apply')
if (!CLAVE || !PROY || !OUT) { console.error('uso: <node_key> <project_id> <output_key> [--apply]'); process.exit(1) }

;(async () => {
  const { data: n } = await db().from('forge_nodes').select('id,title,outputs').eq('node_key', CLAVE).single()
  const { data: ses } = await db().from('forge_sessions')
    .select('id,output_key,output_images').eq('project_id', PROY).eq('node_id', n.id).order('created_at')

  // El lote BUENO es el que trae nombre: ese nombre es el id que el documento ancla.
  const buenas = [], malas = []
  for (const s of ses) {
    for (const it of ((s.output_images || {})[OUT] || [])) {
      for (const v of (it.variations || [])) {
        if (!v.url) continue
        ;(it.name ? buenas : malas).push({ ses: s.id, index: it.index, name: it.name || null, url: v.url })
      }
    }
  }
  console.log(`${CLAVE} · ${OUT}`)
  console.log(`  con nombre (se conservan): ${buenas.length}`)
  buenas.forEach(b => console.log(`     [${b.index}] ${b.name}`))
  console.log(`  sin nombre (se borran):    ${malas.length}`)
  malas.forEach(b => console.log(`     [${b.index}] ${b.url.slice(-30)}`))

  if (!buenas.length) { console.error('\nno hay lote con nombre: no se borra nada a ciegas.'); process.exit(1) }
  if (!malas.length) { console.log('\nno hay lote duplicado — nada que quitar.'); return }

  const urlsMalas = new Set(malas.map(m => m.url))
  const { data: assets } = await db().from('forge_assets')
    .select('id,name,storage_url,format').eq('project_id', PROY).eq('node_id', n.id).eq('format', 'png')
  const aBorrar = (assets || []).filter(a => urlsMalas.has(a.storage_url))
  console.log(`\n  filas de asset del lote malo: ${aBorrar.length} de ${(assets || []).length} png`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para borrar y rehacer el PDF)')

  // 1 · fuera las filas de asset del lote malo (el archivo se queda en R2)
  if (aBorrar.length) await db().from('forge_assets').delete().in('id', aBorrar.map(a => a.id))

  // 2 · fuera de `output_images` de la sesión y del mensaje que las colgaba
  for (const s of ses) {
    const lista = ((s.output_images || {})[OUT] || [])
      .map(it => ({ ...it, variations: (it.variations || []).filter(v => !urlsMalas.has(v.url)) }))
      .filter(it => it.variations.length)
    const nuevo = { ...(s.output_images || {}) }
    if (lista.length) nuevo[OUT] = lista; else delete nuevo[OUT]
    await db().from('forge_sessions').update({ output_images: Object.keys(nuevo).length ? nuevo : null }).eq('id', s.id)

    const { data: msgs } = await db().from('forge_messages').select('id,output_images').eq('session_id', s.id)
    for (const m of (msgs || [])) {
      if (!m.output_images?.[OUT]) continue
      const l = m.output_images[OUT]
        .map(it => ({ ...it, variations: (it.variations || []).filter(v => !urlsMalas.has(v.url)) }))
        .filter(it => it.variations.length)
      const nm = { ...m.output_images }
      if (l.length) nm[OUT] = l; else delete nm[OUT]
      await db().from('forge_messages').update({ output_images: Object.keys(nm).length ? nm : null }).eq('id', m.id)
    }
  }

  // 3 · el documento, rehecho con las buenas ancladas por su id
  const { executeTool } = require('../src/services/tools.service')
  const gen = ses.find(s => !s.output_key)
  const { data: msgs } = await db().from('forge_messages')
    .select('id,content,tool_calls').eq('session_id', gen.id).order('created_at', { ascending: false }).limit(6)
  const conDoc = (msgs || []).find(m => (m.tool_calls || []).some(t => /doc_gen/.test(t.tool || '') && t.result?.url))
  if (!conDoc) { console.log('\nno hay documento previo que rehacer.'); return }

  // El cuerpo es la sección del OUTPUT DOCUMENTO, no la del output de imagen.
  const FMT = ['document', 'pdf', 'doc', 'docx', 'pptx']
  const defDoc = (n.outputs || []).find(o => FMT.includes(String(o.format || '').toLowerCase())) || (n.outputs || [])[0]
  const kDoc = defDoc?.key || defDoc?.name
  const anclaDe = k => new RegExp('^#{1,4}\\s+\\*{0,2}\\s*' + k + '\\b.*$', 'im')
  let cuerpo = conDoc.content || ''
  const ini = anclaDe(kDoc).exec(cuerpo)
  if (ini) {
    const desde = cuerpo.slice(ini.index + ini[0].length)
    const cortes = (n.outputs || []).map(o => o.key || o.name).filter(k => k && k !== kDoc)
      .map(k => anclaDe(k).exec(desde)).filter(Boolean).map(r => r.index)
    const sec = desde.slice(0, cortes.length ? Math.min(...cortes) : desde.length).trim()
    if (sec.length > 600) cuerpo = sec
  }

  const titulo = (conDoc.tool_calls.find(t => /doc_gen/.test(t.tool || ''))?.result?.filename || 'Document').replace(/\.pdf$/i, '')
  const rehecho = await executeTool('doc_gen_docx', {
    title: titulo, content: cuerpo,
    item_images: buenas.map(b => ({ title: b.name, url: b.url })),
  }, { project_id: PROY, node_id: n.id })

  if (!rehecho?.url) { console.error('\nno se pudo rehacer el documento'); return }
  const tc = conDoc.tool_calls.map(t => (/doc_gen/.test(t.tool || '') && t.result?.url)
    ? { ...t, result: { ...t.result, url: rehecho.url } } : t)
  await db().from('forge_messages').update({ tool_calls: tc }).eq('id', conDoc.id)
  // El enlace vive en DOS sitios: el tool_call que lee el chip del chat y el asset que lee el nodo.
  const { data: docAsset } = await db().from('forge_assets')
    .select('id').eq('session_id', gen.id).neq('format', 'png').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (docAsset?.id) await db().from('forge_assets').update({ storage_url: rehecho.url }).eq('id', docAsset.id)

  console.log(`\n=== verificación ===`)
  console.log(`  assets png borrados: ${aBorrar.length}`)
  console.log(`  documento rehecho con ${buenas.length} imagen(es) → ${rehecho.url}`)
})()
