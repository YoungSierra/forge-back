-- 032_run_config.sql
-- Autorización de gates para Run de pipeline completo (#4).
-- run_config guarda la decisión "remember" del usuario sobre cómo cruzar gates:
--   { "gate_authorization": { "mode": "pause" | "auto_accept", "remember": true } }
-- mode=pause      → el loop se detiene en cada gate para revisión manual
-- mode=auto_accept → el loop cruza gates automáticamente (auto-ACCEPT autorizado)

ALTER TABLE v57.projects
  ADD COLUMN IF NOT EXISTS run_config JSONB NOT NULL DEFAULT '{}'::jsonb;
