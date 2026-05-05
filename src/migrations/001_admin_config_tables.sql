-- ─── ComfyUI workflow definitions ───────────────────────────────────────────
create table if not exists comfyui_workflows (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  description   text,
  workflow_json jsonb not null,
  inject_config jsonb not null default '{}',
  is_active     boolean not null default true,
  created_by    uuid references members(id),
  updated_by    uuid references members(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── Per-step integration config ─────────────────────────────────────────────
-- integration_type:
--   'llm'     → LLM call (text/doc output)
--   'comfyui' → image generation via ComfyUI (may call LLM internally for prompts)
--   'n8n'     → delegated to n8n webhook
create table if not exists step_configs (
  id                   uuid primary key default gen_random_uuid(),
  step_key             text not null unique,
  integration_type     text not null check (integration_type in ('llm', 'comfyui', 'n8n')),
  model_name           text,                   -- null = use DEFAULT_MODEL
  comfyui_workflow_id  uuid references comfyui_workflows(id),
  webhook_url          text,
  extra_params         jsonb not null default '{}',
  is_active            boolean not null default true,
  updated_by           uuid references members(id),
  updated_at           timestamptz not null default now()
);

-- ─── Seed: step configs ───────────────────────────────────────────────────────
insert into step_configs (step_key, integration_type) values
  -- Shared / wizard steps
  ('gdd',                  'llm'),
  ('levels',               'llm'),
  ('code',                 'llm'),
  ('audio',                'llm'),
  ('sfx',                  'llm'),
  ('playtesting',          'llm'),
  -- 2D pipeline — LLM
  ('visual_guide',         'llm'),
  ('art_direction_intake', 'llm'),
  -- 3D pipeline — LLM (each node has its own config)
  ('3d',                   'llm'),  -- legacy shared fallback
  ('modeling',             'llm'),
  ('charaters',            'llm'),  -- typo in gdd.routes.js — keep until fixed
  ('vfx',                  'llm'),
  ('texturing',            'llm'),
  ('rigging',              'llm'),
  ('lighting',             'llm'),
  ('animation',            'llm'),
  ('cinematics',           'llm'),
  ('voice',                'llm'),
  -- ComfyUI steps (workflow_id assigned later from admin panel)
  ('sprites',              'comfyui'),
  ('concept_art',          'comfyui'),
  ('backgrounds',          'comfyui'),
  ('uiux',                 'comfyui'),
  ('icons',                'comfyui'),
  ('hud',                  'comfyui'),
  ('splash',               'comfyui'),
  ('marketing',            'comfyui')
on conflict (step_key) do nothing;
