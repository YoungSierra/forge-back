// ─── Importador NodeDNA v2.4.1 → migración SQL forge_nodes ─────────────────────
// PP-0. Lee los .node.json de Fase 3 y genera un migration SQL idempotente.
// NO toca la base de datos — solo emite SQL para revisar y aplicar a mano en Supabase.
//
// Uso:  node scripts/import-preprod-nodes.js [sourceDir] [outFile]
// Defaults: la carpeta de docs de Pre-Producción y src/migrations/035_seed_preprod_nodes.sql
//
// Alcance de este pase: Sub-Fase A, nodos LLM (3.1–3.6 incl. 3.4b). 3.7 (Assembly) → PP-3.

const fs   = require('fs')
const path = require('path')

const SOURCE_DIR = process.argv[2] ||
  'C:/Users/Admin/Documents/V57 Studio/Forge/Nodes Pre Produccion/Forge_PreProd_node_jsons'
const OUT_FILE = process.argv[3] ||
  path.join(__dirname, '..', 'src', 'migrations', '035_seed_preprod_nodes.sql')

// Nodos de este pase + su order_index para la blueprint (pares paralelos comparten índice)
const SUBPHASE_A_ORDER = { '3.1': 1, '3.2': 2, '3.3': 3, '3.4': 3, '3.4b': 4, '3.5': 4, '3.6': 5 }
const SET = new Set(Object.keys(SUBPHASE_A_ORDER))

// Se siembran como 'archived' para que NO se vean en producción (el catálogo de add-node
// filtra status='active' y el admin excluye 'archived'). Aun así se pueden cargar en un
// proyecto de prueba vía load-blueprint (que ignora el status) y corren/cablean normal.
// Cuando estén listos para producción: flip a 'active'.
const SEED_STATUS = 'archived'

// ─── Helpers de emisión SQL ────────────────────────────────────────────────────
const q     = s => `'${String(s ?? '').replace(/'/g, "''")}'`          // string SQL escapado
const jsonb = o => `${q(JSON.stringify(o))}::jsonb`                      // jsonb literal
const arr   = a => `ARRAY[${(a || []).map(q).join(',')}]::text[]`       // text[] literal

// name → Label legible: "design_pillars" → "Design Pillars"
const toLabel = name => String(name).split(/[_\s]+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ')

// ─── Mapeo de un node.json v2.4.1 → fila forge_nodes ───────────────────────────
function mapNode(doc) {
  const n = doc.node
  const dna = n.dna

  // inputs: dna.inputs[] → { wired:[{key,cardinality,type,required}], direct_context }
  const wired = (dna.inputs || []).map(i => ({
    key: i.port, cardinality: i.cardinality, type: i.type, required: !!i.required,
  }))
  const inputs = {
    wired,
    direct_context: 'Paste or describe the inputs this step needs, or attach a document.',
  }

  // outputs: aplanar connections[] + assets[] → array tipado del schema actual
  const outputs = []
  for (const c of (dna.outputs?.connections || [])) {
    outputs.push({
      key: c.name, label: toLabel(c.name), type: 'connection',
      format: c.type, prompt: c.default_prompt, uses: c.uses || undefined,
    })
  }
  for (const a of (dna.outputs?.assets || [])) {
    const isImg = a.format === 'png' || a.format === 'png[]' || a.format === 'image'
    outputs.push({
      key: a.name, label: toLabel(a.name), type: 'asset',
      format: a.format === 'png[]' ? 'png' : a.format, prompt: a.default_prompt,
      uses: a.uses || undefined,
      ...(isImg ? { image_gen: true } : {}),
    })
  }

  // Campos nuevos v2.4.1 sin columna propia → metadata jsonb (aditivo, el motor lo ignora hoy)
  const metadata = {
    preview:     true,                    // etiqueta de "nodo en desarrollo" — reveal con Ctrl+Alt+P en canvas
    node_type:   n.node_type,
    sub_phase:   n.sub_phase,
    group:       n.execution?.group,
    depends_on:  n.execution?.depends_on || [],
    parallel_with: n.execution?.parallel_with || [],
    status:      n.status,
    amendments:  dna.amendments || [],
    ...(n.instancing_modes ? { instancing_modes: n.instancing_modes } : {}),
    ...(n.script_execution ? { script_execution: n.script_execution } : {}),
  }

  return {
    node_key: n.id,
    title:    n.title,
    phase:    'pre-production',           // key del admin NMS/BMS (PHASES en app/admin/nodes)
    role:     'standard',                 // sub-fase A LLM; gates/assembly llegan después
    status:   SEED_STATUS,                // 'archived' → oculto en producción
    purpose:  dna.purpose || '',
    standalone_prompt: 'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
    default_prompt: dna.default_prompt || '',
    constraints: dna.constraints || '',
    tools:  dna.tools || [],
    skills: dna.skills || [],
    executor: { type: 'llm' },
    inputs, outputs, metadata,
  }
}

// ─── Cargar y filtrar ──────────────────────────────────────────────────────────
const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.node.json'))
const rows = []
for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, f), 'utf8'))
  if (SET.has(doc.node?.id)) rows.push(mapNode(doc))
}
rows.sort((a, b) => SUBPHASE_A_ORDER[a.node_key] - SUBPHASE_A_ORDER[b.node_key] || a.node_key.localeCompare(b.node_key))

