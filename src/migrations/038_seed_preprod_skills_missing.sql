-- ============================================================
-- Migration 038 — Registra los 5 skills de competencia faltantes de Pre-Producción
-- (GDD Assembly 3.8 y TDD 3.12) en forge_skill_configs.
-- El r2_path apunta a la key del objeto en el bucket forge-system-prompts.
-- CONVENCIÓN: subir cada .md a  skills/<key>.md  en ese bucket.
-- Fuente: _PreProd 0707/5 Skills faltantes/.  Idempotente: ON CONFLICT (key) DO UPDATE.
-- ============================================================

INSERT INTO v57.forge_skill_configs (key, r2_path, description) VALUES
  ('gdd_template_population', 'skills/gdd_template_population.md', 'Fill discipline for GDD Assembly (3.8): transcribe the upstream design outputs (3.1-3.7) into the canonical GDD section structure without loss, duplication or invention — every section sourced from a node, never created at assembly time.'),
  ('forward_brief_authoring', 'skills/forward_brief_authoring.md', 'Derive the GDD''s per-discipline forward briefs (3.8): compact hand-offs that carry the GDD''s decisions into the ADI (3.9), Audio (3.10), TDD (3.12) and Production Plan (3.14) as authored intent, not summaries.'),
  ('engine_selection', 'skills/engine_selection.md', 'Choose and justify the engine + version and render pipeline for the TDD (3.12) against the visual targets (3.9) and the real team profile, stating the consequences. A project-specific decision, not a generic "best engine" essay.'),
  ('pipeline_design', 'skills/pipeline_design.md', 'Define the concrete asset/build pipeline for the TDD (3.12): formats, import settings, naming/folder conventions, source-control model and the source-asset-to-in-engine path — consistent with the chosen engine and the ADI asset expectations; the seam to the Unity/MCP handoff (3.17).'),
  ('feasibility_assessment', 'skills/feasibility_assessment.md', 'The honesty gate of the TDD (3.12): a defensible verdict on whether the chosen engine, pipeline and custom systems can actually be built to the art targets by the real team, time and budget — naming the specific risks that would break it.')
ON CONFLICT (key) DO UPDATE SET
  r2_path     = EXCLUDED.r2_path,
  description = EXCLUDED.description,
  updated_at  = now();
