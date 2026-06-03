-- Run All: is_stale en project nodes + auto_approved en sessions
ALTER TABLE v57.forge_project_nodes
  ADD COLUMN IF NOT EXISTS is_stale boolean NOT NULL DEFAULT false;

-- Ampliar el check constraint de forge_sessions para incluir auto_approved
ALTER TABLE v57.forge_sessions DROP CONSTRAINT IF EXISTS forge_sessions_status_check;
ALTER TABLE v57.forge_sessions
  ADD CONSTRAINT forge_sessions_status_check
  CHECK (status IN ('active', 'approved', 'auto_approved', 'rejected', 'abandoned'));
