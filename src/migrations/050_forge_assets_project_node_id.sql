-- 050 · forge_assets.project_node_id — a qué INSTANCIA pertenece un asset
--
-- Con fan-out, un mismo nodo del catálogo vive en varios lanes: el 2.4 de "SMACK: Drift" y el 2.4
-- de "SMACK: The Current" comparten `node_id`. `forge_assets` solo guardaba ese `node_id`, así que
-- todo listado por nodo devolvía los assets de TODOS los lanes — el 20-ago el 2.4 del lane B
-- mostraba las 7 imágenes que el lane A había generado para otro concepto.
--
-- La instancia ya se conoce: está en la sesión que produjo el asset. Se materializa en la fila
-- para que las consultas por nodo puedan acotar sin depender del join.
--
-- Nullable a propósito: los assets anteriores al fan-out no tienen instancia y deben seguir
-- viéndose desde la única que existe.

ALTER TABLE v57.forge_assets
  ADD COLUMN IF NOT EXISTS project_node_id UUID
  REFERENCES v57.forge_project_nodes(id) ON DELETE SET NULL;

-- Backfill desde la sesión de origen.
--
-- `forge_sessions.project_node_id` NO tiene clave foránea, así que conserva el id de nodos ya
-- borrados: medidos 4 de 323, con 2 assets colgando. Acá sí hay FK, de modo que copiar esos ids
-- rompe la migración entera (23503). Se exige que la instancia siga existiendo; los assets de un
-- nodo borrado se quedan en NULL, que es la verdad — ya no pertenecen a ninguna instancia.
UPDATE v57.forge_assets a
   SET project_node_id = s.project_node_id
  FROM v57.forge_sessions s
 WHERE a.session_id = s.id
   AND s.project_node_id IS NOT NULL
   AND a.project_node_id IS NULL
   AND EXISTS (SELECT 1 FROM v57.forge_project_nodes pn WHERE pn.id = s.project_node_id);

-- Los assets sin sesión (o con sesión sin instancia) quedan en NULL: si el nodo tiene una sola
-- instancia en su proyecto, se le puede atribuir sin ambigüedad.
UPDATE v57.forge_assets a
   SET project_node_id = pn.id
  FROM v57.forge_project_nodes pn
 WHERE a.project_node_id IS NULL
   AND pn.project_id = a.project_id
   AND pn.node_id    = a.node_id
   AND pn.removed    = false
   AND (SELECT count(*) FROM v57.forge_project_nodes x
         WHERE x.project_id = a.project_id AND x.node_id = a.node_id AND x.removed = false) = 1;

CREATE INDEX IF NOT EXISTS idx_forge_assets_project_node
  ON v57.forge_assets(project_node_id);
