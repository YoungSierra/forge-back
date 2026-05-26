-- Asset-nodes: library assets como nodos en el canvas
-- node_type discrimina entre forge_nodes (DNA) y library_asset (archivo)
ALTER TABLE v57.forge_project_nodes
  ADD COLUMN IF NOT EXISTS node_type       text NOT NULL DEFAULT 'forge_node',
  ADD COLUMN IF NOT EXISTS source_asset_id uuid REFERENCES v57.forge_project_library_assets(id) ON DELETE SET NULL;

-- node_id ahora puede ser NULL para asset-nodes
ALTER TABLE v57.forge_project_nodes
  ALTER COLUMN node_id DROP NOT NULL;

-- Garantiza consistencia de tipos
ALTER TABLE v57.forge_project_nodes
  ADD CONSTRAINT chk_node_type CHECK (
    (node_type = 'forge_node'    AND node_id IS NOT NULL AND source_asset_id IS NULL) OR
    (node_type = 'library_asset' AND node_id IS NULL     AND source_asset_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_fpn_asset ON v57.forge_project_nodes(source_asset_id)
  WHERE source_asset_id IS NOT NULL;
