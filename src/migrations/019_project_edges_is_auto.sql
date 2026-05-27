-- ============================================================
-- Migration 019 — Agregar is_auto a forge_project_edges
-- Permite distinguir edges auto-wireados de los manuales.
-- ============================================================

ALTER TABLE v57.forge_project_edges
  ADD COLUMN IF NOT EXISTS is_auto BOOLEAN NOT NULL DEFAULT false;
