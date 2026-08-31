// Genera el PDF de pendientes para Pedro (31-08).
// Trampas de pdfkit ya pisadas: dibujar una tabla por columnas deja doc.x al final de la última y
// el párrafo siguiente sale cortado a media palabra — hay que devolverlo al margen.
const PDFDocument = require('pdfkit')
const fs = require('fs')
const path = require('path')

const SALIDA = path.resolve(__dirname, '../../_Prod/Forge_Pendientes_Pedro_31-08.pdf')

const A = '#111827', GRIS = '#4B5563', SUAVE = '#9CA3AF', LINEA = '#E5E7EB', ACENTO = '#B45309'
const doc = new PDFDocument({ size: 'A4', margins: { top: 62, bottom: 62, left: 62, right: 62 } })
doc.pipe(fs.createWriteStream(SALIDA))
const ANCHO = doc.page.width - 124

function h2 (n, t) {
  if (doc.y > doc.page.height - 165) doc.addPage()
  doc.moveDown(0.9)
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(ACENTO).text(`${n} · `, { continued: true })
  doc.fillColor(A).text(t, { width: ANCHO })
  doc.moveDown(0.35)
}
function p (t, opts = {}) {
  doc.font('Helvetica').fontSize(9.8).fillColor(opts.suave ? GRIS : A)
     .text(t, { width: ANCHO, align: 'left', lineGap: 2.4 })
  doc.moveDown(0.4)
}
function mono (t) {
  doc.font('Courier').fontSize(8.6).fillColor(GRIS).text(t, { width: ANCHO, lineGap: 1.8 })
  doc.moveDown(0.4)
}
function regla () {
  doc.moveDown(0.2)
  doc.strokeColor(LINEA).lineWidth(0.7).moveTo(62, doc.y).lineTo(62 + ANCHO, doc.y).stroke()
  doc.moveDown(0.5)
}
function tabla (cols, filas) {
  const anchos = cols.map(c => c.w)
  const y0 = doc.y
  doc.font('Helvetica-Bold').fontSize(8.4).fillColor(SUAVE)
  let x = 62
  cols.forEach((c, i) => { doc.text(c.t.toUpperCase(), x, y0, { width: anchos[i] }); x += anchos[i] })
  doc.y = y0 + 13
  doc.strokeColor(LINEA).lineWidth(0.7).moveTo(62, doc.y - 3).lineTo(62 + ANCHO, doc.y - 3).stroke()
  for (const f of filas) {
    if (doc.y > doc.page.height - 90) doc.addPage()
    const y = doc.y + 3
    let xx = 62, alto = 0
    f.forEach((celda, i) => {
      doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(i === 2 ? GRIS : A)
      alto = Math.max(alto, doc.heightOfString(celda, { width: anchos[i] - 8 }))
      doc.text(celda, xx, y, { width: anchos[i] - 8 })
      xx += anchos[i]
    })
    doc.y = y + alto + 5
    doc.strokeColor('#F3F4F6').lineWidth(0.5).moveTo(62, doc.y - 2).lineTo(62 + ANCHO, doc.y - 2).stroke()
  }
  doc.x = 62
  doc.moveDown(0.6)
}

doc.font('Helvetica-Bold').fontSize(8.5).fillColor(SUAVE).text('FORGE · V57 STUDIO', { characterSpacing: 1.2 })
doc.moveDown(0.5)
doc.font('Helvetica-Bold').fontSize(21).fillColor(A).text('Pendientes para Pedro')
doc.font('Helvetica').fontSize(10).fillColor(GRIS).text('31 de agosto de 2026')
doc.moveDown(0.3)
regla()
p('Seis puntos. El primero es nuevo y es el de fondo; los cuatro siguientes vienen del 28-ago; el último es un aviso.', { suave: true })

