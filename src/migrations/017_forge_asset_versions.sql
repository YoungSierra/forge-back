-- forge_asset_versions: historial de iteraciones de refinamiento para forge_assets
-- Principalmente para assets de imagen/media generados por nodos de arte (ComfyUI)

CREATE TABLE IF NOT EXISTS forge_asset_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES forge_assets(id) ON DELETE CASCADE,
  storage_url    text NOT NULL,
  version_number integer NOT NULL DEFAULT 1,
  is_current     boolean NOT NULL DEFAULT true,
  metadata       jsonb,        -- workflow_id, seed, parámetros ComfyUI, model_used
  created_by     uuid REFERENCES members(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forge_asset_versions_asset_id_idx ON forge_asset_versions(asset_id);
CREATE INDEX IF NOT EXISTS forge_asset_versions_is_current_idx ON forge_asset_versions(asset_id, is_current);
