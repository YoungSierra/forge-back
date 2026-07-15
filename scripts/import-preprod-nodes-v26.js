// ─── Importador NodeDNA v2.6.0 → migración SQL forge_nodes ─────────────────────
// Lee los 22 .node.json de Pre-Producción (documentation-first / builds-last) y genera
// un migration SQL idempotente. NO toca la base — solo emite SQL para revisar y aplicar.
//
// Diferencias vs. el importador v2.4.1 (import-preprod-nodes.js):
//  - Alcance completo: los 22 nodos (3.1–3.22), no solo Sub-Fase A.
//  - Preserva `template` y `section_index` en los assets (3.8 GDD, 3.12 TDD).
//  - Los edges del blueprint se derivan por KEY-MATCH (output.key === input.port),
//    igual que el auto-wire, NO por execution.depends_on (que trae numeración vieja).
//  - Emite dos blueprints: preprod_full (22) y preprod_critical (ruta GDD+TDD).
//
// Uso:  node scripts/import-preprod-nodes-v26.js [sourceDir] [outFile]

const fs   = require('fs')
const path = require('path')

const SOURCE_DIR = process.argv[2] ||
  'C:/Users/Admin/Documents/V57 Studio/Forge/_PreProd 0707/Forge_PreProd_node_jsons'
const OUT_FILE = process.argv[3] ||
  path.join(__dirname, '..', 'src', 'migrations', '037_seed_preprod_nodes_v2_6_0.sql')

// Se siembran 'archived' → ocultos en el catálogo de producción. load-blueprint ignora el
// status, así que se pueden cargar en un proyecto de prueba y corren/cablean normal.
// Flip a 'active' cuando estén listos para producción.
const SEED_STATUS = 'archived'

// Ruta crítica hacia GDD + TDD (para el blueprint enfocado)
const CRITICAL = ['3.1', '3.2', '3.4', '3.6', '3.9', '3.8', '3.12']

// Tools que el motor REALMENTE soporta y no devuelven "unavailable" (ver tools.service.js).
// Se filtran las demás para no ensuciar la respuesta del LLM:
//  - kb_read: stub ("Knowledge base not implemented yet")
//  - artifact_manage: no existe en executeTool
//  - web_search: sin BRAVE/TAVILY API key devuelve "not configured" → re-agregar por NMS si se
//    configura una key en el .env (nodos de research: 3.12 TDD, monetization, etc.)
const IMPLEMENTED_TOOLS = new Set(['doc_gen_docx', 'doc_gen_pptx', 'web_fetch'])

// Inputs que el template/motor SÍ necesitan pero la DNA v2.6.0 no declara (huecos).
// 3.8 GDD Assembly: §1 Game Identity se puebla de concept_data, pero la DNA no lo lista
// como input → el nodo nunca lo recibe. Se agrega como opcional (no bloquea el run).
const INPUT_ADDITIONS = {
  '3.8': [{ key: 'concept_data', cardinality: 'single', type: 'concept_data', required: false }],
}

