-- 052 · forge_asset_notes — las notas del moodboard, del proyecto y no del navegador
--
-- Las notas se pidieron para «dejar indicaciones sin modificar la imagen». Una indicación que
-- solo ve quien la escribió, y solo en su navegador, no cumple eso: guardarlas en localStorage
-- las volvía un recordatorio privado.
--
-- Una nota por activo y por autor: dos personas pueden anotar la misma hoja y ninguna pisa a la
-- otra. Si más adelante hace falta un hilo de comentarios, esta tabla ya lo aguanta — se quita la
-- unicidad y cada fila es un mensaje.

-- NOTA: `asset_id` nació como UUID con foránea a forge_assets y la 053 lo corrige a TEXT sin
-- foránea — el moodboard mezcla cuatro orígenes y solo uno vive en esa tabla. Si vas a crear la
-- tabla desde cero, créala ya con TEXT y sáltate la 053.
CREATE TABLE IF NOT EXISTS v57.forge_asset_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID NOT NULL REFERENCES v57.forge_assets(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES v57.projects(id)     ON DELETE CASCADE,
  member_id   UUID          REFERENCES v57.members(id)      ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una nota por persona y por activo: escribir de nuevo actualiza la suya.
CREATE UNIQUE INDEX IF NOT EXISTS uq_forge_asset_notes_asset_member
  ON v57.forge_asset_notes(asset_id, COALESCE(member_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- El moodboard las pide todas de un proyecto en una sola consulta.
CREATE INDEX IF NOT EXISTS idx_forge_asset_notes_project
  ON v57.forge_asset_notes(project_id);
