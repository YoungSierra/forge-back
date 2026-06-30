-- Permite sesiones independientes por output_key de un nodo
-- output_key NULL = sesión general del nodo (chat libre)
-- output_key = 'competitive_scan' etc. = sesión enfocada en ese output

ALTER TABLE forge_sessions
  ADD COLUMN IF NOT EXISTS output_key text DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_forge_sessions_output_key
  ON forge_sessions (project_id, node_id, output_key, status);
