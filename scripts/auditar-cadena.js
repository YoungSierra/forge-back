// Auditoría de una cadena de nodos en un proyecto: qué produjo cada uno, qué le llega, y dónde
// están los huecos. NO gasta crédito ni escribe nada — solo lee.
//
// Uso: node scripts/auditar-cadena.js <project_id> [1.1,1.2,1.3,1.4,2.1,2.2]
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { resolveNodeInputs } = require('../src/services/canvas-chat.service')
const { parseOutputItems, tieneEntidades } = require('../src/services/image-gen.service')

const P = process.argv[2]
const CADENA = (process.argv[3] || '1.1,1.2,1.3,1.4,2.1,2.2').split(',')
if (!P) { console.error('falta el project_id'); process.exit(1) }

const huecos = []
const anotar = (nodo, sev, texto) => huecos.push({ nodo, sev, texto })

;(async () => {
  const { data: proj } = await db().from('projects').select('name').eq('id', P).single()
  console.log(`\n══════ ${proj.name} ══════`)

  const { data: nodes } = await db().from('forge_nodes').select('id, node_key, title, inputs, outputs')
  const porKey = new Map(nodes.map(n => [n.node_key, n]))
  const byId   = new Map(nodes.map(n => [n.id, n]))

  const { data: pns } = await db().from('forge_project_nodes')
    .select('id, node_id, node_type, text_label').eq('project_id', P).eq('removed', false)
  const pnDe = k => pns.find(p => byId.get(p.node_id)?.node_key === k)

  const { data: edges } = await db().from('forge_project_edges')
    .select('source_node_id, target_node_id, source_handle, target_handle').eq('project_id', P)

  for (const k of CADENA) {
    const n = porKey.get(k)
    if (!n) { anotar(k, 'ALTO', 'el nodo no existe en el catálogo'); continue }
    const pn = pnDe(k)
    console.log(`\n──────── ${k} · ${n.title} ────────`)
    if (!pn) { anotar(k, 'ALTO', 'el nodo NO está en el canvas del proyecto'); console.log('   NO está en el proyecto'); continue }

    // ── outputs declarados vs producidos ──
    const declarados = (n.outputs || []).map(o => ({ k: o.key || o.name, ...o }))
    const { data: ss } = await db().from('forge_sessions')
      .select('id, output_key, status, output_asset_id, output_images')
      .eq('project_id', P).eq('node_id', n.id)
    const aprobadas = ss.filter(s => ['approved', 'auto_approved'].includes(s.status))
    const entero = aprobadas.find(s => !s.output_key)

    console.log('   outputs:')
    for (const o of declarados) {
      const s = aprobadas.find(x => x.output_key === o.k)
      const cubre = s || entero
      const marca = cubre ? '✔' : (o.production === 'deferred' ? '·' : '✗')
      let extra = ''
      if (o.image_gen) {
        const imgs = Object.values(cubre?.output_images || {}).flat().length
        extra = ` · imágenes: ${imgs}`
      }
      console.log(`     ${marca} ${o.k.padEnd(24)} ${String(o.format || '-').padEnd(12)}${extra}`)
      if (!cubre && o.production !== 'deferred') anotar(k, 'MEDIO', `output "${o.k}" sin producir`)
    }

    // ── inputs declarados vs cableados ──
    const wired = (n.inputs?.wired || []).map(i => i.key || i.name)
    const entrantes = edges.filter(e => e.target_node_id === pn.id)
    const cubiertos = new Set(entrantes.map(e => String(e.target_handle || '').replace(/^in-/, '')))
    const faltantes = wired.filter(w => !cubiertos.has(w) && !cubiertos.has('in') && !cubiertos.has(''))
    console.log(`   inputs cableados: ${entrantes.length}${wired.length ? ` · declarados: ${wired.join(', ')}` : ''}`)
    for (const f of faltantes) {
      const req = (n.inputs?.wired || []).find(i => (i.key || i.name) === f)?.required
      anotar(k, req ? 'ALTO' : 'BAJO', `input "${f}" declarado y SIN cable${req ? ' (requerido)' : ''}`)
      console.log(`     ✗ sin cable: ${f}${req ? ' (requerido)' : ''}`)
    }

    // ── qué le llega de verdad ──
    for (const o of declarados.filter(o => o.uses?.inputs?.length || o.image_gen)) {
      const r = await resolveNodeInputs(db, { projectId: P, currentPNodeId: pn.id, targetOutput: o }).catch(() => [])
      const textos = r.map(String)
      const total = textos.reduce((a, b) => a + b.length, 0)
      const conImagen = textos.filter(t => /\.(png|jpg|webp)/i.test(t)).length
      console.log(`     ${o.k}: ${r.length} input(s) · ${total} chars · con URL de imagen: ${conImagen}`)
      if (o.uses?.inputs?.length && !r.length) anotar(k, 'ALTO', `"${o.k}" declara inputs y no recibe NADA`)
      const cortos = textos.filter(t => t.length > 0 && t.length < 500 && !/\.(png|jpg|webp)/i.test(t))
      if (cortos.length && total < 800) anotar(k, 'MEDIO', `"${o.k}" recibe muy poco (${total} chars)`)
    }

    // ── imágenes: ¿son visibles aguas abajo? ──
    const { data: pngs } = await db().from('forge_assets')
      .select('id').eq('project_id', P).eq('node_id', n.id).eq('format', 'png')
    const enSesion = ss.reduce((a, s) => a + Object.values(s.output_images || {}).flat().length, 0)
    if (enSesion || pngs.length) {
      console.log(`   imágenes: ${enSesion} en la sesión · ${pngs.length} como asset png (lo que ven los nodos de abajo)`)
      if (enSesion && !pngs.length) anotar(k, 'ALTO', `${enSesion} imagen(es) invisibles aguas abajo: existen en output_images pero no como asset png`)
    }

    // ── el contenido aprobado: ¿se parsea en entidades? ──
    for (const o of declarados.filter(o => o.image_gen)) {
      const s = aprobadas.find(x => x.output_key === o.k) || entero
      if (!s?.output_asset_id) continue
      const { data: a } = await db().from('forge_assets').select('content').eq('id', s.output_asset_id).maybeSingle()
      if (!a?.content) continue
      const items = parseOutputItems(a.content, o.format, o.k)
      const hay = tieneEntidades(a.content, o.format, o.k)
      console.log(`     ${o.k}: ${items.length} ítem(s) ilustrables · tieneEntidades=${hay}`)
    }
  }

  console.log('\n\n════════ HUECOS ════════')
  const orden = { ALTO: 0, MEDIO: 1, BAJO: 2 }
  huecos.sort((a, b) => orden[a.sev] - orden[b.sev])
  if (!huecos.length) console.log('  ninguno')
  for (const h of huecos) console.log(`  [${h.sev.padEnd(5)}] ${h.nodo.padEnd(5)} ${h.texto}`)
  console.log(`\n  total: ${huecos.length}`)
})()
