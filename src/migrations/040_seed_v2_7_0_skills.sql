-- ============================================================
-- Migration 040 — Registra los 5 skills nuevos de v2.7.0 en forge_skill_configs.
-- Nodos: 3.0 (project_identity_engine), 3.2 (mechanic_engineering), 3.9 (ui_scene_registry),
--        3.12 (tdd_template_population + consistency_reconciliation).
-- tdd_template_population REEMPLAZA a technical_design_document_writing en el DNA del 3.12.
-- Fuente: _PreProd 0707/v.2.7.0/new_skills/.  Idempotente: ON CONFLICT (key) DO UPDATE.
-- ============================================================

INSERT INTO v57.forge_skill_configs (key, r2_path, description) VALUES
  ('consistency_reconciliation', 'skills/consistency_reconciliation.md', 'Convert "a collection of node outputs" into "one coherent game": resolve orphans, verify slice closure, check coverage, evaluate cross-system invariants, consolidate pending markers, certify the §0.2 gate.'),
  ('mechanic_engineering', 'skills/mechanic_engineering.md', 'Turn each designed mechanic into an engineering-ready record a production pipeline can build from — quantified, testable, dependency-resolved.'),
  ('project_identity_engine', 'skills/project_identity_engine.md', 'Fix the non-design identity: exact engine pin, pipeline, dimension, architecture, input system, save/multiplayer models, input map skeleton, performance baselines.'),
  ('tdd_template_population', 'skills/tdd_template_population.md', 'Populate every slot of the TDD standard from upstream node outputs — never invented at assembly time — and leave the document gate-certifiable (§0.2, G-01..G-15).'),
  ('ui_scene_registry', 'skills/ui_scene_registry.md', '')
ON CONFLICT (key) DO UPDATE SET
  r2_path     = EXCLUDED.r2_path,
  description = EXCLUDED.description,
  updated_at  = now();
