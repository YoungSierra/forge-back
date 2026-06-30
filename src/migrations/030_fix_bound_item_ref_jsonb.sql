-- 030_fix_bound_item_ref_jsonb.sql
-- bound_item_ref almacena el ítem estructurado completo (concept_seed, etc.)
-- del type_registry — debe ser JSONB, no TEXT.
-- Seguro de correr: las columnas están vacías (fan-out nunca ha ejecutado).

ALTER TABLE v57.forge_lanes
  ALTER COLUMN bound_item_ref TYPE JSONB USING bound_item_ref::jsonb;

ALTER TABLE v57.forge_project_nodes
  ALTER COLUMN bound_item_ref TYPE JSONB USING bound_item_ref::jsonb;
