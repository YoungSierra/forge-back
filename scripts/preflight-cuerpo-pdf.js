// ¿Con qué cuerpo se rehace el PDF cuando termina un despacho de imágenes?
//
// El paso de «rehacer el documento con las imágenes dentro» se anclaba en la clave del output de
// IMAGEN, no en la del documento. Medido el 01-09 en el 2.2: extraía `## development_images` —el
// bloque de emisión— y publicaba un PDF cuyo cuerpo eran los metadatos de máquina, sin el Concept
// Treatment. El primer PDF estaba bien; este paso lo sustituía por uno roto.
//
// Compara, sobre cada respuesta viva de un nodo que tenga documento + output de imagen, lo que
// extraía el ancla vieja contra la nueva.
//
// Uso:  node scripts/preflight-cuerpo-pdf.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const FMT_DOC = ['document', 'pdf', 'doc', 'docx', 'pptx']
const anclaDe = k => new RegExp('^#{1,4}\\s+\\*{0,2}\\s*' + k + '\\b.*$', 'im')

function extraer (contenido, clave, outs) {
  const ini = anclaDe(clave).exec(contenido || '')
  if (!ini) return contenido || ''
  const desde = (contenido || '').slice(ini.index + ini[0].length)
  const cortes = outs.map(o => o.key || o.name).filter(k => k && k !== clave)
    .map(k => anclaDe(k).exec(desde)).filter(Boolean).map(r => r.index)
  const sec = desde.slice(0, cortes.length ? Math.min(...cortes) : desde.length).trim()
  return sec.length > 200 ? sec : (contenido || '')
}

;(async () => {
  const { data: nodos } = await db().from('forge_nodes').select('id,node_key,outputs,status')
  const candidatos = (nodos || []).filter(n => {
    const outs = n.outputs || []
    return n.status === 'active'
      && outs.some(o => FMT_DOC.includes(String(o.format || '').toLowerCase()))
      && outs.some(o => o.image_gen)
  })
  console.log(`nodos activos con documento + output de imagen: ${candidatos.length}`)
  const porId = Object.fromEntries(candidatos.map(n => [n.id, n]))

  let ses = [], from = 0
  for (;;) {
    const { data } = await db().from('forge_sessions').select('id,node_id,output_key').range(from, from + 999)
    if (!data?.length) break
    ses = ses.concat(data); if (data.length < 1000) break; from += 1000
  }

  let evaluadas = 0, iguales = 0
  const cambian = []
  for (const s of ses.filter(x => porId[x.node_id] && !x.output_key)) {
    const n = porId[s.node_id]
    const { data: ms } = await db().from('forge_messages').select('role,content').eq('session_id', s.id).order('created_at')
    const c = [...(ms || [])].reverse().find(m => m.role === 'agent')?.content
    if (!c || c.length < 1000) continue
    evaluadas++

    const outs = n.outputs || []
    const claveDoc = (outs.find(o => FMT_DOC.includes(String(o.format || '').toLowerCase())) || outs[0])
    const kDoc = claveDoc.key || claveDoc.name
    for (const img of outs.filter(o => o.image_gen)) {
      const kImg = img.key || img.name
      const antes = extraer(c, kImg, outs)      // el ancla vieja: la del output de imagen
      const ahora = extraer(c, kDoc, outs)      // la nueva: la del documento
      if (antes === ahora) { iguales++; continue }
      cambian.push({ nk: n.node_key, kImg, kDoc, a: antes.length, b: ahora.length, total: c.length })
    }
  }

  console.log(`respuestas de nodo entero evaluadas: ${evaluadas}`)
  console.log(`  el cuerpo del PDF NO cambia: ${iguales}`)
  console.log(`  cambia: ${cambian.length}\n`)
  for (const c of cambian.sort((a, b) => (b.b - b.a) - (a.b - a.a)).slice(0, 20)) {
    const señal = c.b > c.a ? `+${c.b - c.a} chars de documento recuperados` : `${c.b - c.a} chars`
    console.log(`  ${c.nk.padEnd(6)} anclaba en ${c.kImg.padEnd(22)} → ahora ${c.kDoc.padEnd(22)}`)
    console.log(`         ${String(c.a).padStart(6)} → ${String(c.b).padStart(6)} chars  (respuesta: ${c.total})  ${señal}`)
  }
})()
