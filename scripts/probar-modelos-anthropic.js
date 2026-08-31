// Comprueba qué identificadores de modelo de Anthropic responden de verdad.
//
// Escribir un id a ojo en el selector no falla al guardarlo: falla el día que alguien corre ese
// nodo, con un 404 que llega después de haber armado todo el contexto. Acá se pregunta primero.
//
// Uso:  node scripts/probar-modelos-anthropic.js [id ...]
require('dotenv').config()
const Anthropic = require('@anthropic-ai/sdk')

const CANDIDATOS = process.argv.slice(2)
const aProbar = CANDIDATOS.length ? CANDIDATOS : [
  'claude-sonnet-5', 'claude-sonnet-4-8', 'claude-sonnet-4-6',
  'claude-opus-5', 'claude-opus-4-7', 'claude-haiku-4-5-20251001',
]

;(async () => {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('falta ANTHROPIC_API_KEY'); process.exit(1) }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // El catálogo, si el proveedor lo expone: es la respuesta buena, sin gastar una llamada por id.
  try {
    const lista = await client.models.list({ limit: 100 })
    const ids = (lista.data || []).map(m => m.id)
    console.log(`catálogo de la cuenta — ${ids.length} modelo(s):`)
    ids.forEach(id => console.log(`   ${id}`))
    console.log('')
    for (const id of aProbar) {
      console.log(`   ${id.padEnd(30)} ${ids.includes(id) ? '✓ está en el catálogo' : '✗ NO está'}`)
    }
    return
  } catch (e) {
    console.log(`(sin catálogo: ${e.message}) — se prueba uno por uno con una llamada mínima\n`)
  }

  for (const id of aProbar) {
    const t0 = Date.now()
    try {
      const r = await client.messages.create({
        model: id, max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      })
      const txt = (r.content || []).map(c => c.text || '').join('').trim()
      console.log(`✓ ${id.padEnd(30)} ${Date.now() - t0} ms · «${txt.slice(0, 40)}»`)
    } catch (e) {
      console.log(`✗ ${id.padEnd(30)} ${e.status || ''} ${(e?.error?.error?.message || e.message || '').slice(0, 90)}`)
    }
  }
})()