// ─── Helpers de emisión SQL ────────────────────────────────────────────────────
const q     = s => `'${String(s ?? '').replace(/'/g, "''")}'`
const jsonb = o => `${q(JSON.stringify(o))}::jsonb`
const arr   = a => `ARRAY[${(a || []).map(q).join(',')}]::text[]`
const toLabel = name => String(name).split(/[_\s]+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ')

// order_index numérico: "3.10" → 10, "3.2" → 2 (la numeración nueva ya es orden topológico)
const rank = id => parseInt(String(id).split('.')[1], 10)

// ─── Mapeo de un node.json v2.6.0 → fila forge_nodes ───────────────────────────
function mapNode(doc) {
  const n = doc.node
  const dna = n.dna

  // inputs: dna.inputs[] → { wired:[{key,cardinality,type,required}], direct_context }
  const wired = (dna.inputs || []).map(i => ({
    key: i.port, cardinality: i.cardinality, type: i.type, required: !!i.required,
  }))
  // Agregar inputs faltantes de la DNA (dedupe por key)
  for (const add of (INPUT_ADDITIONS[n.id] || [])) {
    if (!wired.some(w => w.key === add.key)) wired.push({ ...add })
  }
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
      ...(c.note ? { note: c.note } : {}),
    })
  }
  for (const a of (dna.outputs?.assets || [])) {
    const isImg = a.format === 'png' || a.format === 'png[]' || a.format === 'image'
    outputs.push({
      key: a.name, label: toLabel(a.name), type: 'asset',
      format: a.format === 'png[]' ? 'png' : a.format, prompt: a.default_prompt,
      uses: a.uses || undefined,
      ...(a.template ? { template: a.template } : {}),              // 3.8 GDD → template fijo
      ...(a.section_index ? { section_index: a.section_index } : {}), // 3.12 TDD → índice LLM
      ...(isImg ? { image_gen: true } : {}),
    })
  }

  const metadata = {
    preview:       true,
    dna_version:   doc.version,
    node_type:     n.node_type,
    sub_phase:     n.sub_phase,
    group:         n.execution?.group,
    depends_on:    n.execution?.depends_on || [],   // referencia (numeración vieja) — no se usa para wiring
    status:        n.status,
    amendments:    dna.amendments || [],
    ...(n.instancing_modes ? { instancing_modes: n.instancing_modes } : {}),
    ...(n.script_execution ? { script_execution: n.script_execution } : {}),
  }

  return {
    node_key: n.id,
    title:    n.title,
    phase:    'pre-production',
    role:     'standard',
    status:   SEED_STATUS,
    purpose:  dna.purpose || '',
    standalone_prompt: 'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
    default_prompt: dna.default_prompt || '',
    constraints: dna.constraints || '',
    tools:  (dna.tools || []).filter(t => IMPLEMENTED_TOOLS.has(t)),  // descarta stubs/no-configuradas
    skills: dna.skills || [],
    executor: { type: 'llm', model: 'anthropic:claude-sonnet-4-6' },  // modelo por default; node_type real vive en metadata
    inputs, outputs, metadata,
    _ports:   wired.map(w => w.key),
    _outkeys: outputs.map(o => o.key),
  }
}

// ─── Cargar los 22 nodos ────────────────────────────────────────────────────────
const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.node.json'))
const rows = []
for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, f), 'utf8'))
  rows.push(mapNode(doc))
}
rows.sort((a, b) => rank(a.node_key) - rank(b.node_key))

// ─── Edges por KEY-MATCH (output.key === input.port), respetando el orden ────────
// Para cada input de cada nodo, conecta el upstream más cercano (mayor rank < target)
// cuyo output key coincida. Para one_or_more, conecta todos los upstream que coincidan.
const rankOf = {}
rows.forEach(r => { rankOf[r.node_key] = rank(r.node_key) })
const edges = []
for (const target of rows) {
  const wired = target.inputs.wired
  for (const inp of wired) {
    const upstreams = rows
      .filter(r => rankOf[r.node_key] < rankOf[target.node_key] && r._outkeys.includes(inp.key))
      .sort((a, b) => rankOf[b.node_key] - rankOf[a.node_key])
    if (upstreams.length === 0) continue
    if (inp.cardinality === 'one_or_more') {
      for (const u of upstreams) edges.push([u.node_key, target.node_key])
    } else {
      edges.push([upstreams[0].node_key, target.node_key])
    }
  }
}

