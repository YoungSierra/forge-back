// Comprueba que la clave y el endpoint de MiniMax responden, y con qué modelos.
// No se asume: `api.minimaxi.chat` y `api.minimax.io` son cuentas distintas, y una clave de una
// devuelve 401 en la otra sin decir por qué.
//
// Uso:  node scripts/probar-minimax.js [modelo ...]
require('dotenv').config()
const { callMinimax } = require('../src/services/providers/minimax.provider')

const MODELOS = process.argv.slice(2)
const aProbar = MODELOS.length ? MODELOS : ['MiniMax-M3', 'MiniMax-M2.7']

;(async () => {
  console.log(`endpoint: ${process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1 (por defecto)'}`)
  console.log(`clave:    ${process.env.MINIMAX_API_KEY ? process.env.MINIMAX_API_KEY.slice(0, 6) + '…' + process.env.MINIMAX_API_KEY.slice(-4) : '✗ NO HAY MINIMAX_API_KEY'}\n`)
  if (!process.env.MINIMAX_API_KEY) process.exit(1)

  for (const modelo of aProbar) {
    const t0 = Date.now()
    try {
      const r = await callMinimax(
        'You are a test probe. Answer in one short sentence.',
        'Reply with the single word: ready',
        { model: modelo, rawText: true, maxOutputTokens: 64 },
      )
      const tk = r.meta.tokens_used
      console.log(`✓ ${modelo.padEnd(18)} texto  ${Date.now() - t0} ms · in ${tk.input} / out ${tk.output} · «${String(r.data).slice(0, 60)}»`)
    } catch (e) {
      console.log(`✗ ${modelo.padEnd(18)} texto  ${e.code || e.status || ''} ${e.message}`)
    }

    // El camino que usan los nodos de verdad es JSON, no texto: un modelo que contesta en texto
    // pero no cierra un JSON parseable no sirve como ejecutor, y eso solo se ve pidiéndoselo.
    const t1 = Date.now()
    try {
      const r = await callMinimax(
        'You are a test probe.',
        'Return a JSON object with exactly two keys: "status" set to "ok" and "model" set to your own name.',
        { model: modelo, maxOutputTokens: 256 },
      )
      const claves = Object.keys(r.data || {})
      console.log(`  ${modelo.padEnd(18)} json   ${Date.now() - t1} ms · claves: ${claves.join(', ') || '(vacío)'}`)
    } catch (e) {
      console.log(`  ${modelo.padEnd(18)} json   ✗ ${e.code || e.status || ''} ${e.message}`)
    }
  }
})()
