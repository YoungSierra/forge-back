// Publica en R2 un prototipo jugable exportado por Prototype Laboratory, para que se pueda abrir
// desde internet con un enlace.
//
// El export es estático de punta a punta —html, módulos ES y three.js vendorizado, sin build y sin
// servidor— así que R2 lo sirve tal cual. Es distinto del WebGL de Unity que vive en Vercel: aquel
// necesita cabeceras `Content-Encoding: br` que un bucket no pone.
//
// LA TRAMPA. El export importa todo desde la RAÍZ DEL SITIO («/runtime/Engine.js»). Bajo un
// prefijo, el navegador pediría esos módulos a la raíz del bucket y la pantalla quedaría en negro,
// con el fallo visible solo en la consola. Se resuelve con un import map en el index.html, que
// reescribe los prefijos sin tocar una línea del código generado. Antes de subir se comprueba que
// el index lo traiga y que ningún módulo quede apuntando a la raíz.
//
// El Content-Type importa tanto como el contenido: un .js servido como octet-stream no lo ejecuta
// el navegador, y el módulo falla sin más explicación.
//
// Uso:  node scripts/publicar-prototipo.js <carpeta> <prefijo>            (simula)
//       node scripts/publicar-prototipo.js <carpeta> <prefijo> --apply
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { uploadToStorage } = require('../src/services/storage.service')

const [, , CARPETA, PREFIJO] = process.argv
const APLICAR = process.argv.includes('--apply')
if (!CARPETA || !PREFIJO) {
  console.error('uso: node scripts/publicar-prototipo.js <carpeta> <prefijo> [--apply]')
  process.exit(1)
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
}

// Lo que no va a un enlace público. `server.mjs` y el README solo sirven para correrlo en local, y
// el TDD es un documento interno de diseño: publicarlo lo deja legible por cualquiera con la URL.
const EXCLUIR = [/(^|[\\/])server\.mjs$/i, /(^|[\\/])EXPORT\.json$/i, /(^|[\\/])README\.md$/i,
  /(^|[\\/])\.gitkeep$/i, /(^|[\\/])tdd[\\/]/i]

const listar = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  return e.isDirectory() ? listar(p) : [p]
})

;(async () => {
  const raiz = path.resolve(CARPETA)
  const todos = listar(raiz)
  const archivos = todos.filter(f => !EXCLUIR.some(rx => rx.test(path.relative(raiz, f))))
  const fuera = todos.filter(f => !archivos.includes(f))

  // ── Puerta: el index tiene que existir y ser independiente de dónde viva ────
  const index = path.join(raiz, 'index.html')
  if (!fs.existsSync(index)) { console.error('*** no hay index.html en la carpeta ***'); process.exit(1) }
  const html = fs.readFileSync(index, 'utf8')
  const problemas = []
  if (!/<script type="importmap">/.test(html)) {
    problemas.push('el index.html no trae import map — los módulos que importan desde «/» se pedirían a la raíz del bucket')
  }
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
    problemas.push(`el index.html apunta a «${m[1]}», que bajo un prefijo es la raíz del bucket`)
  }

  console.log(`carpeta : ${raiz}`)
  console.log(`destino : ${(process.env.CF_R2_PUBLIC_URL || '(sin CF_R2_PUBLIC_URL)')}/${PREFIJO}/`)
  console.log(`archivos: ${archivos.length} · ${(archivos.reduce((n, f) => n + fs.statSync(f).size, 0) / 1e6).toFixed(2)} MB\n`)

  const porTipo = {}
  for (const f of archivos) {
    const ext = path.extname(f).toLowerCase()
    porTipo[ext] = (porTipo[ext] || 0) + 1
    if (!TIPOS[ext]) problemas.push(`no sé qué Content-Type darle a «${path.relative(raiz, f)}»`)
  }
  console.log('  por tipo:', Object.entries(porTipo).map(([e, n]) => `${e}×${n}`).join(', '))
  console.log('  se quedan fuera:', fuera.length ? fuera.map(f => path.relative(raiz, f)).join(', ') : '(nada)')

  if (problemas.length) {
    console.error('\n*** NO SE PUBLICA ***')
    for (const p of [...new Set(problemas)]) console.error(`  · ${p}`)
    process.exit(1)
  }
  console.log('\ntodas las puertas pasan: hay index, trae import map y ninguna ruta apunta a la raíz del sitio.')

  if (!APLICAR) return console.log('\n(simulación — usar --apply para subir)')

  let subidos = 0
  let urlIndex = null
  for (const f of archivos) {
    const rel = path.relative(raiz, f).replace(/\\/g, '/')
    const clave = `${PREFIJO}/${rel}`
    const url = await uploadToStorage(fs.readFileSync(f), clave, TIPOS[path.extname(f).toLowerCase()])
    if (rel === 'index.html') urlIndex = url
    subidos++
    if (subidos % 10 === 0 || rel === 'index.html') console.log(`  ${String(subidos).padStart(3)}/${archivos.length}  ${rel}`)
  }

  // Se verifica contra la URL PÚBLICA, no contra el bucket: lo que importa no es que el objeto
  // exista sino que internet lo sirva, y con el Content-Type correcto — un .js entregado como
  // octet-stream no lo ejecuta el navegador y el módulo falla sin decir por qué.
  console.log('\n=== verificación sobre la URL pública ===')
  const base = `${process.env.CF_R2_PUBLIC_URL}/${PREFIJO}`
  let ok = 0
  const malos = []
  for (const f of archivos) {
    const rel = path.relative(raiz, f).replace(/\\/g, '/')
    const esperado = TIPOS[path.extname(f).toLowerCase()].split(';')[0]
    try {
      const r = await fetch(`${base}/${rel}`, { method: 'HEAD' })
      const tipo = (r.headers.get('content-type') || '').split(';')[0]
      if (r.ok && tipo === esperado) { ok++; continue }
      malos.push(`${rel} → ${r.status} ${tipo || '(sin tipo)'} (se esperaba ${esperado})`)
    } catch (e) { malos.push(`${rel} → ${e.message}`) }
  }
  console.log(`  ${ok}/${archivos.length} responden 200 con el Content-Type correcto`)
  for (const m of malos) console.log(`  ✗ ${m}`)
  console.log(`\n  ${urlIndex}`)
})()
