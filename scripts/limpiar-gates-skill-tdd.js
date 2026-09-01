// Quita del skill del 3.12 toda referencia a un NÚMERO de gate, dejando el nombre.
//
// Por qué: al subir el estándar completo (34 KB, G-01..G-18) el modelo recuperó los tres gates que
// faltaban PERO conservó su numeración vieja de G-07 a G-15 — corrida en uno desde G-09, y sin los
// dos gates de jugabilidad del estándar. La causa es que el mapeo fuente→sección que va arriba
// menciona once veces un número de gate con el significado VIEJO: «input map (G-11)», «perf
// budgets (G-14)», «gate = 14 PASS… 15/15». El modelo lee dos numeraciones contradictorias en el
// mismo prompt y le gana la primera.
//
// La numeración vive en UN solo sitio: la tabla del estándar. Arriba se habla por NOMBRE, que no
// puede chocar con ella. Los nombres son los del estándar, no los del skill viejo — ahí está la
// corrección: donde el skill decía G-11 queriendo decir «input coverage», ahora dice
// «Input coverage», que en el estándar es G-10.
//
// Uso:  node scripts/limpiar-gates-skill-tdd.js <template.md>            (simula)
//       node scripts/limpiar-gates-skill-tdd.js <template.md> --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const ps = require('../src/services/prompt.service')
const { db } = require('../src/services/supabase.service')

const RUTA    = process.argv[2]
const APLICAR = process.argv.includes('--apply')
const CLAVE   = 'tdd_template_population'
const BASE    = path.resolve(__dirname, '../../_Prod/backups/tdd_template_population_pre_template_20260831.md')
if (!RUTA) { console.error('uso: <template.md> [--apply]'); process.exit(1) }

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)

// Cada número, por el nombre que ese gate tiene EN EL ESTÁNDAR.
const CAMBIOS = [
  ['gate-certifiable (§0.2, G-01..G-15)',
   'gate-certifiable (§0.2 — every item of the standard\'s own gate table, reproduced below)'],
  ['⇒ gate failure (G-08)',
   '⇒ gate failure (Zero pending: a marker without an owner is a pending slot)'],
  ['absence is never valid (G-01)',
   'absence is never valid (§A required fields)'],
  ['← 3.9 ui_screens (G-12)',
   '← 3.9 ui_screens (UI coverage)'],
  ['11.3 input map (G-11)',
   '11.3 input map (Input coverage)'],
  ['11.4 persistence spec (G-10)',
   '11.4 persistence spec (Persistence coverage)'],
  ['11.6 perf budgets per platform (G-14)',
   '11.6 perf budgets per platform (Performance budgets)'],
  ['← 3.9 scene_manifest (G-13)',
   '← 3.9 scene_manifest (Scene coverage)'],
  ['measurable exit criteria, G-15)',
   'measurable exit criteria)'],
  ['exact engine pin — G-02)',
   'exact engine pin — Engine pin)'],
  ['same bar regardless of sliceScope (G-03/G-04)',
   'same bar regardless of sliceScope (Mechanic bar / Acceptance criteria)'],
  ['every non-mechanic dependency id; G-06)',
   'every non-mechanic dependency id; No orphans)'],
  ['name parity 1:1 — G-05)',
   'name parity 1:1 — §C parity)'],
  ['must fail G-10',
   'must fail Persistence coverage'],
  ['- Definition of Done pre-3.14: gate = 14 PASS + G-15 `[PENDING owner=3.14]` only. After 3.14: 15/15 → version 1.0.0 → FINAL.',
   '- Definition of Done pre-3.14: every item of the standard\'s gate table PASS except the roadmap seam, which may stand as `[PENDING owner=3.14]`. After 3.14 closes it: all PASS → version 1.0.0 → FINAL. The number of gates is whatever the standard\'s table below declares — never a count carried from elsewhere.'],
  ['- **G-08 is FAIL, never WARN, never softened:**',
   '- **A deprecated marker is FAIL, never WARN, never softened:**'],
  ['Certify **G-08 FAIL** and name node **3.2**',
   'Certify that gate **FAIL** and name node **3.2**'],
  ['A single deprecated marker anywhere in the assembled document = G-08 FAIL.',
   'A single deprecated marker anywhere in the assembled document fails that gate.'],
  ['do NOT downgrade G-08 to WARN',
   'do NOT downgrade it to WARN'],
]

