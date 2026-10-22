// Prueba sin red ni base de `anclaDelPersonaje`: qué vista frontal se usa para animar.
//
// Los casos salen de proyectos reales (22-10): volver a correr la cadena de Character Sheet sobre la
// misma hoja NO crea otro personaje, y la única vista de un personaje no sirve para animar a otro.
//
// Uso (desde forge-back): node scripts/prueba-ancla-personaje.js
'use strict'
const path = require('path')
require('dotenv').config({ path: path.join(process.cwd(), '.env') })   // el servicio arrastra proveedores que piden su clave al cargar
const { anclaDelPersonaje } = require(path.join(__dirname, '../src/services/animacion.service'))

// Base falsa: solo lo que pide el servicio (select/eq/not/order/in/maybeSingle sobre forge_assets).
const baseCon = filas => () => ({
  from: () => {
    let r = [...filas]
    const q = {
      select: () => q,
      eq: (c, v) => { r = r.filter(f => (c === 'metadata->cadena->>rol' ? f.metadata?.cadena?.rol : f[c]) === v); return q },
      not: () => { r = r.filter(f => f.storage_url); return q },
      order: () => { r.sort((a, b) => b.created_at.localeCompare(a.created_at)); return q },
      in: (c, vs) => { r = r.filter(f => vs.includes(f[c])); return q },
      maybeSingle: async () => ({ data: r[0] || null }),
      then: (ok, ko) => Promise.resolve({ data: r }).then(ok, ko),
    }
    return q
  },
})
const P = 'proy'
const hoja = (id, item) => ({ id, project_id: P, name: `Art Style Guide — 18_CharacterSheet${item ? ` — ${item}` : ''}`, metadata: item ? { instancia: { item } } : {}, created_at: '2026-10-01' })
const frente = (id, madre, fecha, nombre, extra = {}) => ({ id, project_id: P, name: nombre, storage_url: `https://x/${id}.png`,
  derived_from_id: madre, created_at: fecha, metadata: { job: `job_${id}`, cadena: { rol: 'front', nombre: 'character_sheet' }, ...extra } })

let fallos = 0
const linea = (ok, t) => { if (!ok) fallos++; console.log(`${ok ? '✔' : '✖'} ${t}`) }
const correr = (filas, desde) => anclaDelPersonaje({ db: baseCon(filas), project_id: P, desde }).then(a => a, e => ({ error: e.code, msg: e.message }))

;(async () => {
  // Professor_Wort_&_Sprat_world: tres corridas sobre la misma hoja de Wort (13-10, 21-10 ×2) y un New angle.
  const wort = [hoja('hw', 'Professor Wort'),
    frente('w1', 'hw', '2026-10-13T18:24', 'Wort front 13-10'),
    frente('w2', 'hw', '2026-10-21T19:10', 'Wort front 21-10 19:10'),
    frente('w3', 'hw', '2026-10-21T19:23', 'Wort front 21-10 19:23'),
    frente('w4', 'w1', '2026-10-15T16:25', 'Wort front New angle', { herramienta: { clave: 'multiangle' } })]
  let a = await correr(wort, null)
  linea(a.id === 'w3' && a.item === 'Professor Wort', `1 tres corridas del mismo personaje = un personaje; gana la más nueva (${a.id || a.error})`)
  a = await correr(wort, 'CHR_Wort animations (8 clips)')
  linea(a.id === 'w3', `2 desde «CHR_Wort animations»: la de Wort aunque el ítem diga «Professor Wort» (${a.id || a.error})`)
  for (const d of ['CHR_Sprat animations (4 clips)', 'CHR_MechanicalCrab animations (3 clips)']) {
    a = await correr(wort, d)
    linea(a.error === 'SIN_ANCLA', `3 desde «${d}»: no anima a otro con la cara de Wort (${a.error || a.id})`)
  }

  // test_pinball_migue_v.10: varios personajes, cada uno corrido varias veces.
  const pinball = [hoja('hl', 'Luma (Axolotl)'), hoja('hk', 'Koala (Elder)'),
    frente('l1', 'hl', '2026-10-02', 'Luma 1'), frente('l2', 'hl', '2026-10-08', 'Luma 2'),
    frente('k1', 'hk', '2026-10-03', 'Koala 1'), frente('k2', 'hk', '2026-10-07', 'Koala 2')]
  a = await correr(pinball, 'Koala (Elder)')
  linea(a.id === 'k2', `4 desde «Koala (Elder)»: la Koala más nueva (${a.id || a.error})`)
  a = await correr(pinball, null)
  linea(a.error === 'ANCLA_AMBIGUA' && /has 2 characters/.test(a.msg), `5 sin pista y dos personajes: para y dice 2, no 4 (${a.msg || a.id})`)

  // test_smack_migue_v.09: la hoja genérica no declara ítem; desde Cartón sale por eliminación, como antes.
  const smack = [hoja('hm', 'Moon Jelly × 6'), hoja('hg', null),
    frente('m1', 'hm', '2026-09-17T20:53', 'Moon Jelly front'), frente('g1', 'hg', '2026-09-17T16:28', 'Generic front')]
  a = await correr(smack, 'Cartón rig + all animations')
  linea(a.id === 'g1' && a.por === 'eliminación', `6 desde «Cartón»: la genérica por eliminación (${a.id || a.error})`)
  a = await correr(smack, 'Moon Jelly × 6 (mesh + shader + animation)')
  linea(a.id === 'm1' && a.por === 'instancia', `7 desde «Moon Jelly»: por instancia (${a.id || a.error})`)

  console.log(`\n${fallos ? `✖ ${fallos} comprobación(es) fallaron` : '✔ todas las comprobaciones como deben'}`)
  process.exit(fallos ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
