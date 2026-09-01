// Aplica la entrega v2.9.24 (HeadingCollision): 1 fila de ADN (2.2) + 1 skill parcheado.
//
// Cierra el hallazgo del 01-09: el 2.2 no emitía concept_data ni concept_document porque el
// SECTION CONTRACT reserva '## ' para la clave del output mientras el prompt de concept_document
// —y el skill— mandaban '## ' para las diez secciones de la plantilla. Dos órdenes incompatibles
// sobre el mismo nivel; el modelo obedecía una.
//
// Las DOS capas van juntas por obligación: en Forge el skill gana sobre el prompt (patrón
// MOTOR-1/2), así que con solo la fila de ADN la colisión sobrevive un nivel más abajo.
//
// Se escriben SOLO los campos que cambian —`outputs` y `metadata`—. Nunca la fila entera: el
// full-replace de v2.9.23 iba a revertir 13 executors de MiniMax a Sonnet en silencio.
//
// Uso:  node scripts/aplicar-v2_9_24.js            (simula)
//       node scripts/aplicar-v2_9_24.js --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const ps = require('../src/services/prompt.service')
const { db } = require('../src/services/supabase.service')

const DIR = process.env.V2924_DIR || path.resolve(__dirname,
  '../../../../AppData/Local/Temp/claude/C--Users-Admin-Documents-V57-Studio-Forge/da14a22a-81f0-4a69-8c7d-14af2e78aa1f/scratchpad/v2924/Forge_v2.9.24')
const APLICAR = process.argv.includes('--apply')

const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
// El export entrega los jsonb como TEXTO. Comparar sin desenvolver marca como distinto lo que es
// idéntico — pasó el 05-ago con inject_config.
const val = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }

;(async () => {
  const man = JSON.parse(fs.readFileSync(path.join(DIR, 'MOTOR-3_MANIFEST.json'), 'utf8'))
  const j = JSON.parse(fs.readFileSync(path.join(DIR, 'nodes_v2.9.24.json'), 'utf8'))
  const fila = (Array.isArray(j) ? j : (j.nodes || j.rows))[0]
  const parche = fs.readFileSync(path.join(DIR, 'v57_concept_treatment_template.md'), 'utf8')

  const { data: viva } = await db().from('forge_nodes').select('*').eq('node_key', '2.2').single()

  // ── Puertas: si algo no cuadra, no se escribe nada ──────────────────────────
  const problemas = []
  if (fila.node_key !== '2.2') problemas.push(`la fila no es del 2.2 (${fila.node_key})`)
  if (JSON.stringify(val(fila.executor)) !== JSON.stringify(val(viva.executor)))
    problemas.push(`el executor cambiaría: ${JSON.stringify(val(viva.executor))} → ${JSON.stringify(val(fila.executor))}`)
  if (fila.default_prompt !== viva.default_prompt) problemas.push('el default_prompt cambiaría')

  const vivoSkill = await ps.getSkill(man.skill)
  if (!vivoSkill) problemas.push(`no se pudo leer el skill vivo "${man.skill}"`)
  else if (sha256(vivoSkill) !== man.base_sha256)
    problemas.push(`el skill vivo NO es la base del manifiesto\n     vivo: ${sha256(vivoSkill)}\n     base: ${man.base_sha256}`)
  if (sha256(parche) !== man.patched_sha256) problemas.push('el archivo del parche no coincide con patched_sha256')

  const clavesA = (val(viva.outputs) || []).map(o => o.key || o.name)
  const clavesB = (val(fila.outputs) || []).map(o => o.key || o.name)
  if (clavesA.join('|') !== clavesB.join('|'))
    problemas.push(`cambian las claves de output: ${clavesA.join(', ')} → ${clavesB.join(', ')}`)

  console.log('=== estado ===')
  console.log(`  fila 2.2 · outputs ${JSON.stringify(val(viva.outputs)).length} → ${JSON.stringify(val(fila.outputs)).length} chars`)
  console.log(`  dna_version ${val(viva.metadata)?.dna_version} → ${val(fila.metadata)?.dna_version}`)
  console.log(`  executor conservado: ${JSON.stringify(val(viva.executor))}`)
  console.log(`  skill "${man.skill}" · vivo ${vivoSkill?.length} chars → parche ${parche.length} chars`)
  const cuenta = t => `${(t.match(/^##[ \t]/gm) || []).length} '##' / ${(t.match(/^###[ \t]/gm) || []).length} '###'`
  console.log(`  encabezados · vivo ${cuenta(vivoSkill || '')} → parche ${cuenta(parche)}`)

  if (problemas.length) {
    console.error('\n*** NO SE APLICA ***')
    for (const p of problemas) console.error(`  · ${p}`)
    process.exit(1)
  }
  console.log('\ntodas las puertas pasan.')

  // ── Respaldo del vivo, siempre ──────────────────────────────────────────────
  const bdir = path.resolve(__dirname, '../../_Prod/backups')
  fs.mkdirSync(bdir, { recursive: true })
  fs.writeFileSync(path.join(bdir, 'nodo_2.2_pre_v2.9.24.json'), JSON.stringify(viva, null, 2))
  fs.writeFileSync(path.join(bdir, `${man.skill}_pre_v2.9.24.md`), vivoSkill)
  console.log(`respaldos → ${bdir}`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  // ── 1 · la fila, solo los campos que cambian ────────────────────────────────
  const { error: e1 } = await db().from('forge_nodes')
    .update({ outputs: val(fila.outputs), metadata: val(fila.metadata) })
    .eq('node_key', '2.2')
  if (e1) { console.error('fallo al escribir la fila:', e1.message); process.exit(1) }

  // ── 2 · el skill a R2 ───────────────────────────────────────────────────────
  const { data: cfg } = await db().from('forge_skill_configs').select('r2_path').eq('key', man.skill).single()
  const c = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.CF_R2_ACCESS_KEY_ID, secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY },
  })
  await c.send(new PutObjectCommand({
    Bucket: process.env.CF_R2_PROMPTS_BUCKET, Key: cfg.r2_path,
    Body: parche, ContentType: 'text/markdown; charset=utf-8',
  }))

  // ── 3 · relectura: lo escrito es lo que se pidió ────────────────────────────
  ps.invalidatePrompts?.()
  const { data: rel } = await db().from('forge_nodes').select('outputs,metadata,executor,default_prompt').eq('node_key', '2.2').single()
  const outsOk = JSON.stringify(val(rel.outputs)) === JSON.stringify(val(fila.outputs))
  const relSkill = await ps.getSkill(man.skill)

  console.log('\n=== verificación ===')
  console.log(`  outputs idénticos al delta: ${outsOk}`)
  console.log(`  dna_version: ${val(rel.metadata)?.dna_version}`)
  console.log(`  executor: ${JSON.stringify(val(rel.executor))}`)
  console.log(`  default_prompt intacto: ${rel.default_prompt === viva.default_prompt}`)
  console.log(`  skill releído: ${relSkill?.length} chars · sha ${sha256(relSkill || '')}`)
  console.log(`  == patched_sha256: ${sha256(relSkill || '') === man.patched_sha256}`)
  for (const o of val(rel.outputs) || []) {
    const k = o.key || o.name
    if (o.image_gen) continue
    console.log(`  ${k}: su prompt nombra '## ${k}' → ${(o.prompt || '').includes('## ' + k)}`)
  }
  console.log('\nLos skills se cachean en memoria del proceso: REINICIAR EL BACK para que lo tome.')
})()
