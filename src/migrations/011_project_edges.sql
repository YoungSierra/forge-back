-- Edges del canvas por proyecto — fuente de verdad para conexiones nodo→nodo
CREATE TABLE IF NOT EXISTS v57.forge_project_edges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL,
  source_node_id uuid NOT NULL,
  target_node_id uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_node_id, target_node_id)
);

CREATE INDEX IF NOT EXISTS idx_fpe_project ON v57.forge_project_edges(project_id);
CREATE INDEX IF NOT EXISTS idx_fpe_target  ON v57.forge_project_edges(target_node_id);
