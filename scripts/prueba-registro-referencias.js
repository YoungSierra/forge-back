// Prueba en memoria del registro de referencias de Dirección de Arte (spec de Miguel León §4): registrar por los dos
// canales, «la última aprobada gana», restaurar, quitar, y que una instancia nunca toque a otra ni a la página fija.
// También el paso 3 de Add Context (`resolverDestino`) con y sin USERREF en el maestro del proyecto.
//
// Sin base ni red: `db()` es un doble en memoria con lo justo de la API de supabase-js que usan estos servicios.
// Uso (desde forge-back): node scripts/prueba-registro-referencias.js
'use strict'
const path = require('path')
const RAIZ = path.resolve(__dirname, '..')

// ─── Una base en memoria: from(tabla) → consulta encadenable y «thenable» ───────────────────────────────────────
const tablas = { forge_assets: [], forge_sessions: [], forge_nodes: [{ id: 'n39', node_key: '3.9' }] }
let secuencia = 0
const leerRuta = (fila, ruta) => ruta.split('->').reduce((o, k) => (o == null ? o : o[k]), fila)
function consulta(tabla) {
  const filtros = []
  let orden = null, limite = null, modo = null, escritura = null
  const q = {
    select() { return q },
    eq(c, v) { filtros.push(f => leerRuta(f, c) === v); return q },
    not(c, op, v) { filtros.push(f => leerRuta(f, c) != null); return q },
    like(c, patron) { const re = new RegExp('^' + patron.split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'); filtros.push(f => re.test(String(leerRuta(f, c)))); return q },
    order(c, { ascending = true } = {}) { orden = { c, ascending }; return q },
    limit(n) { limite = n; return q },
    maybeSingle() { modo = 'maybe'; return q },
    single() { modo = 'single'; return q },
    insert(filas) { escritura = { tipo: 'insert', filas: [].concat(filas) }; return q },
    update(parche) { escritura = { tipo: 'update', parche }; return q },
    then(ok, ko) {
      try {
        const T = tablas[tabla] ||= []
        let data
        if (escritura?.tipo === 'insert') {
          data = escritura.filas.map(f => ({ id: `${tabla}-${++secuencia}`, created_at: new Date(Date.UTC(2026, 9, 22, 0, 0, secuencia)).toISOString(), ...JSON.parse(JSON.stringify(f)) }))
          T.push(...data)
        } else if (escritura?.tipo === 'update') {
          data = T.filter(f => filtros.every(p => p(f)))
          data.forEach(f => Object.assign(f, JSON.parse(JSON.stringify(escritura.parche))))
        } else {
          data = T.filter(f => filtros.every(p => p(f))).map(f => JSON.parse(JSON.stringify(f)))
          if (orden) data.sort((a, b) => (a[orden.c] < b[orden.c] ? -1 : a[orden.c] > b[orden.c] ? 1 : 0) * (orden.ascending ? 1 : -1))
          if (limite != null) data = data.slice(0, limite)
        }
        if (modo) data = data[0] ?? null
        return Promise.resolve({ data, error: null }).then(ok, ko)
      } catch (e) { return Promise.reject(e).then(ok, ko) }
    },
  }
  return q
}
const db = () => ({ from: consulta })

// El maestro del proyecto: lo único que `paginasConUserref` lee fuera de forge_assets.
const sup = require(path.join(RAIZ, 'src/services/supabase.service'))
sup.db = db

let fallos = 0
const linea = (ok, t) => { if (!ok) fallos++; console.log(`${ok ? '✔' : '✖'} ${t}`) }

;(async () => {
  const R = require(path.join(RAIZ, 'src/services/referencias-ad.service'))
  const { resolverDestino } = require(path.join(RAIZ, 'src/services/contexto.service'))
  const P = 'proy-1'
  const LUMEN = { pagina: '23_CharacterSheet', item: 'Lumen-Vael (CHAR-02)' }
  const KORA  = { pagina: '23_CharacterSheet', item: 'Kora (CHAR-03)' }
  const reg = (url, pagina, instancia, canal) => R.registrarReferencia(db, { project_id: P, url, nombre: url.split('/').pop(), pagina, instancia, canal, cascada: false })
  const vig = async (pagina, inst = null) => (await R.registroDe(db, P, pagina, inst))
  const id = r => r?.vigente?.id || null

  // Una referencia vieja, como las que ya hay en la base: sin canal y sin primary.
  tablas.forge_assets.push({ id: 'vieja', project_id: P, storage_url: 'https://x/vieja.png', status: 'approved', name: 'vieja.png',
    created_at: '2026-10-01T00:00:00.000Z', metadata: { contexto: { rol: 'referencia_aprobada', estado: 'approved', primary: false, pagina_destino: '01_KeyArt', inbound: [{ via: 'add_context' }] } } })
  linea(id(await vig('01_KeyArt')) === 'vieja', 'una referencia vieja (sin canal ni primary) es la vigente de su página')
  linea(id(await vig('08_KeyArt')) === 'vieja', 'la página se compara sin su número (08_KeyArt = 01_KeyArt)')

  const a = (await reg('https://x/a.png', '01_KeyArt', null, 'add_context')).activo
  linea(id(await vig('01_KeyArt')) === a.id, 'Add Context registra otra: pasa a ser la vigente')
  const b = (await reg('https://x/b.png', '01_KeyArt', null, 'design_edits')).activo
  let r = await vig('01_KeyArt')
  linea(r.vigente?.id === b.id && r.vigente.canal === 'design_edits', 'Design Edits registra otra: la última gana, con su canal')
  linea(r.historial.length === 3 && r.historial.filter(h => h.vigente).length === 1, `historial de la página: 3 piezas, 1 vigente`)
  linea(tablas.forge_assets.filter(f => f.metadata?.contexto?.primary).length === 1, 'una sola primary en esa página')

  const l = (await reg('https://x/lumen.png', '23_CharacterSheet', LUMEN, 'add_context')).activo
  linea(id(await vig('23_CharacterSheet', LUMEN)) === l.id, 'la instancia Lumen tiene su referencia')
  linea(id(await vig('23_CharacterSheet', KORA)) === null, 'la instancia Kora NO la toma')
  linea(id(await vig('23_CharacterSheet')) === null, 'la Character Sheet sin instancia NO la toma')
  linea(id(await vig('01_KeyArt')) === b.id, 'registrar en una instancia no toca la página fija')

  await R.hacerVigente(db, P, a.id)
  linea(id(await vig('01_KeyArt')) === a.id, 'restaurar una del historial la vuelve vigente')
  linea(id(await vig('23_CharacterSheet', LUMEN)) === l.id, 'restaurar en la página no toca la instancia')

  const n = await R.quitarReferencia(db, P, '01_KeyArt', null)
  r = await vig('01_KeyArt')
  linea(r.vigente === null && r.historial.length === 3 && r.historial.every(h => h.retirada), `quitar: la página va sin referencia (${n} retiradas, nada borrado)`)
  linea(id(await vig('23_CharacterSheet', LUMEN)) === l.id, 'quitar en la página no toca la instancia')
  await R.hacerVigente(db, P, b.id)
  linea(id(await vig('01_KeyArt')) === b.id, 'restaurar después de quitar la vuelve vigente')
  const c = (await reg('https://x/c.png', '01_KeyArt', null, 'add_context')).activo
  linea(id(await vig('01_KeyArt')) === c.id, 'y una nueva después de eso gana otra vez')

  // Otro rol con imagen en la misma página no es una referencia de Dirección de Arte.
  tablas.forge_assets.push({ id: 'spec', project_id: P, storage_url: 'https://x/spec.png', status: 'approved', name: 'spec.png',
    created_at: '2026-10-30T00:00:00.000Z', metadata: { contexto: { rol: 'especificacion_de_asset', estado: 'approved', primary: true, pagina_destino: '01_KeyArt' } } })
  linea(id(await vig('01_KeyArt')) === c.id, 'una «Asset specification» de la misma página no carga como referencia')

  // La pieza de Design Edits es como la de Add Context: colgada del 3.9, con Historial Inbound y su §ADI.
  const fb = tablas.forge_assets.find(f => f.id === b.id)
  linea(fb.node_id === 'n39' && fb.metadata.contexto.inbound[0].via === 'design_edits' && fb.metadata.contexto.inyeccion === 'directa'
    && /KeyArt|Visual Pillars|§/.test(fb.metadata.contexto.ancla_adi || ''), 'la pieza de Design Edits: nodo 3.9, inbound design_edits, inyección directa, ancla §ADI')
  const fl = tablas.forge_assets.find(f => f.id === l.id)
  linea(fl.metadata.contexto.instancia?.item === LUMEN.item && fl.metadata.contexto.ambito === 'ficha', 'la de la instancia guarda su instancia y ámbito «ficha»')

  // Qué es una página del ASG.
  const d = R.destinoDeAsset
  linea(JSON.stringify(d({ name: 'Art Style Guide — 09_ColorSystem' })) === JSON.stringify({ pagina: '09_ColorSystem', instancia: null }), 'destino: página fija')
  linea(d({ name: 'Art Style Guide — 23_CharacterSheet — Lumen', metadata: { instancia: { pagina: '23_CharacterSheet', item: 'Lumen', job: 'j' } } })?.instancia?.item === 'Lumen', 'destino: instancia (por metadata)')
  linea(d({ name: 'Art Style Guide — 19_EnvironmentSheet — Segmented' }) === null, 'destino: pieza derivada → no es página')
  linea(d({ name: 'Art Direction Document — Reference Images 6' }) === null, 'destino: otro documento → no es página')

  // Paso 3 de Add Context.
  const con = new Set(['characterSheet', 'keyart', 'charactersheet'])
  let x = resolverDestino({ rol: 'referencia_aprobada', ambito: 'ficha', cual: '23_CharacterSheet', instancia: LUMEN, conUserref: con })
  linea(x.principal.clave === 'userref' && x.principal.instancia?.item === LUMEN.item && x.principal.inyeccion === 'directa', 'Add Context con USERREF: «Approved style reference» de una ficha → USERREF de esa instancia')
  x = resolverDestino({ rol: 'referencia_aprobada', ambito: 'pagina', cual: '01_KeyArt', conUserref: new Set() })
  linea(x.principal.clave === 'pagina' && /REF_\*/.test(x.principal.titulo), 'Add Context sin USERREF (maestro de 25): sigue yendo al REF_* como hoy')
  x = resolverDestino({ rol: 'especificacion_de_asset', ambito: 'ficha', cual: '23_CharacterSheet', conUserref: con })
  linea(x.principal.clave !== 'userref', 'Add Context: «Asset specification» no va a USERREF')
  x = resolverDestino({ rol: 'referencia_aprobada', ambito: 'pagina', cual: '01_KeyArt', formato: 'texto', conUserref: con })
  linea(x.principal.clave !== 'userref', 'Add Context: una nota de texto no va a USERREF')

  console.log(`\n${fallos ? `✖ ${fallos} comprobación(es) fallaron` : '✔ todas las comprobaciones como deben'}`)
  process.exit(fallos ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
