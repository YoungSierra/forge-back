// Regenera el PDF de un nodo desde la respuesta YA guardada en su sesión (sin llamar al LLM).
// Usa el renderer actual (tools.service.js) → aprovecha el fix de bloques ``` / ASCII-art.
// Con --patch, actualiza el tool_call doc_gen del mensaje agent para que el botón de descarga
// del chat apunte al PDF nuevo.
// Uso: node scripts/regen-doc-from-session.js <project_id> <node_id> [titulo] [--patch]
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { executeTool } = require('../src/services/tools.service')

const PROJECT = process.argv[2]
const NODE    = process.argv[3]
const rest    = process.argv.slice(4)
const PATCH   = rest.includes('--patch')
const TITLE   = rest.filter(a => a !== '--patch')[0] || 'Document'

;(async () => {
  if (!PROJECT || !NODE) { console.error('faltan args: <project_id> <node_id> [titulo] [--patch]'); process.exit(1) }

  const { data: sessions, error: sErr } = await db()
    .from('forge_sessions')
    .select('id, created_at, output_key, status')
    .eq('project_id', PROJECT)
    .eq('node_id', NODE)
    .order('created_at', { ascending: false })
  if (sErr) throw sErr
  if (!sessions?.length) { console.error('no hay sesiones para ese nodo'); process.exit(1) }

  // Mensaje agent más largo (= el documento) junto con su id y tool_calls, para poder parchearlo
  let best = null
  for (const s of sessions) {
    const { data: msgs } = await db()
      .from('forge_messages')
      .select('id, content, role, order_index, tool_calls')
      .eq('session_id', s.id)
      .eq('role', 'agent')
      .order('order_index', { ascending: false })
    for (const m of (msgs || [])) {
      const len = (m.content || '').trim().length
      if (len && (!best || len > best.len)) best = { len, content: m.content, id: m.id, tool_calls: m.tool_calls || [], session: s.id, output_key: s.output_key }
    }
  }
  if (!best) { console.error('no se encontró contenido agent en las sesiones'); process.exit(1) }

  console.log(`sesión: ${best.session}  msg: ${best.id}  output_key: ${best.output_key ?? '(general)'}  chars: ${best.len}`)

  const res = await executeTool('doc_gen_docx', { title: TITLE, content: best.content }, { project_id: PROJECT, node_id: NODE })
  console.log('doc_gen:', JSON.stringify(res))

  if (PATCH && res?.url) {
    // Sincroniza el tool_call doc_gen del mensaje para que el botón de descarga use el PDF nuevo
    const calls = Array.isArray(best.tool_calls) ? best.tool_calls.slice() : []
    let patched = false
    for (const tc of calls) {
      if (tc && (tc.tool === 'doc_gen_docx' || tc.tool === 'doc_gen_pptx')) {
        tc.result = { ...(tc.result || {}), url: res.url, filename: res.filename, format: res.format }
        patched = true
      }
    }
    if (!patched) calls.push({ tool: 'doc_gen_docx', args: { auto: true, regen: true }, result: res })
    const { error: uErr } = await db().from('forge_messages').update({ tool_calls: calls }).eq('id', best.id)
    if (uErr) throw uErr
    console.log(`✓ mensaje ${best.id} parcheado — el botón del chat ahora apunta al PDF nuevo`)
  }
})().catch(e => { console.error(e); process.exit(1) })
