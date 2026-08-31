// Repara las sesiones a las que el accept les colgó el documento de OTRO nodo.
//
// El accept recibía `session_id` por el body y `node_id` por la URL sin comprobar que fueran del
// mismo nodo (arreglado el 31-08 con una guarda 409 en la ruta). Cuando se desincronizaban, el
// asset se creaba con el node_id y el contenido del nodo que el usuario estaba mirando pero
// colgado de la sesión de otro: el nodo de destino se quedaba sin aprobar —el Accept "no hacía
// nada"— y el invadido enseñaba ese documento ajeno en todas sus pestañas.
//
// La reparación: al asset intruso se le quita la sesión ajena, y la sesión invadida recupera su
// propio documento a partir de la respuesta que sí está en forge_messages.
//
// Uso:  node scripts/reparar-sesiones-cruzadas.js            (simula)
//       node scripts/reparar-sesiones-cruzadas.js --apply
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const APLICAR = process.argv.includes('--apply')

;(async () => {
  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions')
      .select('id,node_id,project_id,project_node_id,output_key,status,output_asset_id,created_at')
      .not('output_asset_id', 'is', null).range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }

  const ids = [...new Set(ses.map(s => s.output_asset_id))]
  const assets = {}
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await db().from('forge_assets')
      .select('id,node_id,name,format,status,content,storage_url,session_id').in('id', ids.slice(i, i + 300))
    ;(data || []).forEach(a => { assets[a.id] = a })
  }
  const { data: ns } = await db().from('forge_nodes').select('id,node_key,title,outputs')
  const nodos = Object.fromEntries(ns.map(n => [n.id, n]))

  const cruzadas = ses.filter(s => assets[s.output_asset_id] && assets[s.output_asset_id].node_id !== s.node_id)
  console.log(`sesiones con asset: ${ses.length} · cruzadas: ${cruzadas.length}\n`)

  for (const s of cruzadas) {
    const intruso = assets[s.output_asset_id]
    const dueno   = nodos[s.node_id]
    const ajeno   = nodos[intruso.node_id]
    console.log(`── sesión ${s.id.slice(0, 8)} de ${dueno?.node_key} (${s.output_key ?? 'general'}, ${s.status})`)
    console.log(`   tiene colgado: «${intruso.name}» de ${ajeno?.node_key}`)

    // La respuesta propia de la sesión vive en forge_messages
    const { data: ms } = await db().from('forge_messages')
      .select('id,role,content,tool_calls').eq('session_id', s.id).order('created_at')
    const agente = [...(ms || [])].reverse().find(m => m.role === 'agent' && (m.content || '').trim())
    if (!agente) { console.log('   ⚠ sin respuesta propia en forge_messages — se deja como está\n'); continue }

    // El documento generado en ESA sesión, si lo hubo
    let docUrl = null, docFmt = null
    for (const m of [...(ms || [])].reverse()) {
      for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
        if (/^doc_gen_(docx|pptx)$/.test(tc?.tool || '') && tc?.result?.url) {
          docUrl = tc.result.url; docFmt = tc.result.format || (tc.tool === 'doc_gen_pptx' ? 'pptx' : 'pdf'); break
        }
      }
      if (docUrl) break
    }

    const outDef = s.output_key ? (dueno?.outputs || []).find(o => (o.key || o.name) === s.output_key) : null
    const nombre = outDef ? `${dueno.title} — ${outDef.label || outDef.name || s.output_key}` : `${dueno.title} — Output`
    console.log(`   respuesta propia: ${agente.content.length} chars · doc ${docUrl ? docFmt : 'ninguno'}`)
    console.log(`   → asset nuevo «${nombre}» (${docUrl ? (docFmt === 'pptx' ? 'pptx' : 'docx') : 'markdown'})`)
    console.log(`   → al intruso se le quita session_id (queda colgado de su nodo, sin sesión ajena)`)

    if (!APLICAR) { console.log(''); continue }

    const { data: nuevo, error: e1 } = await db().from('forge_assets').insert({
      node_id: s.node_id, project_id: s.project_id, session_id: s.id, name: nombre,
      format: docUrl ? (docFmt === 'pptx' ? 'pptx' : 'docx') : 'markdown',
      status: 'approved', content: agente.content.trim(), storage_url: docUrl,
      approved_at: new Date().toISOString(),
    }).select('id').single()
    if (e1) { console.log(`   ✗ no se pudo crear el asset: ${e1.message}\n`); continue }

    const { error: e2 } = await db().from('forge_sessions')
      .update({ output_asset_id: nuevo.id }).eq('id', s.id)
    if (e2) { console.log(`   ✗ no se pudo repuntar la sesión: ${e2.message}\n`); continue }

    // El intruso no se borra: su contenido es real y su nodo puede estar apuntándolo. Solo se le
    // suelta la sesión ajena para que nadie lo lea como output de ella.
    if (intruso.session_id === s.id) {
      await db().from('forge_assets').update({ session_id: null }).eq('id', intruso.id)
    }
    console.log(`   ✓ reparada → asset ${nuevo.id.slice(0, 8)}\n`)
  }

  if (!APLICAR) console.log('(simulación — usar --apply para escribir)')
})()
