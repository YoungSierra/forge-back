-- Tabla de log de ejecución: LLM calls, generación de imágenes, costos y performance
create table if not exists v57.forge_execution_log (
  id            uuid default gen_random_uuid() primary key,

  -- Contexto
  project_id    uuid references v57.projects(id)              on delete set null,
  node_id       uuid references v57.forge_project_nodes(id)   on delete set null,
  session_id    uuid references v57.forge_sessions(id)        on delete set null,
  blueprint_id  uuid references v57.forge_blueprints(id)      on delete set null,

  -- Quién
  triggered_by  uuid references v57.members(id)               on delete set null,
  trigger_type  text not null, -- 'chat' | 'image_gen' | 'variation' | 'auto_run' | 'gate'

  -- Qué ejecutó
  executor_type text not null, -- 'llm' | 'comfyui' | 'openai_image' | 'fal'
  provider      text,          -- 'gemini' | 'openai' | 'anthropic' | 'groq' | 'comfyui' ...
  model         text,          -- nombre del modelo o workflow

  -- Tokens (solo LLM)
  input_tokens  integer default 0,
  output_tokens integer default 0,
  cached_tokens integer default 0,

  -- Costo
  cost_usd      numeric(10,8) default 0,
  is_estimated  boolean default false, -- true para imágenes (sin precio real por llamada)

  -- Performance
  duration_ms   integer,
  started_at    timestamptz,

  -- Estado
  status        text default 'success', -- 'success' | 'error' | 'timeout'
  error_code    text,

  -- Metadata adicional (resolución imagen, steps, etc.)
  metadata      jsonb default '{}',

  created_at    timestamptz default now()
);

-- Índices para queries de analytics frecuentes
create index if not exists fel_project_id  on v57.forge_execution_log (project_id);
create index if not exists fel_triggered   on v57.forge_execution_log (triggered_by);
create index if not exists fel_created_at  on v57.forge_execution_log (created_at desc);
create index if not exists fel_executor    on v57.forge_execution_log (executor_type, provider);
