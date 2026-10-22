// Prueba sin base ni red del lector de clips del Vertical Slice (`clipsDeLaTabla`, animacion.service).
// Casos de las formas que escriben los proyectos vivos: la lista agrupada de Wort (con «loop: true» y la cola de
// eventos), la de pinball, la tabla markdown, y que el núcleo del nombre no adivine cuando hay dos candidatos.
// Uso (desde forge-back): node scripts/prueba-clips-vs.js
'use strict'
const path = require('path')
// El servicio carga los proveedores de LLM al importarse y estos piden sus claves; la prueba no llama a ninguno.
require('dotenv').config({ path: path.join(process.cwd(), '.env') })
const { clipsDeLaTabla } = require(path.join(__dirname, '..', 'src/services/animacion.service'))

let fallos = 0
const linea = (ok, t) => { if (!ok) fallos++; console.log(`${ok ? '✔' : '✖'} ${t}`) }
const resumen = cs => (cs || []).map(c => `${c.nombre}${c.loop ? '↻' : ''}`).join(' ')

const WORT = [
  '## B4 · Animation',
  '*Professor Wort (8 clips):*',
  '1. `ANIM_Wort_Idle.fbx` — loop: true — FINAL',
  '2. `ANIM_Wort_Run.fbx` — loop: true — FINAL',
  '3. `ANIM_Wort_Jump.fbx` — loop: false; event: `OnJumpStarted` — FINAL',
  '*Sprat (4 clips):*',
  '9. `ANIM_Sprat_Idle.fbx` — loop: true — FINAL',
  '10. `ANIM_Sprat_Drift.fbx` — loop: true — FINAL',
  '12. `ANIM_Sprat_Freeze.fbx` — loop: false — FINAL (used in ENV-02; present in rig for completeness)',
  '*Neon Fly (3 clips):*',
  '16. `ANIM_NeonFly_Hover.fbx` — loop: true — FINAL',
  '## B5 · VFX',
].join('\n')
const PERS_WORT = ['Professor Wort', 'Sprat', 'Neon Fly', 'CHR_Wort (mesh, textures, rig)', 'CHR_Wort animations (8 clips)', 'CHR_Sprat animations (4 clips)']

let c = clipsDeLaTabla(WORT, 'CHR_Wort animations (8 clips)', PERS_WORT, false)
linea(resumen(c) === 'idle↻ run↻ jump', `Wort por su hoja «CHR_Wort animations (8 clips)»: ${resumen(c)}`)
linea(c?.[2]?.reglas === 'loop: false; event: OnJumpStarted', `la cola del VS llega como reglas: «${c?.[2]?.reglas}»`)
c = clipsDeLaTabla(WORT, 'Professor Wort', PERS_WORT, false)
linea(resumen(c) === 'idle↻ run↻ jump', `Wort por «Professor Wort»: ${resumen(c)}`)
c = clipsDeLaTabla(WORT, 'CHR_Sprat animations (4 clips)', PERS_WORT, false)
linea(resumen(c) === 'idle↻ drift↻ freeze', `Sprat: Drift cicla porque el VS lo dice (${resumen(c)})`)
linea(c?.[2]?.reglas === 'loop: false; used in ENV-02; present in rig for completeness', 'Sprat Freeze: la cola y el paréntesis, juntos')

// Pinball: sin «loop:», el bucle se deduce del nombre como siempre.
const PINBALL = [
  '### B3 · Animation',
  '*Luma (Axolotl) — 2 clips:*',
  '1. ANIM_Luma_Idle_Sleepy (gill plumes drooped, no motion, 2.0 s loop)',
  '2. ANIM_Luma_Swim (tail sweep)',
  '*Chef Crab — 1 clips:*',
  '3. ANIM_ChefCrab_Idle_Sleepy (folded claws)',
].join('\n')
c = clipsDeLaTabla(PINBALL, 'Luma (Axolotl)', ['Luma (Axolotl)', 'Chef Crab'], false)
linea(resumen(c) === 'idlesleepy↻ swim' && c[0].reglas === 'gill plumes drooped, no motion, 2.0 s loop', `pinball (sin «loop:»): ${resumen(c)}`)

// Tabla markdown y la coincidencia exacta.
const TABLA = [
  '## B4 · Animation',
  '| # | Clip |',
  '|---|---|',
  '| 1 | Moon Jelly — Pulse (bell contraction) |',
  '| 2 | Boss Moon Jelly — Roar |',
  '| 3 | Moon Jelly — Drift (loop: false) |',
].join('\n')
c = clipsDeLaTabla(TABLA, 'Moon Jelly × 6 (mesh + shader + animation)', ['Moon Jelly × 6 (mesh + shader + animation)', 'Boss Moon Jelly'], false)
linea(resumen(c) === 'pulse↻ drift', `tabla: Moon Jelly sin el Roar del jefe, y «loop: false» manda (${resumen(c)})`)

// El núcleo no adivina: dos sujetos con la misma palabra → nada.
const AMBIGUO = ['## B4 · Animation', '*Wort Senior (1 clips):*', '1. ANIM_Wort_Idle', '*Wort Junior (1 clips):*', '1. ANIM_Wort_Walk'].join('\n')
c = clipsDeLaTabla(AMBIGUO, 'CHR_Wort animations (2 clips)', ['Wort Senior', 'Wort Junior', 'CHR_Wort animations (2 clips)'], false)
linea(Array.isArray(c) && c.length === 0, 'dos sujetos con el mismo núcleo: no adivina, sale vacío')
linea(clipsDeLaTabla('## B5 · VFX\nnada', 'Wort', ['Wort'], false) === null, 'sin sección de animación: null (cae al ADI, como antes)')

console.log(`\n${fallos ? `✖ ${fallos} comprobación(es) fallaron` : '✔ todas las comprobaciones como deben'}`)
process.exit(fallos ? 1 : 0)