h2('1', 'Outputs de texto que nunca salen con su nombre')
p('Corriendo el nodo entero, el modelo funde varios outputs en uno solo. Medido sobre todas las corridas de nodo entero de la base: 421 pares (asset, output), 180 sin su sección. Excluidos los outputs de imagen y los de ensamble, que no escriben prosa.')
p('Diecinueve outputs no han salido ni una sola vez con su nombre:')
tabla(
  [{ t: 'Nodo', w: 62 }, { t: 'Outputs', w: 300 }, { t: 'Corridas', w: 109 }],
  [
    ['2.6', 'review_verdict, strategic_review', '0 de 6'],
    ['2.2', 'concept_data, concept_document', '0 de 5'],
    ['3.4', 'world_lore, environments_x4, dialogue_system', '0 de 4'],
    ['2.7', 'lock_briefing, comparison_deck, locked_concept_package', '0 de 4'],
    ['2.5', 'visual_pitch_plan, investor_deck', '0 de 3'],
    ['3.3', 'progression_sys, economy_design, player_stats', '0 de 3'],
    ['3.2', 'mechanics_engineering', '0 de 3'],
    ['3.1', 'design_pillars_doc', '0 de 3'],
    ['3.5', 'level_map, encounter_design', '0 de 2'],
  ]
)
p('El contenido normalmente sí está, fundido dentro de un hermano. El 3.2 emitió los diez registros de mechanics_engineering dentro de mechanic_specs — io, dependencies, preconditions, state_machine, public_api, components y player_facing, diez bloques de cada uno, confirmado también en el PDF publicado. Lo que falta es la separación, no el trabajo.')
p('De nuestro lado el lector ya tolera las variantes de título: "## Mechanic Specs (TDD §B)", "## Feel Statement (level=mechanics)", los títulos en negrita y el H1 del documento. Lo que no se puede leer es lo que no se emite aparte.')
p('Para reproducirlo:')
mono('node scripts/preflight-secciones.js <project_id>')
p('Carga el extractSection real del front y lo corre contra los assets vivos.', { suave: true })

h2('2', 'approved_images[] no está acotado al lane')
p('El 1.4 emite las dos semillas correctamente, pero cada 2.2 copia el array completo a concept_data.approved_images[]: el 2.2 de Chrysalis se lleva también la imagen de Ascent, y el lane la arrastra hasta el deck. El contrato dice «concept_data MUST carry approved_images[]» sin acotar.')
p('Efecto secundario medido: con las imágenes del otro concepto contadas como cobertura, el 2.2 concluye que no necesita generar ninguna.')

h2('3', 'Mínimo de development images')
p('development_images y su plan dicen dos veces «zero is a valid and common answer». Con los contratos ya llegando al modelo, el 2.2 elige cero de forma razonada. Hay que decidir si Concept Development puede entregar cero.')

h2('4', 'MOTOR-2: confirmar la base del skill del deck')
p('Tu delta esperaba la base 8cb83315… y la viva era b3feebdf…, así que no se aplicó como diff: se aplicó tu spec de patrones con aplicar-motor2b.js. El resultado está limpio — hoy el skill sirve 18.875 chars, sha bdf855ee…, y cero ids fantasma image_wide, image_interior o image_object.')
p('Quedan dos cosas por confirmar. Que ese contenido es el que querías, o mandás un delta contra esa base. Y que no existe una fila v57_cinematic_deck_template_v2 en forge_skill_configs: la clave v1 ya apunta al archivo _v2.md, así que decidir si se separan o se deja como está.')

h2('5', 'v2.9.21 aplicado, sin ejecutar')
p('La DNA viva del 2.7 ya trae lock_candidates y seis menciones de RECOMMENDED, pero ninguna corrida posterior al delta lo ha ejercido: la última sesión del 2.7 es del 28-ago 22:54, anterior a la aplicación. Con el 2.2 pasa lo mismo.')
p('Cuando lo pruebes: dos lanes hasta el 2.6, Run del 2.7, y debería salir briefing + deck + una sección "## lock_candidates" con un RECOMMENDED y cero locks. Después, Accept.')

h2('6', 'Aviso: movimos el fan-in de 2.5 a 2.7')
p('Cambio nuestro sobre tus filas, a pedido del equipo el 28-ago. Cada concepto llega a su propia presentación y a su propia revisión, y el gate decide entre los dos. Sin ese cambio el 2.7 recibiría dos decks por puertos single: o se parte el gate en dos, o se queda con un solo concepto.')
p('Respaldos en _Prod/backups/forge_nodes_pre_fanin27_20260828.json. Que no lo pise el próximo delta.')

regla()
doc.font('Helvetica').fontSize(8.6).fillColor(SUAVE)
   .text('Aplicado y verificado, sin acción de tu parte: MOTOR-1 + T-1-rev, MOTOR-2, v2.9.16, v2.9.17, v2.9.18, v2.9.20 y v2.9.21.', { width: ANCHO })

doc.end()
console.log('→ ' + SALIDA)
