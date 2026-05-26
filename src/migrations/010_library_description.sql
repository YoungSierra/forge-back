-- Agrega columna description a la librería de assets del proyecto
ALTER TABLE v57.forge_project_library_assets
  ADD COLUMN IF NOT EXISTS description text;

-- Incluir extracted_text en el índice de búsqueda futuro (sin cambio de schema, solo documentación)
-- extracted_text ya existe desde migración 009
