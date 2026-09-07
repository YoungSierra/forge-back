// El Art Bible carga páginas del ASG citándolas «ASG · 05 Character Design Language». Hasta hoy
// se resolvían por NÚMERO, y el número no sobrevive una restructura: con el maestro de 25 páginas
// veintidós de las veintiséis cargarían la página equivocada, sin que nada avise.
//
// Esto comprueba las dos cosas a la vez:
//   1 · en los decks YA renderizados (los de 34 páginas), nombre y número tienen que dar la MISMA
//       imagen — si no, el cambio es una regresión y no un arreglo;
//   2 · contra el maestro de 25, cuántas citas encuentran su página por nombre y cuáles quedaron
//       sin fuente porque Miguel eliminó esa lámina.
//
// Uso:  node scripts/preflight-asg-por-nombre.js
require('dotenv').config()
const { db } = require('../src/services/supabase.service')
const { paginaDelASG } = require('../src/services/image-gen.service')

const RX = /Art Style Guide \(ASG\s*[·.\-]?\s*(\d{1,2})\s*([^)]*)\)/i
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

;(async () => {
  const { data: ab } = await db().from('comfyui_workflows')
    .select('workflow_json,inject_config').eq('name', 'V57_STUDIO_ArtBible_Template').maybeSingle()
  if (!ab) return console.error('no está registrado V57_STUDIO_ArtBible_Template')
  const wf = typeof ab.workflow_json === 'string' ? JSON.parse(ab.workflow_json) : ab.workflow_json
  const cfg = typeof ab.inject_config === 'string' ? JSON.parse(ab.inject_config) : ab.inject_config

  const citas = []
  for (const p of cfg.pages) {
    const m = RX.exec(String(wf[p.prompt_node]?.inputs?.prompt || ''))
    if (m) citas.push({ pagina: p.name, num: m[1], nombre: (m[2] || '').trim() })
    else citas.push({ pagina: p.name, num: null, nombre: null })
  }
  console.log(`Art Bible: ${cfg.pages.length} páginas · ${citas.filter(c => c.num).length} citan al ASG`
    + ` · ${citas.filter(c => c.nombre).length} con nombre\n`)

  // ── 1 · Sin regresión sobre lo ya renderizado ───────────────────────────────
  const { data: n320 } = await db().from('forge_nodes').select('id').eq('node_key', '3.20').maybeSingle()
  const { data: ses } = await db().from('forge_sessions').select('project_id').eq('node_id', n320.id)
  const proyectos = [...new Set((ses || []).map(s => s.project_id))]

  let comparadas = 0, iguales = 0
  const distintas = []
  for (const proy of proyectos) {
    for (const c of citas.filter(x => x.nombre)) {
      const porNumero = await paginaDelASG(db, proy, c.num, null)
      const porNombre = await paginaDelASG(db, proy, c.num, c.nombre)
      if (!porNumero && !porNombre) continue
      comparadas++
      if (porNumero === porNombre) iguales++
      else distintas.push({ proy: proy.slice(0, 8), ...c, porNumero, porNombre })
    }
  }
  console.log('1 · sobre los decks YA renderizados (los de 34 páginas):')
  console.log(`    citas resueltas: ${comparadas} · nombre y número dan la misma imagen: ${iguales}`)
  console.log(`    difieren: ${distintas.length}${distintas.length ? '  ← revisar antes de publicar' : '  ✓ sin regresión'}`)
  for (const d of distintas.slice(0, 10)) {
    console.log(`      ${d.proy} ${d.pagina.padEnd(26)} «${d.nombre}»`)
    console.log(`         por número: ${String(d.porNumero).split('/').pop()}`)
    console.log(`         por nombre: ${String(d.porNombre).split('/').pop()}`)
  }

  // ── 2 · Contra el maestro de 25 ────────────────────────────────────────────
  const { data: w25 } = await db().from('comfyui_workflows')
    .select('inject_config').eq('name', 'V57_STUDIO_ArtStyleGuide_Template_25').maybeSingle()
  if (!w25) return console.log('\n2 · el maestro de 25 todavía no está registrado')
  const c25 = typeof w25.inject_config === 'string' ? JSON.parse(w25.inject_config) : w25.inject_config
  const paginas = c25.pages.map(p => ({ nombre: p.name, k: norm(p.name.replace(/^\d+_/, '')) }))

  let aciertan = 0
  const huerfanas = []
  for (const c of citas.filter(x => x.nombre)) {
    const b = norm(c.nombre)
    const exacto = paginas.find(p => p.k === b)
    const pref = paginas.filter(p => b.startsWith(p.k) || p.k.startsWith(b))
    const unico = new Set(pref.map(p => p.k)).size === 1 ? pref[0] : null
    const hit = exacto || unico
    if (hit) { aciertan++; continue }
    huerfanas.push(c)
  }
  console.log(`\n2 · contra el maestro de 25 páginas:`)
  console.log(`    aciertan por nombre: ${aciertan}/${citas.filter(x => x.nombre).length}`)
  console.log(`    sin equivalente: ${huerfanas.length} — son láminas que la restructura eliminó o renombró`)
  for (const h of huerfanas) console.log(`      ✗ ${h.pagina.padEnd(26)} cita «${h.nombre}» (ASG ${h.num} del maestro viejo)`)
})()
