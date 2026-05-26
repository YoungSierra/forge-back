-- Migration 008 — forge_assets: columna content para outputs de texto
-- Permite guardar markdown/json/texto directamente sin subir a R2.

alter table v57.forge_assets
  add column if not exists content text;
