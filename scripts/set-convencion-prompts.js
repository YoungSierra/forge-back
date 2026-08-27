// Agrega la convención de emisión de prompts al final del prompt de un output de imagen.
//
// POR QUÉ: el motor tiene diez reglas para descubrir DÓNDE escribió el modelo su prompt de imagen,
// porque cada output lo escribe distinto — y el mismo output cambió de forma entre dos corridas de
// la misma tarde (bloque cercado a las 19:24, blockquote a las 19:47). Cuando ninguna regla
// reconoce la forma, el parseo cae a las viñetas y a ComfyUI le llega el razonamiento en vez del
// prompt: el 2.4 mandó 337 caracteres de análisis de paleta teniendo un prompt de 1.400 al lado.
//
// El bloque que pide esta convención YA lo lee el motor sin ningún cambio de código.
//
// Uso:  node scripts/set-convencion-prompts.js <node_key> <output_key>            (simula)
//       node scripts/set-convencion-prompts.js <node_key> <output_key> --apply
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const NODE_KEY = process.argv[2]
const OUT_KEY  = process.argv[3]
const APLICAR  = process.argv.includes('--apply')
if (!NODE_KEY || !OUT_KEY) { console.error('uso: <node_key> <output_key> [--apply]'); process.exit(1) }

const MARCA = 'EMISSION CONTRACT'

const convencion = clave => [
  ``,
  `${MARCA} — close your reply with this block, and nothing else after it:`,
  '',
  '```json',
  `{ "${clave}": [`,
  `    { "id": "<rendered filename without extension>",`,
  `      "prompt": "<the complete prompt, ready to render>",`,
  `      "placement": "<the document section this image belongs in>" }`,
  `] }`,
  '```',
  '',
  `One object per image; the array's length IS the count. An empty array is a valid answer and`,
  `means no image is needed. Your analysis, palette decisions and reasoning go ABOVE the block, in`,
  `prose, as freely as you like — but NOTHING outside this block is read as a prompt, so a prompt`,
  `written only in prose, in a fenced block or in a quote never reaches the renderer.`,
].join('\n')

;(async () => {
  const { data: n, error } = await db().from('forge_nodes').select('id, node_key, outputs').eq('node_key', NODE_KEY).single()
  if (error) throw error
  const def = (n.outputs || []).find(o => (o.key || o.name) === OUT_KEY)
  if (!def) throw new Error(`el output "${OUT_KEY}" no existe en el ${NODE_KEY}`)
  if (!def.image_gen) throw new Error(`"${OUT_KEY}" no es un output de imagen`)
  if (String(def.prompt || '').includes(MARCA)) return console.log('ya tiene la convención — no se toca')

  const nuevo = `${String(def.prompt || '').trim()}\n${convencion(OUT_KEY)}`
  console.log(`${NODE_KEY}/${OUT_KEY}: ${String(def.prompt || '').length} → ${nuevo.length} chars`)
  console.log('\n' + convencion(OUT_KEY))

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  // Superposición sobre la fila viva: se reescribe SOLO el prompt de ESE output.
  const outputs = n.outputs.map(o => (o.key || o.name) === OUT_KEY ? { ...o, prompt: nuevo } : o)
  const { error: e2 } = await db().from('forge_nodes').update({ outputs }).eq('id', n.id)
  if (e2) throw e2
  const { data: v } = await db().from('forge_nodes').select('outputs').eq('id', n.id).single()
  console.log('\nescrito · outputs intactos:', v.outputs.length === n.outputs.length,
    '· la convención está:', String(v.outputs.find(o => (o.key || o.name) === OUT_KEY).prompt).includes(MARCA))
})()