// ─── Emitir SQL ────────────────────────────────────────────────────────────────
let sql = `-- ============================================================
-- Migration 035 — Seed Pre-Production nodes (Sub-Phase A, LLM)
-- Generado por scripts/import-preprod-nodes.js desde NodeDNA v2.4.1.
-- Idempotente: ON CONFLICT (node_key) DO UPDATE. Aplicar en Supabase.
-- Alcance: 3.1–3.6 (incl. 3.4b). 3.7 GDD Assembly → PP-3.
-- ============================================================

-- Columna aditiva para los campos nuevos v2.4.1 (node_type, sub_phase, execution,
-- amendments, instancing/script). El motor la ignora hoy; PP-3/PP-4 la leen.
ALTER TABLE v57.forge_nodes ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

`

for (const r of rows) {
  sql += `-- ─── ${r.node_key} ${r.title} ───
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
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

`
}

// ─── Blueprint sub-fase A (node_sequence + edges desde depends_on) ──────────────
const seq = rows.map(r => [r.node_key, SUBPHASE_A_ORDER[r.node_key]])
const edges = []
for (const r of rows) {
  for (const dep of (r.metadata.depends_on || [])) {
    if (SET.has(dep)) edges.push([dep, r.node_key])
  }
}
const keys = rows.map(r => q(r.node_key)).join(',')
const seqValues  = seq.map(([k, o]) => `(${q(k)},${o})`).join(',')
const edgeValues = edges.map(([f, t]) => `(${q(f)},${q(t)})`).join(',')

const gate = {
  name: 'Design Review', mode: 'conversational',
  suggested_rubrics: ['pillars testable', 'real numbers present', 'mechanics reinforce pillars', 'world justifies loop', 'UX teaches the loop'],
  outcomes: ['accept', 'refine', 'kill'],
}

sql += `-- ─── Blueprint: Pre-Production (Sub-Phase A) ───
-- node_sequence y edges se resuelven desde node_key. Gate placeholder conversacional
-- (lo reemplaza 3.7 GDD Assembly en PP-3). Se irá extendiendo con B/C en waves siguientes.
WITH ids AS (
  SELECT node_key, id FROM v57.forge_nodes WHERE node_key IN (${keys})
)
INSERT INTO v57.forge_blueprints (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
SELECT
  'preprod_full', 'Pre-Production (full)', 'pre-production',
  'Full Pre-Production workflow. Sub-Phase A (Design) seeded first; B/C added in later waves.',
  (SELECT jsonb_agg(jsonb_build_object('node_id',(SELECT id FROM ids WHERE node_key=x.k),'order_index',x.o) ORDER BY x.o)
     FROM (VALUES ${seqValues}) x(k,o)),
  (SELECT jsonb_agg(jsonb_build_object('from_node_id',(SELECT id FROM ids WHERE node_key=e.f),'to_node_id',(SELECT id FROM ids WHERE node_key=e.t)))
     FROM (VALUES ${edgeValues}) e(f,t)),
  ${jsonb(gate)},
  false
ON CONFLICT (blueprint_key) DO UPDATE SET
  name=EXCLUDED.name, phase=EXCLUDED.phase, node_sequence=EXCLUDED.node_sequence,
  edges=EXCLUDED.edges, gate=EXCLUDED.gate, description=EXCLUDED.description, updated_at=now();
`

fs.writeFileSync(OUT_FILE, sql)
console.log(`[import-preprod] ${rows.length} nodos → ${OUT_FILE}`)
console.log(`[import-preprod] nodos: ${rows.map(r => r.node_key).join(', ')}`)
console.log(`[import-preprod] edges: ${edges.length}`)
