-- ============================================================
-- Migration 005 — Phase / Gate / Human / Collaborative support
-- Amplía step_configs para soportar la jerarquía de 3 niveles:
--   Phase → Container → Node (+ Gate al final de cada Phase)
-- y los tipos de ejecutor humano/colaborativo del process flow.
-- ============================================================

-- 1. Quitar NOT NULL de integration_type
--    Phase y Gate no ejecutan nada → integration_type = NULL
ALTER TABLE v57.step_configs
  ALTER COLUMN integration_type DROP NOT NULL;

-- 2. Reemplazar el CHECK constraint para incluir todos los tipos reales
ALTER TABLE v57.step_configs
  DROP CONSTRAINT step_configs_integration_type_check;

ALTER TABLE v57.step_configs
  ADD CONSTRAINT step_configs_integration_type_check
  CHECK (integration_type = ANY (ARRAY[
    'llm',           -- AI ejecuta via LLM
    'comfyui',       -- AI ejecuta via ComfyUI imagen/3D
    'n8n',           -- AI ejecuta via n8n webhook
    'human',         -- Humano ejecuta (tracking only, sin ejecución AI)
    'collaborative'  -- AI draft + revisión humana iterativa (ej. GDD)
  ]));