;(async () => {
  const template = fs.readFileSync(RUTA, 'utf8')
  let mapeo = fs.readFileSync(BASE, 'utf8')
  const antes = (mapeo.match(/G-\d\d/g) || []).length
  console.log(`mapeo original: ${mapeo.length} chars · ${antes} referencias a un número de gate\n`)

  let sinTocar = 0
  for (const [de, a] of CAMBIOS) {
    const n = mapeo.split(de).length - 1
    if (!n) { console.log(`  ⚠ no encontrado: «${de.slice(0, 60)}»`); sinTocar++; continue }
    mapeo = mapeo.split(de).join(a)
  }
  const quedan = mapeo.match(/G-\d\d/g) || []
  console.log(`\npatrones sin encontrar: ${sinTocar}`)
  console.log(`referencias que quedan en el mapeo: ${quedan.length}${quedan.length ? ' → ' + [...new Set(quedan)].join(' ') : ''}`)
  if (quedan.length) {
    for (const l of mapeo.split('\n')) if (/G-\d\d/.test(l)) console.log(`   ${l.trim().slice(0, 130)}`)
  }

  const nuevo = mapeo.trimEnd()
    + '\n\n---\n\n'
    + '# THE STANDARD ITSELF\n\n'
    + 'Everything above says WHERE each slot comes from, and names gates by their NAME on purpose. '
    + 'What follows is the standard being populated, verbatim.\n\n'
    + '**The gate table below is the only gate numbering there is.** G-01 through G-18 with these '
    + 'exact meanings and this exact order. Reproduce it whole: do not renumber it, do not drop '
    + 'rows, do not append your own, and do not carry a numbering from any other document or from '
    + 'a previous version of this one. A document certified against a different numbering cannot '
    + 'be reviewed against this standard — a reviewer reading "G-11 PASS" must be reading about '
    + 'the same gate the table calls G-11.\n\n'
    + 'Reproduce every section and every table row of the structure below. A table the standard '
    + 'declares is not satisfied by a paragraph covering the same ground: §11.5 asks for Control '
    + 'mode and In-play camera as `[REQUIRED]` rows, and prose about movement leaves both '
    + 'unfilled.\n\n'
    + '---\n\n'
    + template.trim() + '\n'

  const gt = [...new Set(template.match(/G-\d\d/g) || [])].sort()
  const gn = [...new Set(nuevo.match(/G-\d\d/g) || [])].sort()
  console.log(`\nresultado: ${nuevo.length} chars · sha ${sha(nuevo)}`)
  console.log(`  gates del estándar: ${gt.length} · gates en el skill entero: ${gn.length} · ${gt.join(' ') === gn.join(' ') ? '✓ mismos' : '✗ hay de más: ' + gn.filter(x => !gt.includes(x)).join(' ')}`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const { data: cfg } = await db().from('forge_skill_configs').select('r2_path').eq('key', CLAVE).single()
  const c = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.CF_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
    },
  })
  await c.send(new PutObjectCommand({
    Bucket: process.env.CF_R2_PROMPTS_BUCKET, Key: cfg.r2_path,
    Body: nuevo, ContentType: 'text/markdown; charset=utf-8',
  }))

  ps.invalidatePrompts?.()
  const releido = await ps.getSkill(CLAVE)
  console.log(`\n=== verificación ===`)
  console.log(`  releído de R2: ${releido.length} chars · idéntico: ${releido === nuevo}`)
  const fuera = releido.slice(0, releido.indexOf('# THE STANDARD ITSELF'))
  console.log(`  referencias a un número FUERA de la tabla del estándar: ${(fuera.match(/G-\d\d/g) || []).length}`)
  console.log('\nLos skills se cachean: reiniciar el back para que lo tome.')
})()
