-- Tabla de configuración de skills: r2_path por skill_key
CREATE TABLE IF NOT EXISTS v57.forge_skill_configs (
  key         text        PRIMARY KEY,
  r2_path     text,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
