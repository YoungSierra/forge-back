-- ─── Image generation fields for step_configs ───────────────────────────────
alter table step_configs
  add column if not exists image_enabled          boolean not null default false,
  add column if not exists image_integration_type text check (image_integration_type in ('llm', 'comfyui', 'n8n')),
  add column if not exists image_model            text,
  add column if not exists image_workflow_id      uuid references comfyui_workflows(id),
  add column if not exists image_webhook_url      text;
