-- Columna para almacenar imágenes generadas por item en cada sesión
alter table v57.forge_sessions
  add column if not exists output_images jsonb default null;