// ─── Emitir SQL ────────────────────────────────────────────────────────────────
let sql = `-- ============================================================
-- Migration 037 — Reseed Pre-Production nodes (v2.6.0, 22 nodos)
-- Generado por scripts/import-preprod-nodes-v26.js desde NodeDNA v2.6.0.
-- Orden: documentation-first / builds-last. GDD = 3.8, TDD = 3.12.
-- Reemplaza por completo el seed viejo del 035 (v2.5.2).
--
-- WIPE LIMPIO: ningún proyecto referencia nodos 3.X (confirmado), así que se borran
-- todas las filas pre-producción viejas (incl. el huérfano '3.4b') y se siembra desde
-- cero. Re-ejecutable: el DELETE + INSERT deja siempre el set v2.6.0 exacto (los UUIDs
-- se regeneran en cada corrida — no correr con proyectos activos cargados).
-- ============================================================

ALTER TABLE v57.forge_nodes ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

-- Borrado limpio de la pre-producción vieja (3.1-3.6, 3.4b del 035).
DELETE FROM v57.forge_nodes WHERE phase = 'pre-production';

`

for (const r of rows) {
  sql += `-- ─── ${r.node_key} ${r.title}  (${r.metadata.node_type}) ───
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

// ─── Blueprints ──────────────────────────────────────────────────────────────
function blueprintSql(key, name, desc, nodeKeys, isDefault) {
  const seq = nodeKeys.map(k => [k, rank(k)])
  const keysList   = nodeKeys.map(q).join(',')
  const seqValues  = seq.map(([k, o]) => `(${q(k)},${o})`).join(',')
  const gate = {
    name: 'Design Review', mode: 'conversational',
    suggested_rubrics: ['pillars testable', 'real numbers present', 'mechanics reinforce pillars', 'zero TBD / banned words', 'name consistency'],
    outcomes: ['accept', 'refine', 'kill'],
  }
  // edges = '[]'::jsonb a propósito: load-blueprint inserta blueprint.edges SIN handle
  // (source_handle/target_handle NULL), y luego autoWire() arma los edges correctos por
  // key (output.key === input.port) CON handle. Dejar edges vacío evita filas duplicadas
  // y sin handle. El grafo real lo construye el auto-wire desde el order_index de la secuencia.
  return `-- ─── Blueprint: ${name}  (${nodeKeys.length} nodos · edges vía auto-wire) ───
WITH ids AS (
  SELECT node_key, id FROM v57.forge_nodes WHERE node_key IN (${keysList})
)
INSERT INTO v57.forge_blueprints (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
SELECT
  ${q(key)}, ${q(name)}, 'pre-production',
  ${q(desc)},
  (SELECT jsonb_agg(jsonb_build_object('node_id',(SELECT id FROM ids WHERE node_key=x.k),'order_index',x.o) ORDER BY x.o)
     FROM (VALUES ${seqValues}) x(k,o)),
  '[]'::jsonb,
  ${jsonb(gate)},
  ${isDefault}
ON CONFLICT (blueprint_key) DO UPDATE SET
  name=EXCLUDED.name, phase=EXCLUDED.phase, node_sequence=EXCLUDED.node_sequence,
  edges=EXCLUDED.edges, gate=EXCLUDED.gate, description=EXCLUDED.description, updated_at=now();

`
}

const allKeys = rows.map(r => r.node_key)
sql += blueprintSql(
  'preprod_full', 'Pre-Production (full v2.6.0)',
  'Full Pre-Production, 22 nodes, documentation-first order (v2.6.0). GDD=3.8, TDD=3.12.',
  allKeys, false,
)
sql += blueprintSql(
  'preprod_critical', 'Pre-Production (critical path · GDD+TDD)',
  'Minimal path to GDD (3.8) and TDD (3.12): 3.1 -> 3.2 / 3.4 -> 3.6 -> 3.9 -> 3.8 / 3.12.',
  CRITICAL, false,
)

fs.writeFileSync(OUT_FILE, sql)
// DAG previsto (deduplicado por par) — solo para inspección; el auto-wire lo reconstruye por key
const dag = [...new Set(edges.map(([f, t]) => `${f}->${t}`))]
console.log(`[import-v26] ${rows.length} nodos → ${OUT_FILE}`)
console.log(`[import-v26] nodos: ${rows.map(r => r.node_key).join(', ')}`)
console.log(`[import-v26] DAG previsto (${dag.length} pares, dedup):\n  ${dag.join('\n  ')}`)
