// ─── Importador DELTA v2.7.0 → migración SQL (solo 4 nodos, SIN wipe) ───────────
// Reusa la transformación del importador v2.6.0 (mapNode) sobre los 4 node.json de
// v2.7.0 (3.0 nuevo, 3.2/3.9/3.12 actualizados) y emite UPSERTs — NO borra los otros 18.
// Regenera los 2 blueprints con 3.0 agregado (lee las keys actuales de la BD).
// Uso:  node scripts/import-v2_7_0-delta.js
require('dotenv').config()
const fs = require('fs'), path = require('path')
const { db } = require('../src/services/supabase.service')

const SRC = 'C:/Users/Admin/Documents/V57 Studio/Forge/_PreProd 0707/v.2.7.0/changed_nodes'
const OUT = path.join(__dirname, '..', 'src', 'migrations', '041_seed_v2_7_0_nodes.sql')
const SEED_STATUS = 'archived'
const IMPLEMENTED_TOOLS = new Set(['doc_gen_docx', 'doc_gen_pptx', 'web_fetch'])
const INPUT_ADDITIONS = {} // los 4 nodos del delta no necesitan huecos

const q = s => `'${String(s ?? '').replace(/'/g, "''")}'`
const jsonb = o => `${q(JSON.stringify(o))}::jsonb`
const arr = a => `ARRAY[${(a || []).map(q).join(',')}]::text[]`
const toLabel = name => String(name).split(/[_\s]+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ')
const rank = id => parseInt(String(id).split('.')[1], 10)

function mapNode(doc) {
  const n = doc.node, dna = n.dna
  const wired = (dna.inputs || []).map(i => ({ key: i.port, cardinality: i.cardinality, type: i.type, required: !!i.required }))
  for (const add of (INPUT_ADDITIONS[n.id] || [])) if (!wired.some(w => w.key === add.key)) wired.push({ ...add })
  const inputs = { wired, direct_context: 'Paste or describe the inputs this step needs, or attach a document.' }
  const outputs = []
  for (const c of (dna.outputs?.connections || [])) outputs.push({
    key: c.name, label: toLabel(c.name), type: 'connection', format: c.type, prompt: c.default_prompt,
    uses: c.uses || undefined, ...(c.note ? { note: c.note } : {}),
  })
  for (const a of (dna.outputs?.assets || [])) {
    const isImg = a.format === 'png' || a.format === 'png[]' || a.format === 'image'
    outputs.push({
      key: a.name, label: toLabel(a.name), type: 'asset', format: a.format === 'png[]' ? 'png' : a.format,
      prompt: a.default_prompt, uses: a.uses || undefined,
      ...(a.template ? { template: a.template } : {}), ...(a.section_index ? { section_index: a.section_index } : {}),
      ...(isImg ? { image_gen: true } : {}),
    })
  }
  const metadata = {
    preview: true, dna_version: doc.version, node_type: n.node_type, sub_phase: n.sub_phase,
    group: n.execution?.group, depends_on: n.execution?.depends_on || [], status: n.status,
    amendments: dna.amendments || [],
  }
  return {
    node_key: n.id, title: n.title, phase: 'pre-production', role: 'standard', status: SEED_STATUS,
    purpose: dna.purpose || '',
    standalone_prompt: 'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
    default_prompt: dna.default_prompt || '', constraints: dna.constraints || '',
    tools: (dna.tools || []).filter(t => IMPLEMENTED_TOOLS.has(t)), skills: dna.skills || [],
    executor: { type: 'llm', model: 'anthropic:claude-sonnet-4-6' }, inputs, outputs, metadata,
  }
}

function nodeUpsert(r) {
  return `-- ─── ${r.node_key} ${r.title}  (${r.metadata.node_type}) ───
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

function blueprintSql(key, name, desc, nodeKeys) {
  const keysList = nodeKeys.map(q).join(',')
  const seqValues = nodeKeys.map(k => `(${q(k)},${rank(k)})`).join(',')
  const gate = { name: 'Design Review', mode: 'conversational',
    suggested_rubrics: ['pillars testable', 'real numbers present', 'mechanics reinforce pillars', 'zero TBD / banned words', 'name consistency'],
    outcomes: ['accept', 'refine', 'kill'] }
  return `-- ─── Blueprint: ${name}  (${nodeKeys.length} nodos) ───
WITH ids AS (SELECT node_key, id FROM v57.forge_nodes WHERE node_key IN (${keysList}))
INSERT INTO v57.forge_blueprints (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
SELECT ${q(key)}, ${q(name)}, 'pre-production', ${q(desc)},
  (SELECT jsonb_agg(jsonb_build_object('node_id',(SELECT id FROM ids WHERE node_key=x.k),'order_index',x.o) ORDER BY x.o)
     FROM (VALUES ${seqValues}) x(k,o)),
  '[]'::jsonb, ${jsonb(gate)}, false
ON CONFLICT (blueprint_key) DO UPDATE SET
  name=EXCLUDED.name, node_sequence=EXCLUDED.node_sequence, edges=EXCLUDED.edges,
  gate=EXCLUDED.gate, description=EXCLUDED.description, updated_at=now();

`
}

;(async () => {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.node.json'))
  const rows = files.map(f => mapNode(JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'))))
                    .sort((a, b) => rank(a.node_key) - rank(b.node_key))

  // keys actuales de pre-producción para regenerar preprod_full con 3.0
  const { data: existing } = await db().from('forge_nodes').select('node_key').eq('phase', 'pre-production')
  const allKeys = [...new Set([...existing.map(n => n.node_key), '3.0'])].sort((a, b) => rank(a) - rank(b))
  const CRITICAL = ['3.0', '3.1', '3.2', '3.4', '3.6', '3.9', '3.8', '3.12']

  let sql = `-- ============================================================
-- Migration 041 — Delta v2.7.0: 4 nodos (3.0 NUEVO + 3.2/3.9/3.12 actualizados).
-- Generado por scripts/import-v2_7_0-delta.js. UPSERT (sin wipe) — no toca los otros 18.
-- Cambios: 3.0 Project Identity & Engine (nuevo P0); 3.2 +mechanics_engineering (§B/§C,
-- mechanic_specs INTACTO); 3.9 +ui_screens/scene_manifest; 3.12 TDD buildable+reconciliador.
-- Blueprints preprod_full/critical regenerados con 3.0. Requiere migración 040 (skills) aplicada.
-- Backfill: rellena executor.model en los nodos ya sembrados que quedaron sin modelo.
-- ============================================================

-- Backfill del modelo por default en nodos pre-producción sembrados sin executor.model.
UPDATE v57.forge_nodes
SET executor = executor || '{"model":"anthropic:claude-sonnet-4-6"}'::jsonb, updated_at = now()
WHERE phase = 'pre-production' AND (executor->>'model') IS NULL;

`
  for (const r of rows) sql += nodeUpsert(r)
  sql += blueprintSql('preprod_full', 'Pre-Production (full v2.7.0)',
    'Full Pre-Production v2.7.0, documentation-first. 3.0 identity → mechanics → GDD(3.8)/TDD(3.12).', allKeys)
  sql += blueprintSql('preprod_critical', 'Pre-Production (critical path · GDD+TDD)',
    'Minimal path to GDD (3.8) and TDD (3.12): 3.0 -> 3.1 -> 3.2 / 3.4 -> 3.6 -> 3.9 -> 3.8 / 3.12.', CRITICAL)

  fs.writeFileSync(OUT, sql)
  console.log(`[delta-v2.7.0] ${rows.length} nodos → ${OUT}`)
  rows.forEach(r => console.log(`  ${r.node_key} ${r.title}  tools=${JSON.stringify(r.tools)} skills=${JSON.stringify(r.skills)} outs=[${r.outputs.map(o=>o.key).join(', ')}]`))
  console.log(`  preprod_full: ${allKeys.length} nodos · preprod_critical: ${CRITICAL.length}`)
})().catch(e => { console.error(e); process.exit(1) })
