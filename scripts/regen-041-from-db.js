// ─── Regenera 041 como SNAPSHOT FIEL de lo que hay en la BD (no desde los node.json) ───────
//
// POR QUE EXISTE: la 041 la generaba `import-v2_7_0-delta.js` desde los JSON de v.2.7.0/. Pero el
// 3.9 fue actualizado despues a v2.7.2 (delta `_cambios 14072026/Forge_v2.7.2_Delta_2/`) aplicado
// directo a la BD, sin regenerar la migracion y SIN subir metadata.dna_version (la fila dice 2.7.0
// pero el contenido es 2.7.2). Resultado: re-correr la 041 hacia un DOWNGRADE SILENCIOSO del 3.9
// v2.7.2 -> v2.7.0, perdiendo el skill add_template_population, purpose, constraints, default_prompt
// y outputs. Detectado por preflight el 2026-07-15 ANTES de aplicar.
//
// Este script invierte la direccion: BD -> migracion. Deja la 041 como un snapshot honesto de lo
// aplicado, de modo que re-correrla sea un no-op en vez de una regresion.
//
// OJO: NO vuelvas a correr `import-v2_7_0-delta.js` — reintroduce la mina. Si necesitas cambiar el
// DNA desde los JSON, arregla primero su SRC del 3.9 para que lea el JSON de v2.7.2.
//
// Uso:  node scripts/regen-041-from-db.js [--write]     (sin --write solo muestra el diff)
require('dotenv').config()
const fs = require('fs'), path = require('path')
const { db } = require('../src/services/supabase.service')

const OUT = path.join(__dirname, '..', 'src', 'migrations', '041_seed_v2_7_0_nodes.sql')
const NODE_KEYS = ['3.0', '3.2', '3.9', '3.12']
const WRITE = process.argv.includes('--write')

const q = s => `'${String(s ?? '').replace(/'/g, "''")}'`
const jsonb = o => `${q(JSON.stringify(o))}::jsonb`
const arr = a => `ARRAY[${(a || []).map(q).join(',')}]::text[]`

function nodeUpsert(r) {
  return `-- ─── ${r.node_key} ${r.title} ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  ${q(r.node_key)}, ${q(r.title)}, ${q(r.phase)}, ${q(r.role)}, ${q(r.status)},
  ${q(r.purpose)},
  ${q(r.standalone_prompt)},
  ${q(r.default_prompt)},
  ${q(r.constraints)},
  ${arr(r.tools)},
  ${arr(r.skills)},
  ${jsonb(r.executor)},
  ${jsonb(r.inputs)},
  ${jsonb(r.outputs)},
  ${jsonb(r.metadata)}
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();
  -- Nota: status NO se pisa en UPDATE (preserva el status vivo del nodo existente).
`
}

function blueprintUpsert(b, nodeKeyById) {
  const seq = (b.node_sequence || [])
    .map(s => ({ k: nodeKeyById[s.node_id], o: s.order_index }))
    .filter(s => s.k)
    .sort((a, b2) => a.o - b2.o)
  const keys = seq.map(s => s.k)
  return `-- ─── Blueprint: ${b.name}  (${seq.length} nodos) ───
WITH ids AS (SELECT node_key, id FROM v57.forge_nodes WHERE node_key IN (${keys.map(q).join(',')}))
INSERT INTO v57.forge_blueprints (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
SELECT ${q(b.blueprint_key)}, ${q(b.name)}, ${q(b.phase)}, ${q(b.description)},
  (SELECT jsonb_agg(jsonb_build_object('node_id',(SELECT id FROM ids WHERE node_key=x.k),'order_index',x.o) ORDER BY x.o)
     FROM (VALUES ${seq.map(s => `(${q(s.k)},${s.o})`).join(',')}) x(k,o)),
  ${jsonb(b.edges ?? [])}, ${jsonb(b.gate ?? {})}, ${b.is_default ? 'true' : 'false'}
ON CONFLICT (blueprint_key) DO UPDATE SET
  name=EXCLUDED.name, node_sequence=EXCLUDED.node_sequence, edges=EXCLUDED.edges,
  gate=EXCLUDED.gate, description=EXCLUDED.description, updated_at=now();
`
}

;(async () => {
  const { data: nodes, error: nErr } = await db()
    .from('forge_nodes')
    .select('id, node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata')
    .eq('phase', 'pre-production')
  if (nErr) throw nErr

  const nodeKeyById = Object.fromEntries(nodes.map(n => [n.id, n.node_key]))
  const picked = NODE_KEYS.map(k => nodes.find(n => n.node_key === k))
  const missing = NODE_KEYS.filter((k, i) => !picked[i])
  if (missing.length) { console.error('ABORT: faltan nodos en la BD: ' + missing.join(',')); process.exit(1) }

  const { data: bps, error: bErr } = await db()
    .from('forge_blueprints')
    .select('blueprint_key, name, phase, description, node_sequence, edges, gate, is_default')
    .in('blueprint_key', ['preprod_full', 'preprod_critical'])
  if (bErr) throw bErr
  if (bps.length !== 2) { console.error('ABORT: se esperaban 2 blueprints, hay ' + bps.length); process.exit(1) }
  bps.sort((a, b) => a.blueprint_key === 'preprod_full' ? -1 : 1)

  const header = `-- ============================================================
-- Migration 041 — Nodos de pre-produccion 3.0 / 3.2 / 3.9 / 3.12 + blueprints.
--
-- SNAPSHOT DESDE LA BD — generado por scripts/regen-041-from-db.js, NO por import-v2_7_0-delta.js.
-- Motivo: la version anterior se generaba desde los node.json de v.2.7.0/, pero el 3.9 vive en la BD
-- como v2.7.2 (delta del 14-jul aplicado a mano, sin subir metadata.dna_version). Regenerar desde los
-- JSON revertia el 3.9 a v2.7.0 y borraba el skill add_template_population. Ahora la 041 refleja lo
-- que REALMENTE esta aplicado: re-correrla es un no-op, no una regresion.
--
-- NO correr import-v2_7_0-delta.js sobre este archivo: reintroduce la mina del 3.9.
-- El fix del 3.2 (mechanics_engineering.uses) NO esta aca: vive en la 042.
--
-- Todo UPSERT, sin wipe. Toca solo forge_nodes y forge_blueprints.
-- ============================================================

-- Backfill del modelo por default en nodos pre-produccion sembrados sin executor.model.
UPDATE v57.forge_nodes
SET executor = executor || '{"model":"anthropic:claude-sonnet-4-6"}'::jsonb, updated_at = now()
WHERE phase = 'pre-production' AND (executor->>'model') IS NULL;
`

  const sql = [header, ...picked.map(nodeUpsert), ...bps.map(b => blueprintUpsert(b, nodeKeyById))].join('\n')

  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  console.log('041 actual : ' + prev.length + ' chars')
  console.log('041 nueva  : ' + sql.length + ' chars (snapshot de la BD)')
  for (const n of picked) {
    console.log(`  ${n.node_key.padEnd(5)} ${String(n.title).padEnd(30)} status=${n.status} skills=${(n.skills || []).length} outputs=${(n.outputs || []).length}`)
  }
  for (const b of bps) console.log(`  blueprint ${b.blueprint_key.padEnd(18)} ${(b.node_sequence || []).length} nodos`)

  if (!WRITE) { console.log('\n(dry-run — usa --write para escribir)'); return }
  fs.writeFileSync(OUT, sql)
  console.log('\n✓ escrita: ' + OUT)
})().catch(e => { console.error(e); process.exit(1) })
