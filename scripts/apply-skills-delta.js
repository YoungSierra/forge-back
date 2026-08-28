// Sube skills parcheados a R2 con el lock de sha256 que exige el delta: el archivo VIVO debe
// coincidir con `base_sha256` (o con `alt_base_sha256_*`) antes de sobrescribirlo. Cualquier otro
// hash significa que la fuente derivó desde que se construyó el parche → se detiene sin escribir.
//
// Escribe por la MISMA ruta que lee la app (bucket CF_R2_PROMPTS_BUCKET vía forge_skill_configs).
// La URL pública de R2 devuelve otro objeto para la misma clave — no sirve para esto.
//
// Uso:  node scripts/apply-skills-delta.js <dir_con_MANIFEST.json>            (verifica y simula)
//       node scripts/apply-skills-delta.js <dir> --apply --backup=<carpeta>
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const ps = require('../src/services/prompt.service')
const { db } = require('../src/services/supabase.service')

const DIR     = process.argv[2]
const APLICAR = process.argv.includes('--apply')
const BACKUP  = process.argv.find(a => a.startsWith('--backup='))?.split('=')[1]
if (!DIR) { console.error('uso: <dir_con_MANIFEST.json> [--apply] [--backup=carpeta]'); process.exit(1) }

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const cliente = () => new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.CF_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
  },
})

;(async () => {
  const man = JSON.parse(fs.readFileSync(path.join(DIR, 'MANIFEST.json'), 'utf8'))
  console.log(`${man.id}\n${man.files.length} skill(s)\n`)

  const listos = []
  let fallos = 0

  for (const f of man.files) {
    const { data: cfg, error } = await db().from('forge_skill_configs').select('r2_path').eq('key', f.skill).single()
    if (error || !cfg?.r2_path) { console.error(`  ✗ ${f.skill}: no está en forge_skill_configs`); fallos++; continue }

    const vivo   = await ps.getSkill(f.skill)
    const hVivo  = sha(vivo)
    const parche = fs.readFileSync(path.join(DIR, f.skill + '.md'), 'utf8')
    const hParche = sha(parche)

    const base = hVivo === f.base_sha256
    const alt  = f.alt_base_sha256_if_T1rev_already_applied && hVivo === f.alt_base_sha256_if_T1rev_already_applied

    if (!base && !alt) {
      console.error(`  ✗ ${f.skill}: la fuente viva NO coincide con la base del parche`)
      console.error(`      vivo     ${hVivo}`)
      console.error(`      esperado ${f.base_sha256}`)
      fallos++; continue
    }
    if (hParche !== f.patched_sha256) {
      console.error(`  ✗ ${f.skill}: el archivo entregado no coincide con su propio manifiesto`)
      fallos++; continue
    }

    console.log(`  ✔ ${f.skill.padEnd(36)} ${vivo.length} → ${parche.length} chars  · ${base ? 'base' : 'alt-base'} · ${cfg.r2_path}`)
    f.changes?.forEach(c => console.log(`       · ${c}`))
    listos.push({ ...f, r2_path: cfg.r2_path, vivo, parche })
  }

  if (fallos) { console.error(`\nDETENIDO: ${fallos} problema(s). No se escribió nada.`); process.exit(1) }

  if (BACKUP) {
    fs.mkdirSync(BACKUP, { recursive: true })
    listos.forEach(f => fs.writeFileSync(path.join(BACKUP, f.skill + '.md'), f.vivo))
    console.log(`\nrespaldo de los ${listos.length} vivos → ${BACKUP}`)
  }
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  const c = cliente()
  const bucket = process.env.CF_R2_PROMPTS_BUCKET
  for (const f of listos) {
    await c.send(new PutObjectCommand({
      Bucket: bucket, Key: f.r2_path, Body: f.parche, ContentType: 'text/markdown; charset=utf-8',
    }))
  }

  console.log('\n=== verificación posterior (relectura desde R2) ===')
  ps.invalidatePrompts?.()
  let mal = 0
  for (const f of listos) {
    const releido = await ps.getSkill(f.skill)
    const ok = sha(releido) === f.patched_sha256
    if (!ok) mal++
    console.log(`  ${ok ? '✔' : '✗'} ${f.skill.padEnd(36)} ${releido.length} chars`)
  }
  console.log(mal ? `\n⚠ ${mal} no coinciden tras subir` : '\nlos 7 quedaron idénticos al parche')
  console.log('\nRecordar: los skills se cachean en memoria — reiniciar el back para que corra con esto.')
})()
