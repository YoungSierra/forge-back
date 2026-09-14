-- forge_assets guarda de qué NODO salió cada pieza, pero no de qué SALIDA de ese nodo.
--
-- Esa clave existe, pero en `forge_sessions`: para saber que una imagen es `world_visuals` y no
-- `reference_images` hay que saltar de la pieza a su sesión. Tres consumidores dan hoy ese mismo
-- rodeo —el disparador del montaje, el buscador de assets y el inyector de referencias—, y el
-- salto no siempre llega: 168 de 468 imágenes se generaron en modo nodo entero, con una sesión de
-- `output_key` nulo, y de esas no hay forma de saber qué salida las produjo.
--
-- La columna no inventa ese dato donde no existe: lo copia donde sí, y deja el resto en NULL, que
-- es la verdad. Lo que gana es que cada pieza lo lleve encima y deje de deducirse.
--
-- Nullable a propósito y sin valor por defecto: una pieza sin clave es un caso real, no un error.

ALTER TABLE v57.forge_assets
  ADD COLUMN IF NOT EXISTS output_key text;

COMMENT ON COLUMN v57.forge_assets.output_key IS
  'Salida del nodo que produjo la pieza. NULL cuando el nodo corrió en modo nodo entero y su sesión no la declaró.';

-- Backfill desde la sesión, que es de donde se venía deduciendo.
UPDATE v57.forge_assets a
   SET output_key = s.output_key
  FROM v57.forge_sessions s
 WHERE a.session_id = s.id
   AND s.output_key IS NOT NULL
   AND a.output_key IS NULL;

-- Se consulta por proyecto y salida —«las imágenes de `world_visuals` de este proyecto»—, que es
-- el par que hacen todos los consumidores.
CREATE INDEX IF NOT EXISTS idx_forge_assets_project_output
    ON v57.forge_assets (project_id, output_key)
 WHERE output_key IS NOT NULL;
