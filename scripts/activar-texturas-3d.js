// Puntos 5 y 6 del informe v3 de Miguel: los workflows 3D de Props y Environments salen sin
// textura porque su nodo Tripo está en "Geometry only". Se copia la configuración del de
// Characters, que sí texturiza.
//
// Copia los campos de textura tal cual los tiene Characters, ni uno más: el nodo de Characters es
// TripoP1MultiviewToModelNode y el de Props/Environments es TripoP1ImageToModelNode, así que solo
// se tocan las claves de texturizado y se deja intacto todo lo demás (image, face_limit, seeds).
//
// AVISO DE COSTO: texturizar en Tripo cuesta más que producir solo geometría, y afecta a TODA
// corrida de esos dos workflows desde que se aplica. El equipo lo aceptó por escrito en el informe.
//
// Uso:  node scripts/activar-texturas-3d.js                (simula)
//       node scripts/activar-texturas-3d.js --apply        (escribe, con respaldo en _Prod/backups)
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { db } = require('../src/services/supabase.service')

const APLICAR = process.argv.includes('--apply')
const FUENTE  = 'V57_STUDIO_3D_Production_Characters'
const DESTINO = ['V57_STUDIO_3D_Production_Props', 'V57_STUDIO_3D_Production_Environment']
const CAMPOS  = ['output_mode', 'output_mode.pbr', 'output_mode.orientation',
                 'output_mode.texture_seed', 'output_mode.texture_quality', 'output_mode.texture_alignment']

const esTripo = n => /^TripoP1.*ToModelNode$/.test(n.class_type || '')
const leer    = w => typeof w.workflow_json === 'string' ? JSON.parse(w.workflow_json) : w.workflow_json

;(async () => {
  const { data: wfs } = await db().from('comfyui_workflows')
    .select('id,name,workflow_json').in('name', [FUENTE, ...DESTINO])

  const fuente = wfs.find(w => w.name === FUENTE)
  if (!fuente) { console.error(`no encontré ${FUENTE}`); process.exit(1) }
  const jf = leer(fuente)
  const nodoF = Object.entries(jf).find(([, n]) => esTripo(n))
  if (!nodoF) { console.error(`${FUENTE} no tiene nodo Tripo`); process.exit(1) }

  const receta = {}
  for (const c of CAMPOS) {
    if (!(c in nodoF[1].inputs)) { console.error(`la fuente no declara ${c} — abortado`); process.exit(1) }
    receta[c] = nodoF[1].inputs[c]
  }
  console.log(`fuente: ${FUENTE} · nodo ${nodoF[0]} · ${nodoF[1].class_type}`)
  Object.entries(receta).forEach(([k, v]) => console.log(`   ${k.padEnd(30)} ${JSON.stringify(v)}`))

  if (APLICAR) {
    const dir = path.resolve(__dirname, '../../_Prod/backups')
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, 'comfyui_workflows_pre_texturas_20260831.json')
    fs.writeFileSync(f, JSON.stringify(wfs, null, 2))
    console.log(`\nrespaldo → ${f}`)
  }

  for (const nombre of DESTINO) {
    const w = wfs.find(x => x.name === nombre)
    if (!w) { console.log(`\n${nombre}: NO EXISTE — saltado`); continue }
    const j = leer(w)
    const ent = Object.entries(j).find(([, n]) => esTripo(n))
    if (!ent) { console.log(`\n${nombre}: sin nodo Tripo — saltado`); continue }
    const [id, nodo] = ent
    console.log(`\n── ${nombre} · nodo ${id} · ${nodo.class_type}`)
    let cambios = 0
    for (const [k, v] of Object.entries(receta)) {
      const antes = k in nodo.inputs ? JSON.stringify(nodo.inputs[k]) : '(no estaba)'
      if (JSON.stringify(nodo.inputs[k]) === JSON.stringify(v)) { console.log(`   ${k.padEnd(30)} ya está en ${antes}`); continue }
      console.log(`   ${k.padEnd(30)} ${antes} → ${JSON.stringify(v)}`)
      nodo.inputs[k] = v
      cambios++
    }
    if (!cambios) { console.log('   nada que cambiar'); continue }
    if (!APLICAR) continue

    const { error } = await db().from('comfyui_workflows')
      .update({ workflow_json: j, updated_at: new Date().toISOString() }).eq('id', w.id)
    if (error) { console.log(`   ✗ ${error.message}`); continue }

    // Releer y comprobar que quedó escrito: un update silencioso deja el workflow como estaba y
    // la textura no aparece hasta que alguien la busca en una corrida que ya se pagó.
    const { data: rel } = await db().from('comfyui_workflows').select('workflow_json').eq('id', w.id).single()
    const jr = typeof rel.workflow_json === 'string' ? JSON.parse(rel.workflow_json) : rel.workflow_json
    const ok = Object.entries(receta).every(([k, v]) => JSON.stringify(jr[id].inputs[k]) === JSON.stringify(v))
    console.log(`   ${ok ? '✓ escrito y verificado' : '✗ releído y NO coincide'}`)
  }

  if (!APLICAR) console.log('\n(simulación — usar --apply para escribir)')
})()
