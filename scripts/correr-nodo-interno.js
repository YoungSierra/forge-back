// Corre un nodo por el MISMO camino que el chat del canvas, pero sin navegador de por medio.
//
// Para qué: el 3.12 tarda más de diez minutos y el fetch del navegador no sobrevive. Y como la
// ruta escucha `req.on('close')` para poder cancelar de verdad cuando el usuario aprieta Stop, al
// morir el fetch el back ABORTA su propia generación — la sesión queda vacía y lo ya generado se
// pierde. Acá la conexión es local y no se cae, así que el trabajo llega hasta el final y se
// guarda como cualquier otra corrida: mensajes, asset y documento.
//
// Se monta el router en un express pelado: sin auth, sin proxy, sin límites de plataforma.
//
// Uso:  node scripts/correr-nodo-interno.js <node_key> [project_id]
require('dotenv').config()
const express = require('express')
const http = require('http')
const { db } = require('../src/services/supabase.service')

// Con `fetch` no alcanza: undici corta a los 300 s por defecto y el 3.12 tarda más. Peor todavía,
// ese corte cierra la conexión y la ruta lo lee como un Stop del usuario, así que aborta y tira lo
// generado — el mismo final que en el navegador. `http.request` sin timeout deja llegar al final.
function pedir (opciones, cuerpo) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...opciones, timeout: 0 }, res => {
      let datos = ''
      res.setEncoding('utf8')
      res.on('data', c => { datos += c })
      res.on('end', () => resolve({ status: res.statusCode, texto: datos }))
    })
    req.setTimeout(0)
    req.on('error', reject)
    req.write(cuerpo)
    req.end()
  })
}

const CLAVE = process.argv[2]
const PROY  = process.argv[3] || null
if (!CLAVE) { console.error('uso: <node_key> [project_id]'); process.exit(1) }

;(async () => {
  const { data: n } = await db().from('forge_nodes').select('id,title,executor').eq('node_key', CLAVE).single()
  if (!n) { console.error(`no existe el nodo ${CLAVE}`); process.exit(1) }

  // La instancia: la que el usuario corrió (su sesión más reciente) o, si nunca corrió, la del
  // proyecto que se pase. Correr la instancia equivocada escribiría en el lane de al lado.
  let proyecto = PROY, instancia = null
  const { data: ses } = await db().from('forge_sessions')
    .select('project_id,project_node_id,created_at').eq('node_id', n.id)
    .not('project_node_id', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (ses && (!PROY || ses.project_id === PROY)) { proyecto = ses.project_id; instancia = ses.project_node_id }
  if (!instancia) {
    const { data: pn } = await db().from('forge_project_nodes')
      .select('id').eq('node_id', n.id).eq('project_id', proyecto).limit(1).maybeSingle()
    instancia = pn?.id
  }
  if (!proyecto || !instancia) { console.error('no encontré la instancia — pasá el project_id'); process.exit(1) }

  const { data: p } = await db().from('projects').select('name').eq('id', proyecto).maybeSingle()
  console.log(`${CLAVE} ${n.title} · ${n.executor?.model}`)
  console.log(`proyecto ${p?.name || proyecto} · instancia ${instancia.slice(0, 8)}\n`)

  const app = express()
  app.use(express.json({ limit: '50mb' }))
  app.use('/api/projects/:id/canvas', require('../src/routes/forge-canvas.routes'))
  const srv = app.listen(0)
  const port = srv.address().port

  const t0 = Date.now()
  const tic = setInterval(() => process.stdout.write(`\r  corriendo… ${Math.round((Date.now() - t0) / 1000)}s`), 5000)

  try {
    const cuerpo = JSON.stringify({
      user_message: process.argv.find(a => a.startsWith('--msg=')) ? process.argv.find(a => a.startsWith('--msg=')).slice(6) : 'Generate the output for this step',
      project_node_id: instancia,
    })
    const r = await pedir({
      host: '127.0.0.1', port, method: 'POST',
      path: `/api/projects/${proyecto}/canvas/nodes/${n.id}/chat`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) },
    }, cuerpo)
    clearInterval(tic)
    const segundos = Math.round((Date.now() - t0) / 1000)
    const txt = r.texto
    let j = null
    try { j = JSON.parse(txt) } catch {}
    console.log(`\r  HTTP ${r.status} en ${segundos}s${' '.repeat(20)}`)
    if (!j?.success) {
      console.log(`  ✗ ${j?.error || txt.slice(0, 400)}`)
    } else {
      console.log(`  ✓ sesión ${String(j.session_id).slice(0, 8)} · respuesta ${String(j.reply || '').length} chars`)
      console.log(`    documento: ${j.doc_url || '(ninguno)'}`)
      if (j.images_dispatched?.length) console.log(`    imágenes despachadas: ${j.images_dispatched.join(', ')}`)
    }
  } catch (e) {
    clearInterval(tic)
    console.log(`\r  ✗ ${e.message}${' '.repeat(20)}`)
  } finally {
    srv.close()
  }

  // Qué quedó guardado. Es lo único que importa: la respuesta en pantalla se pierde, la fila no.
  const { data: fin } = await db().from('forge_sessions')
    .select('id,status,created_at,output_asset_id').eq('project_node_id', instancia)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (fin) {
    const { count } = await db().from('forge_messages')
      .select('*', { count: 'exact', head: true }).eq('session_id', fin.id)
    console.log(`\nsesión ${fin.id.slice(0, 8)} · ${fin.status} · ${count} mensaje(s) · asset ${fin.output_asset_id ? 'sí' : 'no'}`)
  }
  process.exit(0)
})()
