-- Eliminar check constraints que bloquean inserts en runtime
-- La validación de valores se maneja en el backend, no en la DB

ALTER TABLE v57.forge_assets DROP CONSTRAINT IF EXISTS forge_assets_format_check;
ALTER TABLE v57.forge_assets DROP CONSTRAINT IF EXISTS forge_assets_status_check;
