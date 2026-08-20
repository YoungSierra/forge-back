-- 051 · forge_messages.output_images — las imágenes cuelgan del turno que las produjo
--
-- Hasta ahora las imágenes de un nodo vivían en `forge_sessions.output_images`: un solo mapa por
-- sesión, indexado por output y por posición del ítem. Iterar en el chat reescribe los prompts
-- pero conserva las posiciones, así que el turno nuevo se pintaba con las imágenes del turno
-- viejo — texto nuevo, imagen vieja, sin que nada lo dijera. Y como el front solo pinta el ÚLTIMO
-- mensaje, lo anterior desaparecía de la vista aunque siguiera en la base.
--
-- Cada respuesta conserva lo que ella generó. El mapa de la sesión se mantiene como "lo último
-- vigente" — es lo que leen el canvas, el moodboard y el PDF — y este pasa a ser el historial.

ALTER TABLE v57.forge_messages
  ADD COLUMN IF NOT EXISTS output_images JSONB;

-- Backfill sin adivinar: solo donde hay UNA respuesta del agente en la sesión, que es el único
-- caso en que se sabe con certeza qué turno produjo esas imágenes.
UPDATE v57.forge_messages m
   SET output_images = s.output_images
  FROM v57.forge_sessions s
 WHERE m.session_id = s.id
   AND m.role       = 'agent'
   AND m.output_images IS NULL
   AND s.output_images IS NOT NULL
   AND (SELECT count(*) FROM v57.forge_messages x
         WHERE x.session_id = s.id AND x.role = 'agent') = 1;
