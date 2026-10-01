-- El Laboratory no tiene dónde guardar nada, y hoy eso significa que lo pierde todo.
--
-- Corre en una instancia cuyo disco es efímero. Leído en su propio repo, commit 84193c0:
--
--   public/gameplay/     el jugable generado           ignorado en git  → se pierde
--   docs/tdds/           los TDD empujados             no viene en el repo → se pierde
--   workspaces/<slug>/   el taller de cada proyecto    ignorado → se pierde
--   el CHAT              `const sessions = new Map()`  server/index.js:78
--                        `chatHistory` / `checkpoint`  server/agent/session.js:140
--
-- El chat es el peor de los cuatro: no llega ni a disco. Vive en memoria y muere con el proceso, y
-- `/api/sessions/resume` NO lo recupera — abre una sesión nueva sobre el build que haya quedado.
-- Todo el ida y vuelta con el modelo, que es donde está el criterio de quién prototipó, se evapora.
--
-- Esta tabla hace de Forge el dueño de ese estado y deja al Laboratory como lo que es: el taller.
--
-- POR QUÉ UNA FILA POR PROYECTO Y NO UN HISTORIAL. Hay UN prototipo por proyecto, el actual.
-- Versionarlo sería otro producto y hoy nadie lo pidió; cuando haga falta, se añade una tabla de
-- generaciones que apunte acá y esta fila pasa a ser «la actual», sin migrar nada.
--
-- POR QUÉ LOS ARCHIVOS NO ESTÁN EN LA TABLA. El gameplay son ~78 KB de JavaScript y el TDD 112 KB,
-- y el cuello de esta base ya son los bytes: `forge_assets` promedia 1,9 MB por fila y el 91% es
-- `content`. Los archivos van a R2 y acá queda su índice, que es el mismo reparto que usa todo lo
-- demás en Forge: la fila describe, R2 guarda.
--
-- EL CHAT SÍ VA ACÁ. Es JSON, se lee entero junto con la fila y nunca por partes, así que partirlo
-- en dos sitios solo añadiría un viaje. Si algún día pesa de más, se mueve a R2 y la columna se
-- queda con su resumen.

CREATE TABLE IF NOT EXISTS v57.laboratory_state (
  project_id   uuid PRIMARY KEY REFERENCES v57.projects(id) ON DELETE CASCADE,

  -- El nombre del taller en el Laboratory. Es lo único que él conoce: no sabe de proyectos, así
  -- que la traducción slug → proyecto vive de este lado.
  slug         text NOT NULL,

  -- Dónde están los archivos en R2. Se guarda explícito y no se recalcula: el día que el esquema
  -- de rutas cambie, lo ya guardado sigue encontrándose.
  r2_prefix    text NOT NULL,

  -- Qué archivos componen el estado: `[{ ruta, bytes }]` con la ruta RELATIVA a la raíz del
  -- Laboratory —`public/gameplay/main.js`—, que es la misma con la que hay que devolvérselos.
  archivos     jsonb NOT NULL DEFAULT '[]'::jsonb,
  bytes        integer NOT NULL DEFAULT 0,

  -- La conversación y su checkpoint, tal como los tiene el Laboratory en memoria.
  chat         jsonb,
  chat_mensajes integer NOT NULL DEFAULT 0,

  -- Qué operación del Laboratory dejó este estado: generate, chat o sync. Sirve para leer un
  -- estado raro sin adivinar de dónde salió.
  origen       text,

  creado_en    timestamptz NOT NULL DEFAULT now(),
  guardado_en  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE v57.laboratory_state IS
  'El estado del Prototype Laboratory que su disco efímero no conserva: el gameplay generado, el TDD empujado y el chat. Una fila por proyecto — hay un prototipo, el actual.';
COMMENT ON COLUMN v57.laboratory_state.slug IS
  'Nombre del taller en el Laboratory. Es lo único que ese servicio conoce del proyecto.';
COMMENT ON COLUMN v57.laboratory_state.archivos IS
  'Índice del árbol guardado en R2: [{ruta, bytes}] con la ruta relativa a la raíz del Laboratory.';
COMMENT ON COLUMN v57.laboratory_state.chat IS
  'La conversación con el modelo y su checkpoint. En el Laboratory vive en memoria y muere al reiniciarse.';

-- El Laboratory pregunta por SLUG, no por proyecto: es su única llave. Único porque dos proyectos
-- con el mismo slug harían que guardar en uno pisara al otro, en silencio.
CREATE UNIQUE INDEX IF NOT EXISTS idx_laboratory_state_slug
    ON v57.laboratory_state (slug);
