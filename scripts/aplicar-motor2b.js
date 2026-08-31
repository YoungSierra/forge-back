// Aplica una spec de patrones exactos sobre un skill VIVO de R2 (MOTOR-2b y sucesores).
// A diferencia de un delta de archivos, aquí no hay base que comparar: la spec reemplaza cadenas
// byte a byte sobre lo que haya, y reporta cuántas veces encontró cada una. Cero es legal — la
// fuente pudo derivar y haber perdido esa frase.
//
// Uso:  node scripts/aplicar-motor2b.js <spec.json>            (simula)
//       node scripts/aplicar-motor2b.js <spec.json> --apply --backup=<carpeta>
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const ps = require('../src/services/prompt.service')
const { db } = require('../src/services/supabase.service')

const SPEC    = process.argv[2]
const APLICAR = process.argv.includes('--apply')
const BACKUP  = process.argv.find(a => a.startsWith('--backup='))?.split('=')[1]
if (!SPEC) { console.error('uso: <spec.json> [--apply] [--backup=carpeta]'); process.exit(1) }

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

;(async () => {
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'))
  // La clave del skill sale del campo `layer`: "skill in R2 — <clave> (…)"
  const clave = /—\s*([a-z0-9_]+)/i.exec(spec.layer)?.[1]
  if (!clave) { console.error('no pude leer la clave del skill en `layer`'); process.exit(1) }

  const { data: cfg } = await db().from('forge_skill_configs').select('r2_path').eq('key', clave).single()
  if (!cfg?.r2_path) { console.error(`${clave}: no está en forge_skill_configs`); process.exit(1) }

  const vivo = await ps.getSkill(clave)
  console.log(`${spec.id} · ${clave}`)
  console.log(`vivo: ${vivo.length} chars · sha ${sha(vivo).slice(0, 12)}…`)

  // El orden importa: la spec lo dice porque los patrones cortos se comerían los ids que viven
  // dentro de los largos. Se respeta el que declara, pero SIEMPRE se aplican todos: leer solo lo
  // que menciona `order` dejaba fuera los que abrevia («P3a/b/c») y el residuo quedaba a medias.
  const mencionados = [...new Set((spec.order || '').match(/P[0-9a-c]+/g) || [])]
    .filter(id => spec.patterns.some(p => p.id === id))
  const orden = [...mencionados, ...spec.patterns.map(p => p.id).filter(id => !mencionados.includes(id))]
  console.log(`orden de aplicación: ${orden.join(' → ')}`)

  let txt = vivo
  for (const id of orden) {
    const p = spec.patterns.find(x => x.id === id)
    if (!p) continue
    const n = txt.split(p.old).length - 1
    console.log(`  ${id.padEnd(4)} ${String(n).padStart(2)} coincidencia(s)`)
    if (n) txt = txt.split(p.old).join(p.new)
  }

  const residuo = txt.split('\n').filter(l => /image_wide|image_interior|image_object/.test(l))
  console.log(`\nresultado: ${txt.length} chars · residuo de ids fantasma: ${residuo.length}`)
  residuo.forEach(l => console.log(`   ${l.trim().slice(0, 150)}`))

  if (txt === vivo) { console.log('\nnada que cambiar.'); return }

  if (BACKUP) {
    fs.mkdirSync(BACKUP, { recursive: true })
    fs.writeFileSync(path.join(BACKUP, clave + '.md'), vivo)
    console.log(`\nrespaldo del vivo → ${path.join(BACKUP, clave + '.md')}`)
  }
  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

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
    Body: txt, ContentType: 'text/markdown; charset=utf-8',
  }))

  ps.invalidatePrompts?.()
  const releido = await ps.getSkill(clave)
  console.log(`\n=== verificación posterior ===`)
  console.log(`  releído de R2: ${releido.length} chars · idéntico: ${releido === txt}`)
  console.log('\nRecordar: los skills se cachean — reiniciar el back.')
})()
