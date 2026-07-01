-- ============================================================
-- Migration 036 — Registra los 21 skills de Pre-Producción en forge_skill_configs.
-- El r2_path apunta a la key del objeto en el bucket forge-system-prompts.
-- CONVENCIÓN: subir cada .md a  skills/<key>.md  en ese bucket.
-- Idempotente: ON CONFLICT (key) DO UPDATE.
--
-- Nota: varios skills que referencian los nodos (anti_pillar_definition,
-- mechanic_specification, etc.) NO tienen .md propio — son sub-skills inline/bundled
-- y no se registran; getSkill() devuelve null y el nodo corre igual (inyección opcional).
-- ============================================================

INSERT INTO v57.forge_skill_configs (key, r2_path, description) VALUES
  ('design_pillar_formalization',      'skills/design_pillar_formalization.md',      'Formalize 3-4 testable design pillars (rules, not adjectives), anti-pillars, and the pillar-level feel statement from the locked concept. Enforces banned words.'),
  ('game_loop_design',                 'skills/game_loop_design.md',                 'Define the core loop (under 15 min), all mechanics with real numbers, win/lose, difficulty curve, integration map, and the mechanics-grounded feel statement.'),
  ('progression_system_design',        'skills/progression_system_design.md',        'Define progression and XP curve, internal economy with sink/source mapping, stats table, item catalog with drop rates and limits, and unlockables.'),
  ('world_building',                   'skills/world_building.md',                   'Build the universe: logline, history, 3-act arc with midpoint twist, themes expressed through mechanics, 4+ environments, faction map, and the narrative delivery system.'),
  ('level_design',                     'skills/level_design.md',                     'Specify per-level structure (environment, mechanics, objectives, duration, difficulty, item density, env-storytelling) and encounter design philosophy. First level teaches the full loop.'),
  ('character_design',                 'skills/character_design.md',                 'Define 3+ character profiles (role, look, personality, backstory, motivation, arc, abilities, mechanical role) plus a relationship map coherent with the faction map.'),
  ('ux_design',                        'skills/ux_design.md',                        'Design HUD (max 7 elements), full menu tree, control map (kb/mouse + gamepad), feedback rules, onboarding (teaches the loop in 10 min), and 5+ accessibility features.'),
  ('gdd_consistency_validation',       'skills/gdd_consistency_validation.md',       'Assemble the GDD by populating the fixed template, validate cross-section consistency (real numbers, banned words, no TBDs), author forward briefs, and gate Sub-Phase A.'),
  ('prototype_scoping',                'skills/prototype_scoping.md',                'Produce a build-ready spec for one mechanic: what to build, what NOT to build, 3-5 binary success criteria, playtest structure, and the structured build payload (target engine).'),
  ('v57_build_pipeline',               'skills/v57_build_pipeline.md',               'Back the Script Execution build nodes: receive the spec payload, surface validation checkpoints (blocking/advisory/allowlist), and return the build receipt. Build is external.'),
  ('playtest_analysis',                'skills/playtest_analysis.md',                'Review a prototype build against its success criteria, marking each MET/NOT MET with evidence and setting an overall PASS/FAIL/PARTIAL verdict with gaps.'),
  ('prototype_review_facilitation',    'skills/prototype_review_facilitation.md',    'Gather all mechanic-lane playtest results, present the package, and determine which mechanics ACCEPT/REFINE/KILL and advance to Vertical Slice (partial accept valid).'),
  ('vertical_slice_scoping',           'skills/vertical_slice_scoping.md',           'Define the vertical slice scope: one coherent slice at production art quality, mechanics covered, art quality bar, external-observable criteria, and the build payload.'),
  ('vertical_slice_review',            'skills/vertical_slice_review.md',            'Review the VS build against the vs_spec criteria and the art quality bar (style_guide), from an external-reviewer perspective. Binary MET/NOT MET.'),
  ('art_direction_intake',             'skills/art_direction_intake.md',             'Produce the Art Direction Document: visual identity, style guide, closed 4-role palette, character/environment rules, VFX language, technical targets, and native reference images.'),
  ('audio_direction_writing',          'skills/audio_direction_writing.md',          'Define the audio system: music and adaptive rules by game state, SFX catalog, VO plan, ambience per environment, and trigger/transition rules.'),
  ('monetization_model_design',        'skills/monetization_model_design.md',        'Define the revenue model, price point, currency system with sink/source mapping, IAP catalog (no pay-to-win), reward structure, and 3+ anti-inflation rules.'),
  ('technical_design_document_writing','skills/technical_design_document_writing.md','Specify engine + version, art pipeline, audio middleware, platform specs, custom systems (each justified), and a feasibility check against art targets and team size.'),
  ('production_planning',              'skills/production_planning.md',              'Turn the GDD/TDD/ADD and prototype results into a roadmap: team, phases, milestones with measurable criteria, budget by category, and a risk register (min 4 risks).'),
  ('product_scope_management',         'skills/product_scope_management.md',         'Maintain the living Product Scope: VS goals, production-readiness criteria, launch/post-launch scope, prioritized cuttable features, and the non-negotiable minimum.'),
  ('pre_production_review_facilitation','skills/pre_production_review_facilitation.md','Validate the full Pre-Production package (GDD/TDD/ADD/Plan/prototypes) and frame the ACCEPT/REFINE/HOLD gate decision into Production.')
ON CONFLICT (key) DO UPDATE SET
  r2_path     = EXCLUDED.r2_path,
  description = EXCLUDED.description,
  updated_at  = now();
