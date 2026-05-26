-- Text-input nodes: primitivos de texto libre en el canvas
ALTER TABLE v57.forge_project_nodes
  ADD COLUMN IF NOT EXISTS text_label   text,
  ADD COLUMN IF NOT EXISTS text_content text;

-- Ampliar el check constraint para incluir text_input
ALTER TABLE v57.forge_project_nodes DROP CONSTRAINT IF EXISTS chk_node_type;

ALTER TABLE v57.forge_project_nodes
  ADD CONSTRAINT chk_node_type CHECK (
    (node_type = 'forge_node'    AND node_id IS NOT NULL AND source_asset_id IS NULL) OR
    (node_type = 'library_asset' AND node_id IS NULL     AND source_asset_id IS NOT NULL) OR
    (node_type = 'text_input'    AND node_id IS NULL     AND source_asset_id IS NULL)
  );
