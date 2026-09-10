// Registra una skill: sube el archivo a R2 y deja su fila en `forge_skill_configs`.
//
// El motor resuelve una skill por su clave contra esa tabla, y de ahí saca la ruta en R2. Las 113
// que existen siguen la convención `skills/<clave>.md`; esto la respeta para que el catálogo se
// pueda seguir leyendo de un vistazo.
//
// Se registra el CONTENIDO, no una referencia al archivo local: lo que corre en producción tiene
// que poder editarse sin desplegar, que es la razón por la que las skills viven en R2 y no en el
// repositorio.
//
// Uso:  node scripts/registrar-skill.js <archivo.md> [clave] [--apply]
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3')
const { db } = require('../src/services/supabase.service')

const RUTA = process.argv[2]
const APLICAR = process.argv.includes('--apply')
const CLAVE = (process.argv[3] && !process.argv[3].startsWith('--'))
  ? process.argv[3]
  : path.basename(RUTA || '', '.md')

if (!RUTA) {
  console.error('uso: node scripts/registrar-skill.js <archivo.md> [clave] [--apply]')
  process.exit(1)
}

const BUCKET = process.env.CF_R2_PROMPTS_BUCKET
const cliente = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CF_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
  },
})

;(async () => {
  const texto = fs.readFileSync(RUTA, 'utf8')
  const r2Path = `skills/${CLAVE}.md`

  // El frontmatter es lo que hace legible el catálogo; una skill sin `name` ni `description` se
  // vuelve imposible de encontrar cuando son ciento y pico.
  const fm = /^---\n([\s\S]*?)\n---/.exec(texto)
  const nombre = fm && /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()
  const desc = fm && /^description:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()

  console.log(`clave:   ${CLAVE}`)
  console.log(`archivo: ${RUTA} (${(texto.length / 1024).toFixed(1)} KB)`)
  console.log(`destino: s3://${BUCKET}/${r2Path}`)
  console.log(`frontmatter: name=${nombre || '—'} · description=${desc ? desc.slice(0, 60) + '…' : '—'}`)
  if (nombre && nombre !== CLAVE) console.warn(`  ⚠ el frontmatter dice "${nombre}" y la clave es "${CLAVE}"`)

  const { data: ya } = await db().from('forge_skill_configs').select('key,r2_path').eq('key', CLAVE).maybeSingle()
  let existeEnR2 = false
  try { await cliente.send(new HeadObjectCommand({ Bucket: BUCKET, Key: r2Path })); existeEnR2 = true } catch { /* no está */ }
  console.log(`\nfila en la tabla: ${ya ? 'ya existe → se actualiza' : 'no existe → se crea'}`)
  console.log(`archivo en R2:    ${existeEnR2 ? 'ya existe → se sobrescribe' : 'no existe → se sube'}`)

  if (!APLICAR) return console.log('\n(simulación — usar --apply para escribir)')

  await cliente.send(new PutObjectCommand({
    Bucket: BUCKET, Key: r2Path, Body: texto, ContentType: 'text/markdown; charset=utf-8',
  }))

  const fila = { key: CLAVE, r2_path: r2Path }
  const { error } = ya
    ? await db().from('forge_skill_configs').update(fila).eq('key', CLAVE)
    : await db().from('forge_skill_configs').insert(fila)
  if (error) { console.error(error.message); process.exit(1) }

  // Verificación por el mismo camino que usa el motor, no por el que se acaba de escribir.
  const { getSkill } = require('../src/services/prompt.service')
  const leido = await getSkill(CLAVE)
  console.log(`\n=== verificación ===`)
  console.log(`  getSkill("${CLAVE}") → ${leido ? `${leido.length} chars` : 'NULL'}`)
  console.log(`  ${leido === texto ? '✓ idéntico al archivo' : '✗ lo leído NO coincide con lo subido'}`)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
