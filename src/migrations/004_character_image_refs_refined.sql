-- Agrega columna refined_from_id a character_image_refs para rastrear qué imagen fue refinada
ALTER TABLE character_image_refs
  ADD COLUMN IF NOT EXISTS refined_from_id uuid REFERENCES character_image_refs(id) ON DELETE SET NULL;
