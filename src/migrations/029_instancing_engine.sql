-- 029_instancing_engine.sql
-- Motor de instancing: forge_lanes + columnas de instancia en forge_project_nodes
-- + project_node_id en forge_sessions para diferenciar instancias del mismo nodo
--
-- El fan-out/fan-in es type-driven: lo detecta el motor leyendo la cardinality
-- de los inputs en el DNA del nodo (forge_nodes.inputs). No hay flags aquí.

-- ── forge_lanes ───────────────────────────────────────────────────────────────
-- Una lane por ítem del list<T> aprobado. label = título del ítem.
CREATE TABLE v57.forge_lanes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID        NOT NULL REFERENCES v57.projects(id) ON DELETE CASCADE,
  lane_key       TEXT        NOT NULL,   -- 'A', 'B', 'C'…
  label          TEXT        NOT NULL,   -- título del ítem (seed title, etc.)
  color          TEXT        NOT NULL DEFAULT '#60a5fa',
  bound_item_ref JSONB       NOT NULL,   -- ítem completo del type_registry (concept_seed, etc.)
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON v57.forge_lanes(project_id);

-- ── forge_project_nodes: columnas de instancing ───────────────────────────────
-- lane_id: a qué lane pertenece esta instancia (null = nodo singleton)
-- bound_item_ref: copia del ítem vinculado, para inyección rápida sin join
ALTER TABLE v57.forge_project_nodes
  ADD COLUMN IF NOT EXISTS lane_id        UUID REFERENCES v57.forge_lanes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bound_item_ref JSONB;

-- ── forge_sessions: diferenciar instancias del mismo forge_node ───────────────
-- Nullable para backward-compat: sesiones pre-instancing no tienen project_node_id
ALTER TABLE v57.forge_sessions
  ADD COLUMN IF NOT EXISTS project_node_id UUID;
