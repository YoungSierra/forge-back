-- Migración 025: Node DNA v1.3.0
-- Agrega standalone_prompt y role a forge_nodes

ALTER TABLE forge_nodes
  ADD COLUMN IF NOT EXISTS standalone_prompt text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'standard';

-- role válidos: 'standard' | 'gate'
-- standalone_prompt: instrucción de qué hace el nodo sin inputs wired

-- Archivar nodos actuales y renombrar keys a 99.x
UPDATE forge_nodes SET
  node_key = '99.' || node_key,
  status   = 'archived'
WHERE status != 'archived';
