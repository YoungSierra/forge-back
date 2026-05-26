-- Migration 009 — Librería de assets externos por proyecto + inputs explícitos por nodo
-- Dos tablas nuevas que habilitan Reference Injection y conexiones variables entre nodos.

-- ─── 1. forge_project_library_assets ─────────────────────────────────────────
-- Assets externos subidos por el usuario a nivel de proyecto.
-- Reutilizables como input en cualquier nodo del canvas.
create table if not exists v57.forge_project_library_assets (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references v57.projects(id) on delete cascade,
  display_name    text not null,
  file_name       text not null,
  mime_type       text,
  file_size_bytes bigint,
  asset_type      text not null default 'document'
                  check (asset_type in ('document', 'image', 'model_3d', 'other')),
  storage_url     text not null,
  extracted_text  text,
  uploaded_by     uuid references v57.members(id),
  created_at      timestamptz not null default now()
);

-- ─── 2. forge_project_node_inputs ────────────────────────────────────────────
-- Inputs asignados explícitamente a cada nodo dentro de un proyecto.
-- Reemplaza la inyección automática por order_index en compose_prompt.
-- Se auto-puebla desde inputs.required[] del DNA al cargar un blueprint.
-- El usuario puede agregar, cambiar o quitar slots (variable 1..N).
create table if not exists v57.forge_project_node_inputs (
  id              uuid primary key default gen_random_uuid(),
  project_node_id uuid not null references v57.forge_project_nodes(id) on delete cascade,
  project_id      uuid not null references v57.projects(id) on delete cascade,
  input_key       text not null,
  input_label     text,
  is_required     boolean not null default false,
  source_type     text not null
                  check (source_type in ('node_output', 'library_asset')),
  source_node_id  uuid references v57.forge_project_nodes(id),
  source_asset_id uuid references v57.forge_project_library_assets(id),
  order_index     integer not null default 0,
  created_at      timestamptz not null default now(),
  constraint chk_source_matches_type check (
    (source_type = 'node_output'   and source_node_id  is not null and source_asset_id is null) or
    (source_type = 'library_asset' and source_asset_id is not null and source_node_id  is null)
  )
);

-- Índices para queries frecuentes
create index if not exists idx_fpla_project_id  on v57.forge_project_library_assets (project_id);
create index if not exists idx_fpni_project_node on v57.forge_project_node_inputs (project_node_id);
create index if not exists idx_fpni_project_id   on v57.forge_project_node_inputs (project_id);
