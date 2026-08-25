-- 053 · La nota se pega a lo que el usuario ve, no a una tabla
--
-- 052 ató `asset_id` a `forge_assets` con clave foránea. El moodboard muestra CUATRO orígenes en
-- el mismo lienzo: los outputs de nodo (`forge_assets`), lo que sube el usuario
-- (`forge_project_library_assets`), lo legacy, y las imágenes que todavía viven en la sesión —
-- estas últimas ni siquiera tienen fila propia: su id es `<sesión>_<output>_<índice>_<variación>`.
--
-- Anotar cualquiera de las tres últimas violaba la foránea y devolvía 500. La nota es una
-- anotación de interfaz sobre el elemento que se está mirando, así que su clave es la misma
-- identidad que usa el lienzo, venga de donde venga: texto, sin foránea.
--
-- El `project_id` SÍ conserva la suya: siempre existe, y es lo que permite borrar las notas con
-- el proyecto y pedirlas todas de una.

ALTER TABLE v57.forge_asset_notes
  DROP CONSTRAINT IF EXISTS forge_asset_notes_asset_id_fkey;

ALTER TABLE v57.forge_asset_notes
  ALTER COLUMN asset_id TYPE TEXT USING asset_id::text;

-- El índice único se recrea sobre el tipo nuevo.
DROP INDEX IF EXISTS v57.uq_forge_asset_notes_asset_member;
CREATE UNIQUE INDEX IF NOT EXISTS uq_forge_asset_notes_asset_member
  ON v57.forge_asset_notes(asset_id, COALESCE(member_id, '00000000-0000-0000-0000-000000000000'::uuid));
