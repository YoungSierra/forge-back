-- Tabla de changelog / "What's New" — entradas de novedades visibles en la app.
-- Fuente de verdad. La API pública expone solo las publicadas; el admin gestiona todas.
create table if not exists v57.forge_changelog (
  id           uuid default gen_random_uuid() primary key,

  -- Versión con formato "v{major}.{sprint}.{year}" (ej. "v0.13.2026"); segmento medio = sprint
  version      text not null,

  -- Tipo de entrada — controla badge/color en la UI
  type         text not null check (type in ('bug_fix', 'new_feature', 'improvement')),

  title        text not null,

  -- Lista de bullets (strings) que describen el cambio
  items        jsonb default '[]'::jsonb,

  -- Origen: 'seed' = sembrada desde el buffer de changelog; 'manual' = creada en el admin
  source       text default 'manual' check (source in ('seed', 'manual')),

  -- Publicación
  published    boolean default false,
  released_at  timestamptz,             -- se setea al publicar

  created_by   uuid references v57.members(id) on delete set null,
  created_at   timestamptz default now()
);

-- Índice para la query pública (publicadas, ordenadas por fecha de release)
create index if not exists fch_published   on v57.forge_changelog (published, released_at desc);
create index if not exists fch_created_at  on v57.forge_changelog (created_at desc);
