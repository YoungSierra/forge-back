-- Guarda el handle exacto (slot) de origen y destino en cada edge del canvas
ALTER TABLE v57.forge_project_edges
  ADD COLUMN IF NOT EXISTS source_handle text,
  ADD COLUMN IF NOT EXISTS target_handle text;
