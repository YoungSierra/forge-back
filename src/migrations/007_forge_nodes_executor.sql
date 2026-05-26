-- ============================================================
-- Migration 007 — Executor config en forge_nodes
-- Agrega columna executor JSONB para configurar el backend
-- de ejecución de cada nodo (llm / comfyui / hybrid).
--
-- Estructura del campo:
--   null                          → usa LLM con modelo global por defecto
--   {"type":"llm","model":"gemini:gemini-2.5-flash"}
--   {"type":"comfyui","workflow_id":"uuid"}
--   {"type":"hybrid","model":"gemini:gemini-2.5-flash","workflow_id":"uuid"}
-- ============================================================

alter table v57.forge_nodes
  add column if not exists executor jsonb default null;
