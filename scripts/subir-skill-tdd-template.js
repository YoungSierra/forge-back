// Sube el TDD estándar completo como skill `tdd_template_population`.
//
// Por qué: el equipo validó la salida del 3.12 contra `TDD_Template.md` (27.506 chars, gates
// G-01..G-18) y le puso 6/10. Medido el 31-08, el skill que corría eran 5.856 chars que dicen
// «gate-certifiable (G-01..G-15)» y traen su propia numeración, corrida en uno desde G-07: para
// ese skill G-07 es «Slice closure» y no «Zero pending», G-11 es «Input coverage» y no «UI
// coverage». El modelo cumplió lo que se le dio; nunca vio el estándar.
//
// NO se reemplaza: se SUMA. El skill viejo no era solo un resumen del template — lleva el mapeo
// fuente→sección (§3 ← 3.2 core_loop, §9.1 ← 3.9 ui_screens…) que el template en blanco no tiene
// y sin el cual el modelo no sabe de qué nodo sale cada slot. Se conserva entero y el template va
// debajo, como la estructura literal a poblar.
//
// Uso:  node scripts/subir-skill-tdd-template.js <template.md>            (simula)
//       node scripts/subir-skill-tdd-template.js <template.md> --apply
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
if (!RUTA) { console.error('uso: <template.md> [--apply]'); process.exit(1) }

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)
const gates = s => [...new Set(s.match(/G-\d\d/g) || [])].sort()

;(async () => {
  const template = fs.readFileSync(RUTA, 'utf8')
  const vivo = await ps.getSkill(CLAVE)

  console.log(`skill vivo : ${vivo.length} chars · sha ${sha(vivo)} · gates ${gates(vivo).length}`)
  console.log(`template   : ${template.length} chars · sha ${sha(template)} · gates ${gates(template).length}`)

  if (vivo.includes('# Game TDD — Template')) {
    console.log('\nel skill YA contiene el template — nada que hacer.')
    return
  }

  const nuevo = vivo.trimEnd()
    + '\n\n---\n\n'
    + '# THE STANDARD ITSELF\n\n'
    + 'Everything above says WHERE each slot comes from. What follows is the standard being '
    + 'populated, verbatim: its sections, its tables, its per-field `[REQUIRED]` / `[RECOMMENDED]` '
    + 'marks, and its Completeness Gate. **The gate table below is the gate table — G-01 through '
    + 'G-18 with these exact meanings.** Do not renumber it, do not shorten it, and do not invent '
    + 'a gate set of your own: a document certified against a different numbering cannot be '
    + 'reviewed against this one.\n\n'
    + 'Reproduce every section and every table row of the structure below. A table the standard '
    + 'declares is not satisfied by a paragraph covering the same ground: §11.5 asks for Control '
    + 'mode and In-play camera as `[REQUIRED]` rows, and prose about movement leaves both unfilled.\n\n'
    + '---\n\n'
    + template.trim() + '\n'

  console.log(`\nresultado: ${nuevo.length} chars · gates ${gates(nuevo).join(' ')}`)
  console.log(`crecimiento del system prompt del 3.12: +${nuevo.length - vivo.length} chars ≈ +${Math.round((nuevo.length - vivo.length) / 4)} tokens`)

  const dir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, `${CLAVE}_pre_template_20260831.md`)
  fs.writeFileSync(f, vivo)
  console.log(`respaldo del vivo → ${f}`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const { data: cfg } = await db().from('forge_skill_configs').select('r2_path').eq('key', CLAVE).single()
  if (!cfg?.r2_path) { console.error(`${CLAVE}: no está en forge_skill_configs`); process.exit(1) }

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
  console.log(`  gates: ${gates(releido).join(' ')}`)
  console.log('\nLos skills se cachean en memoria: reiniciar el back para que lo tome.')
})()
