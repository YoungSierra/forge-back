-- ============================================================
-- Migration 037 — Reseed Pre-Production nodes (v2.6.0, 22 nodos)
-- Generado por scripts/import-preprod-nodes-v26.js desde NodeDNA v2.6.0.
-- Orden: documentation-first / builds-last. GDD = 3.8, TDD = 3.12.
-- Reemplaza por completo el seed viejo del 035 (v2.5.2).
--
-- WIPE LIMPIO: ningún proyecto referencia nodos 3.X (confirmado), así que se borran
-- todas las filas pre-producción viejas (incl. el huérfano '3.4b') y se siembra desde
-- cero. Re-ejecutable: el DELETE + INSERT deja siempre el set v2.6.0 exacto (los UUIDs
-- se regeneran en cada corrida — no correr con proyectos activos cargados).
-- ============================================================

ALTER TABLE v57.forge_nodes ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

-- Borrado limpio de la pre-producción vieja (3.1-3.6, 3.4b del 035).
DELETE FROM v57.forge_nodes WHERE phase = 'pre-production';

-- ─── 3.1 Design Pillars  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.1', 'Design Pillars', 'pre-production', 'standard', 'archived',
  'Formalize 3-4 named design pillars and anti-pillars from the locked concept package, plus the pillar-level feel statement; the consistency filter for every downstream Design node.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'You are formalizing the design foundations for [project] from the locked concept package. Pillars are testable rules, not adjectives.',
  'Each pillar is an actionable, testable rule with a validation criterion — not an adjective. Anti-pillars mandatory. Feel statement 3-4 sentences. Pillars are content derived from the concept, never a default set.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['design_pillar_formalization','anti_pillar_definition','feel_statement_writing']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"concept_data","cardinality":"single","type":"concept_data","required":true}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"design_pillars","label":"Design Pillars","type":"connection","format":"design_pillars","prompt":"Emit 3-4 named pillars, each with an actionable testable description and a validation criterion, plus the anti-pillars. Each pillar traces to the concept''s core fantasy or loop.","uses":{"inputs":["concept_data"],"siblings_if_present":[]},"note":"Most-referenced Connection in Sub-Phase A; wired into 3.2-3.7."},{"key":"feel_statement","label":"Feel Statement","type":"connection","format":"feel_statement","prompt":"Emit the pillar-level feel statement (level=pillar): 3-4 sentences on the moment-to-moment experience the pillars promise. 3.2 refines this into a mechanics-grounded version.","uses":{"inputs":["concept_data"],"siblings_if_present":["design_pillars"]}},{"key":"design_pillars_doc","label":"Design Pillars Doc","type":"asset","format":"docx","prompt":"Write the Design Pillars document (pillar matrix table, anti-pillars, feel statement), identical in substance to the connections. Neutral editorial — no art direction exists yet.","uses":{"inputs":["concept_data"],"siblings_if_present":["design_pillars","feel_statement"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"A1","depends_on":[],"status":"mandatory_in_full_preprod | mandatory_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.2 Core Gameplay  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.2', 'Core Gameplay', 'pre-production', 'standard', 'archived',
  'Define the core loop, all mechanics with concrete rules and real numbers, win/lose conditions, difficulty curve, and the integration map between mechanics.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Define the core gameplay for [project] from the design pillars. Real numbers throughout; every mechanic reinforces a pillar. For each mechanic also emit the engineering-ready record (TDD §B): player_facing {goal, loop, ui_feedback, tuning_levers}; quantified rules; io {player_inputs, system_inputs, outputs as event+payload}; dependencies {kind,id}; preconditions; state_machine or N/A; components (name/type/suggested_path/events); public_api; edge_cases; and >=1 testable acceptance_criterion (EditMode/PlayMode). Emit graph_edges per mechanic for the §D dependency graph.',
  'Core loop under 15 minutes. All mechanics require real numbers — no ''high damage'', yes ''45 base damage ±20%''. Every mechanic reinforces a design pillar. Integration map required. TDD INTEGRATION (§B): every mechanic must be engineering-ready — quantified rules, inputs/outputs (events+payload), dependencies (kind+id), state machine (or N/A), component sketch, public API, edge cases, and >=1 testable acceptance criterion tagged EditMode/PlayMode. A mechanic without an acceptance criterion is incomplete.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['game_loop_design','mechanic_specification','difficulty_curve_design','real_numbers_constraint']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":true},{"key":"feel_statement","cardinality":"single","type":"feel_statement","required":true},{"key":"concept_data","cardinality":"single","type":"concept_data","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"core_loop","label":"Core Loop","type":"connection","format":"core_loop","prompt":"Emit the named loop (4 steps: action / response / feedback / reward), duration under 15 min, retention hook, win/lose with fail-state consequences.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":[]}},{"key":"mechanic_specs","label":"Mechanic Specs","type":"connection","format":"list<mechanic_spec>","prompt":"Emit all mechanics, each with concrete rules and real numbers, plus an integration map of how they affect each other. INSTANCING TRIGGER: fans out one prototype lane per mechanic at the Prototype Specification node.","uses":{"inputs":["design_pillars"],"siblings_if_present":["core_loop"]},"note":"ENGINEERING-READY (TDD §B). Each mechanic_spec carries: quantified rules, io, dependencies, state_machine, components, public_api, edge_cases, >=1 testable acceptance_criterion, graph_edges, slice_scope. Still the fan-out trigger for the Prototype Specification node."},{"key":"feel_statement","label":"Feel Statement","type":"connection","format":"feel_statement","prompt":"Re-emit the feel statement grounded in the mechanics (level=mechanics); show how the mechanics express the pillar feel. Replaces the upstream value for all downstream nodes. ↻ consumed-and-refined.","uses":{"inputs":["feel_statement"],"siblings_if_present":["mechanic_specs","core_loop"]}},{"key":"core_gameplay_spec","label":"Core Gameplay Spec","type":"asset","format":"docx","prompt":"Write the core gameplay spec: loop, mechanics with real numbers, difficulty curve with escalation points, integration map. Identical to the connections.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":["core_loop","mechanic_specs"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"A1","depends_on":["3.1"],"status":"mandatory_in_full_preprod | mandatory_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.3 Game Systems  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.3', 'Game Systems', 'pre-production', 'standard', 'archived',
  'Define the secondary systems supporting the core loop: progression, internal economy, player stats, abilities, inventory, unlockables, and the full item catalog.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Define all game systems for [project]: progression and XP curve, internal economy with sink/source mapping, stats table, abilities, unlockables, and the complete item catalog. Real numbers throughout.',
  'Every stat affects >=1 mechanic. Every currency source has a documented sink. Phase durations in concrete hours. Item catalog required: each item has a numeric value, drop_rate (0-1), stack/carry limit, and integration with >=1 mechanic.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['progression_system_design','economy_balancing','stats_and_abilities_design']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"core_loop","cardinality":"single","type":"core_loop","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":true},{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"progression_sys","label":"Progression Sys","type":"connection","format":"progression_sys","prompt":"Progression philosophy + XP curve with concrete hour values; unlockables by category.","uses":{"inputs":["core_loop","mechanic_specs"],"siblings_if_present":[]}},{"key":"economy_design","label":"Economy Design","type":"connection","format":"economy_design","prompt":"Internal economy: every currency with sink & source mapping. Feeds Monetization (3.11).","uses":{"inputs":["mechanic_specs"],"siblings_if_present":[]}},{"key":"player_stats","label":"Player Stats","type":"connection","format":"player_stats","prompt":"Full stats table base/max/growth; every stat affects >=1 mechanic.","uses":{"inputs":["mechanic_specs"],"siblings_if_present":[]}},{"key":"item_catalog","label":"Item Catalog","type":"connection","format":"item_catalog","prompt":"Complete item list: each {id, name, category, effect, value, drop_rate(0-1), stack_limit, carry_limit, duration_ms?}, each integrated with >=1 mechanic. Feeds 3.5, 3.7, 3.9.","uses":{"inputs":["mechanic_specs"],"siblings_if_present":["economy_design"]}},{"key":"game_systems_spec","label":"Game Systems Spec","type":"asset","format":"docx","prompt":"Write the game systems spec, identical to the connections. Real tables for stats, economy, items.","uses":{"inputs":["core_loop","mechanic_specs"],"siblings_if_present":["progression_sys","economy_design","player_stats","item_catalog"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"A2","depends_on":["3.2"],"status":"mandatory_in_full_preprod | optional_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.4 World Design  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.4', 'World Design', 'pre-production', 'standard', 'archived',
  'Build the universe: lore, world history, 3-act narrative arc, 4+ environments with gameplay roles, faction map, and the narrative delivery system.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Build the world for [project]: logline, setting, 4-5 sentence history, 3-act arc with midpoint twist, 3+ themes that manifest in gameplay, faction map, 4+ environments (look / gameplay role / narrative meaning), and the narrative delivery system. Lore must justify the core loop.',
  'Minimum 4 fully described environments. Lore justifies the player''s actions in the core loop. >=1 narrative theme expressed through a mechanic. History in 4-5 sentences. Narrative delivery system required (dialogue trigger system, tree structure, skip mechanic; cutscene frequency/duration if used).',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['world_building','narrative_arc_design','environment_design','faction_design']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":true},{"key":"feel_statement","cardinality":"single","type":"feel_statement","required":true},{"key":"core_loop","cardinality":"single","type":"core_loop","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"world_lore","label":"World Lore","type":"connection","format":"world_lore","prompt":"Logline, setting, 4-5 sentence history, 3+ themes manifesting in gameplay.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":[]}},{"key":"environments_x4","label":"Environments X4","type":"connection","format":"environments_x4","prompt":"4+ environments, each with visual look / gameplay role / narrative meaning. Feeds Art Direction (3.9).","uses":{"inputs":["design_pillars"],"siblings_if_present":["world_lore"]}},{"key":"faction_map","label":"Faction Map","type":"connection","format":"faction_map","prompt":"Faction map with relationships.","uses":{"inputs":["world_lore"],"siblings_if_present":[]}},{"key":"narrative_arc","label":"Narrative Arc","type":"connection","format":"narrative_arc","prompt":"3-act arc with midpoint twist and per-act beats. Feeds Art Direction (3.9) for visual tone shifts.","uses":{"inputs":["world_lore"],"siblings_if_present":[]}},{"key":"dialogue_system","label":"Dialogue System","type":"connection","format":"dialogue_system","prompt":"Narrative delivery spec: trigger system, dialogue tree structure, skip mechanic, VO approach/scope; cutscene frequency/duration/engine if used. Feeds 3.7 (dialogue UI) and 3.10 (VO scope).","uses":{"inputs":["world_lore"],"siblings_if_present":["narrative_arc"]}},{"key":"world_bible","label":"World Bible","type":"asset","format":"docx","prompt":"Write the world bible (large doc, LLM-generated section index), identical to the connections.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":["world_lore","environments_x4","faction_map","narrative_arc","dialogue_system"]},"section_index":"llm_generated"}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"A2","depends_on":["3.1","3.2"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.5 Level Design  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.5', 'Level Design', 'pre-production', 'standard', 'archived',
  'Define the level structure: per-level spatial layout, objectives, pacing arc, difficulty placement, environmental storytelling, and encounter design philosophy — the spatial expression of the core loop.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Design the complete level structure for [project]. Per level: all required fields with real numbers. First level teaches the full core loop. Encounter design philosophy with placement rules and difficulty scaling. No vague terms.',
  'Every level names: environment, primary mechanic(s), new mechanic (or none), objective type, duration in minutes, pacing arc, difficulty delta vs previous, item spawn density, one env-storytelling beat. No ''various/different/multiple/several'' without enumeration. First level teaches the full core loop with no tutorial screen.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['level_design','encounter_design','pacing_design','environmental_storytelling','difficulty_curve_mapping']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"world_lore","cardinality":"single","type":"world_lore","required":true},{"key":"environments_x4","cardinality":"one_or_more","type":"environments_x4","required":true},{"key":"core_loop","cardinality":"single","type":"core_loop","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":true},{"key":"progression_sys","cardinality":"single","type":"progression_sys","required":false},{"key":"narrative_arc","cardinality":"single","type":"narrative_arc","required":false},{"key":"item_catalog","cardinality":"single","type":"item_catalog","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"level_map","label":"Level Map","type":"connection","format":"level_map","prompt":"Complete level list with structure, objectives, pacing, difficulty placement and item density per level. Feeds 3.7 (objective display, onboarding) and 3.12 (streaming/loading).","uses":{"inputs":["world_lore","environments_x4","core_loop","mechanic_specs"],"siblings_if_present":[]}},{"key":"encounter_design","label":"Encounter Design","type":"connection","format":"encounter_design","prompt":"Encounter philosophy, enemy placement rules, difficulty scaling, encounter templates. Feeds 3.7 (feedback) and 3.12 (AI complexity).","uses":{"inputs":["mechanic_specs","environments_x4"],"siblings_if_present":["level_map"]}},{"key":"level_design_doc","label":"Level Design Doc","type":"asset","format":"docx","prompt":"Full level design document, one section per level plus global encounter philosophy.","uses":{"inputs":["world_lore","environments_x4","core_loop","mechanic_specs"],"siblings_if_present":["level_map","encounter_design"]},"section_index":"llm_generated"}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"A2b","depends_on":["3.4","3.2"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.6 Characters  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.6', 'Characters', 'pre-production', 'standard', 'archived',
  'Define 3+ complete character profiles with narrative arcs, mechanical roles, protagonist abilities tied to identity, and a relationship map coherent with the faction map.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Define 3+ characters for [project]. Each: role, look, personality, backstory, motivation, narrative arc, gameplay abilities and mechanical role. Relationship map. Names must fit the established world.',
  'Minimum 3 profiles. Names coherent with setting. Protagonist motivation compatible with the world logline. Mechanical roles documented for every character. Protagonist abilities (2-3) tied to identity, not generic.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['character_design','narrative_arc_writing','mechanical_role_assignment']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"world_lore","cardinality":"single","type":"world_lore","required":true},{"key":"faction_map","cardinality":"single","type":"faction_map","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"char_profiles","label":"Char Profiles","type":"connection","format":"char_profiles","prompt":"Per character: role, look, personality, backstory, motivation, arc, abilities, mechanical role; plus the relationship map. Feeds 3.7 and 3.9.","uses":{"inputs":["world_lore","faction_map"],"siblings_if_present":[]}},{"key":"char_abilities","label":"Char Abilities","type":"connection","format":"char_abilities","prompt":"Protagonist abilities (2-3) tied to identity, each with a mechanical hook. Feeds 3.7 (control map/HUD) and 3.9 (ability VFX).","uses":{"inputs":["mechanic_specs"],"siblings_if_present":["char_profiles"]}},{"key":"character_bible","label":"Character Bible","type":"asset","format":"docx","prompt":"Write the character bible, identical to the connections.","uses":{"inputs":["world_lore","faction_map"],"siblings_if_present":["char_profiles","char_abilities"]},"section_index":"llm_generated"}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"A2b","depends_on":["3.4"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.7 UX / UI Design  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.7', 'UX / UI Design', 'pre-production', 'standard', 'archived',
  'Define how the player interacts on screen: HUD, full menu tree, control map, visual feedback rules, onboarding flow, and accessibility features.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Design the UX/UI for [project]: HUD element table (max 7), full menu tree, complete control map (kb/mouse + gamepad, incl. all char_abilities), visual feedback rules by event type, onboarding (first 10 min teaches the loop, no tutorial screen), 5+ accessibility features.',
  'HUD max 7 simultaneous elements (more requires justification). Onboarding teaches the full loop in 10 minutes without a tutorial screen. 5+ accessibility features with implementation. Control map covers keyboard/mouse AND gamepad. Objective indicator per level_map objective type. Inventory display per item_catalog limits. Dialogue UI if dialogue scope is not none.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['ux_design','hud_design','menu_architecture','accessibility_design','onboarding_flow_design']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"core_loop","cardinality":"single","type":"core_loop","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":true},{"key":"player_stats","cardinality":"single","type":"player_stats","required":true},{"key":"level_map","cardinality":"single","type":"level_map","required":true},{"key":"char_profiles","cardinality":"one_or_more","type":"char_profiles","required":false},{"key":"encounter_design","cardinality":"single","type":"encounter_design","required":false},{"key":"char_abilities","cardinality":"one_or_more","type":"char_abilities","required":false},{"key":"dialogue_system","cardinality":"single","type":"dialogue_system","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"hud_layout","label":"Hud Layout","type":"connection","format":"hud_layout","prompt":"HUD element table (max 7): position / data / visibility rule / mechanic served; objective indicator per level_map objective type.","uses":{"inputs":["core_loop","player_stats","level_map"],"siblings_if_present":[]}},{"key":"menu_tree","label":"Menu Tree","type":"connection","format":"menu_tree","prompt":"Full menu tree.","uses":{"inputs":["player_stats"],"siblings_if_present":[]}},{"key":"control_map","label":"Control Map","type":"connection","format":"control_map","prompt":"Complete control map for keyboard/mouse and gamepad, including all char_abilities mapped to inputs.","uses":{"inputs":["mechanic_specs","char_abilities"],"siblings_if_present":[]}},{"key":"feedback_system","label":"Feedback System","type":"connection","format":"feedback_system","prompt":"Visual feedback rules by event type (trigger -> animation -> color shift -> sound -> duration ms, with priority). Feeds 3.9 (VFX) and 3.12 (rendering budget).","uses":{"inputs":["mechanic_specs","encounter_design"],"siblings_if_present":[]}},{"key":"ux_ui_spec","label":"Ux Ui Spec","type":"asset","format":"docx","prompt":"Write the UX/UI spec, identical to the connections, with the onboarding flow and accessibility features.","uses":{"inputs":["core_loop","mechanic_specs","player_stats","level_map"],"siblings_if_present":["hud_layout","menu_tree","control_map","feedback_system"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"A3","depends_on":["3.2","3.3","3.5","3.4b"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.8 GDD Assembly  (Assembly) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.8', 'GDD Assembly', 'pre-production', 'standard', 'archived',
  'Compile all accepted Design nodes into the complete GDD by populating the fixed Forge_GDD_Template_v2.4.0 (14 sections mapped to nodes), validate cross-section consistency, author the forward briefs the template carries (§9 Audio Brief -> 3.10, §10 Technical Systems Brief -> 3.12, §11 MVP/Prototype Scope -> 3.16), seed §12 Product Scope for 3.15, and gate Sub-Phase A.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Assemble the GDD for [project] by populating Forge_GDD_Template_v2.4.0 from all accepted Design nodes. Validate name consistency, mechanic-lore coherence, character-world coherence, the REAL NUMBERS RULE and BANNED WORDS. Author the forward briefs (§9 audio, §10 technical, §11 prototype scope) and seed §12 product scope. Flag any contradiction or TBD before gate approval.',
  'Populate the fixed Forge_GDD_Template_v2.4.0 — do not invent a section structure. Zero TBD placeholders. Zero contradictions between sections. Name consistency across all sections. Honor the REAL NUMBERS RULE and the template''s BANNED WORDS list at the gate. Assembly produces no new design content beyond the forward briefs (§9/§10/§11) and the §12 product-scope seed.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['gdd_consistency_validation','gdd_template_population','forward_brief_authoring']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":true},{"key":"core_loop","cardinality":"single","type":"core_loop","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":true},{"key":"progression_sys","cardinality":"single","type":"progression_sys","required":false},{"key":"economy_design","cardinality":"single","type":"economy_design","required":false},{"key":"player_stats","cardinality":"single","type":"player_stats","required":false},{"key":"world_lore","cardinality":"single","type":"world_lore","required":false},{"key":"environments_x4","cardinality":"one_or_more","type":"environments_x4","required":false},{"key":"faction_map","cardinality":"single","type":"faction_map","required":false},{"key":"narrative_arc","cardinality":"single","type":"narrative_arc","required":false},{"key":"char_profiles","cardinality":"one_or_more","type":"char_profiles","required":false},{"key":"hud_layout","cardinality":"single","type":"hud_layout","required":false},{"key":"level_map","cardinality":"single","type":"level_map","required":false},{"key":"encounter_design","cardinality":"single","type":"encounter_design","required":false},{"key":"item_catalog","cardinality":"single","type":"item_catalog","required":false},{"key":"dialogue_system","cardinality":"single","type":"dialogue_system","required":false},{"key":"feedback_system","cardinality":"single","type":"feedback_system","required":false},{"key":"concept_data","cardinality":"single","type":"concept_data","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"gdd_ref","label":"Gdd Ref","type":"connection","format":"gdd_ref","prompt":"Emit the typed reference to the assembled GDD (which carries the §9 audio, §10 technical and §11 prototype-scope briefs). Wired into 3.16, 3.13, 3.10, 3.12, 3.14 as context.","uses":{"inputs":[],"siblings_if_present":["gdd_complete"]}},{"key":"gdd_complete","label":"Gdd Complete","type":"asset","format":"docx","prompt":"Populate the fixed 14-section GDD template (§1 Game Identity from concept_data · §2 Design Pillars from 3.1 · §3 Core Gameplay from 3.2 · §4 Game Systems from 3.3 · §5 World & Narrative from 3.4 · §6 Level Design from 3.5 · §7 Characters from 3.6 · §8 UX/UI from 3.7 · §9 Audio Brief · §10 Technical Systems Brief · §11 MVP/Prototype Scope · §12 Product Scope seed · §13 Monetization ref · §14 External Doc refs). Ready for engineering spec and investor pitch.","uses":{"inputs":["design_pillars","core_loop","mechanic_specs"],"siblings_if_present":["progression_sys","economy_design","player_stats","world_lore","environments_x4","faction_map","narrative_arc","char_profiles","hud_layout","level_map","encounter_design","item_catalog","dialogue_system","feedback_system"]},"template":"Forge_GDD_Template_v2.4.0"}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"Assembly","sub_phase":"1_documentation","group":"A_gate","depends_on":["3.1","3.2","3.3","3.4","3.4b","3.5","3.6"],"status":"mandatory_in_full_preprod | optional_lightweight_in_ideation_factory","amendments":["real_files","two_pass_qa","structure_not_skin","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.9 Art Direction Document  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.9', 'Art Direction Document', 'pre-production', 'standard', 'archived',
  'Produce the complete Art Bible (Framework 11.0 v6.0, 9 phases), emit the art_bible_intake brief + the Visual Production Blueprint, segment the Art Bible into the 11 production packages (11.1–11.11), and emit one asset_brief per production asset from the Phase 8 breakdown. Sole image producer.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Produce the Art Direction Document for [project] using Framework 11.0 v6.0. Skill ''Template Interpretation'': map the 9 phases, REQUIRED/OPTIONAL fields and conditional triggers. Skill ''Art Bible Intake'': generate the master Art Bible (Phases 1–9) from the GDD + NodeDNA inputs (narrative_arc, char_abilities, feedback_system, item_catalog, dialogue_system). Skill ''ADI Segmentation'': split the Art Bible into the 11 production packages (11.1–11.11), each holding only its mapped sections; mark skipped conditional sections N/A with justification. Emit style_guide, color_palette (4 roles + hex), visual_targets, the art_bible_intake brief, the Visual Production Blueprint, and one asset_brief per production asset (asset_id, category, name, narrative_purpose, gameplay_purpose, visual_importance, technical_constraints, production_priority, visual_rules_flags). Generate 4–6 reference images.',
  'ADI (Framework 11.0 v6.0): run the 9 phases; complete REQUIRED fields and applicable conditional sections (skipped = N/A justified); Core Fantasy Statement = one sentence; 3–5 Visual Pillars; Style Boundary Test on >=3 assets; §7.9 Animation Style Statement ready for 11.6; colour palette = 4 roles with hex. The ADI Segmentation skill emits all 11 packages inside this node (11.1–11.11), each scoped to its stage; the Production art nodes CONSUME these packages + the asset_briefs (they do not re-segment). asset_briefs are distilled from the Phase 8 Asset Breakdown. art_bible_intake is emitted once the Art Bible is accepted. Skills run in order: Template Interpretation → Art Bible Intake → ADI Segmentation.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['art_direction_intake','adi_segmentation','art_bible_writing','style_guide_production','palette_design','v57_image_prompt_architecture']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"world_lore","cardinality":"single","type":"world_lore","required":true},{"key":"environments_x4","cardinality":"one_or_more","type":"environments_x4","required":true},{"key":"char_profiles","cardinality":"one_or_more","type":"char_profiles","required":true},{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":true},{"key":"feel_statement","cardinality":"single","type":"feel_statement","required":false},{"key":"char_abilities","cardinality":"one_or_more","type":"char_abilities","required":false},{"key":"narrative_arc","cardinality":"single","type":"narrative_arc","required":false},{"key":"feedback_system","cardinality":"single","type":"feedback_system","required":false},{"key":"item_catalog","cardinality":"single","type":"item_catalog","required":false},{"key":"dialogue_system","cardinality":"single","type":"dialogue_system","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"style_guide","label":"Style Guide","type":"connection","format":"style_guide","prompt":"Character and environment style rules + reference rationale. Wired into VS Specification (3.13) and TDD (3.12).","uses":{"inputs":["world_lore","environments_x4","char_profiles","design_pillars"],"siblings_if_present":[]}},{"key":"color_palette","label":"Color Palette","type":"connection","format":"color_palette","prompt":"Closed 4-role palette (primary/secondary/accent/danger) with hex values and use rules.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":["style_guide"]}},{"key":"visual_targets","label":"Visual Targets","type":"connection","format":"visual_targets","prompt":"Resolution / FPS / pipeline / key VFX list. Wired into TDD (3.12).","uses":{"inputs":["feedback_system"],"siblings_if_present":["style_guide"]}},{"key":"art_bible_intake","label":"Art Bible Intake","type":"connection","format":"art_bible_intake","note":"Structured ADI brief (Framework 11.0 v6.0). Emitted once the Art Bible is accepted; consumed by the Production-phase art nodes (11.2–11.11) which produce their own segment packages."},{"key":"asset_briefs","label":"Asset Briefs","type":"connection","format":"list<asset_brief>","note":"One asset_brief per production asset (from the Phase 8 Asset Breakdown). The seam the Production Concept Art blueprint consumes as asset_brief_data."},{"key":"art_direction_document","label":"Art Direction Document","type":"asset","format":"docx","prompt":"Write the full Art Bible (style guide, palette, references, character/environment rules, ability VFX, narrative visual response), with the reference images attached.","uses":{"inputs":["world_lore","environments_x4","char_profiles","design_pillars"],"siblings_if_present":["style_guide","color_palette","visual_targets","reference_images"]},"section_index":"llm_generated"},{"key":"reference_images","label":"Reference Images","type":"asset","format":"png","prompt":"Generate 4-6 native images covering key environments and character types, holding the locked palette.","uses":{"inputs":["environments_x4","char_profiles"],"siblings_if_present":["color_palette","style_guide"]},"image_gen":true},{"key":"ADI_11.1_ConceptArt","label":"ADI 11.1 ConceptArt","type":"asset","format":"docx"},{"key":"visual_production_blueprint","label":"Visual Production Blueprint","type":"asset","format":"docx"},{"key":"ADI_11.2_2DVisualProduction","label":"ADI 11.2 2DVisualProduction","type":"asset","format":"docx"},{"key":"ADI_11.3_3DAssetProduction","label":"ADI 11.3 3DAssetProduction","type":"asset","format":"docx"},{"key":"ADI_11.4_TexturingMaterials","label":"ADI 11.4 TexturingMaterials","type":"asset","format":"docx"},{"key":"ADI_11.5_RiggingSkinning","label":"ADI 11.5 RiggingSkinning","type":"asset","format":"docx"},{"key":"ADI_11.6_AnimationProduction","label":"ADI 11.6 AnimationProduction","type":"asset","format":"docx"},{"key":"ADI_11.7_EngineIntegration","label":"ADI 11.7 EngineIntegration","type":"asset","format":"docx"},{"key":"ADI_11.8_VFXParticles","label":"ADI 11.8 VFXParticles","type":"asset","format":"docx"},{"key":"ADI_11.9_AudioDirection","label":"ADI 11.9 AudioDirection","type":"asset","format":"docx"},{"key":"ADI_11.10_LevelDesign","label":"ADI 11.10 LevelDesign","type":"asset","format":"docx"},{"key":"ADI_11.11_MarketingArt","label":"ADI 11.11 MarketingArt","type":"asset","format":"docx"}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"C","depends_on":["3.7"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.10 Audio Direction  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.10', 'Audio Direction', 'pre-production', 'standard', 'archived',
  'Define the complete audio system: music genre and adaptive rules, SFX catalog, VO plan, ambience per environment, and trigger/transition rules.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Define the audio system for [project]: musical genre and adaptive rules by game state, SFX catalog, VO plan (scope from dialogue_system), ambience per environment, triggers/transitions. Every game state has an audio rule.',
  'Every game state has an assigned music track or rule. Ambience per environment. VO/music scope feasible within the budget (cross-validated at 3.14). Audio tone matches the visual palette.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['audio_direction_writing','adaptive_audio_design','sfx_catalog_structuring']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"feel_statement","cardinality":"single","type":"feel_statement","required":true},{"key":"world_lore","cardinality":"single","type":"world_lore","required":true},{"key":"environments_x4","cardinality":"one_or_more","type":"environments_x4","required":true},{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":false},{"key":"dialogue_system","cardinality":"single","type":"dialogue_system","required":false},{"key":"gdd_ref","cardinality":"single","type":"gdd_ref","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"audio_direction","label":"Audio Direction","type":"connection","format":"audio_direction","prompt":"Emit the audio direction: music + adaptive rules, SFX catalog, VO plan, ambience per environment. Feeds Production Plan (3.14) for budget.","uses":{"inputs":["feel_statement","world_lore","environments_x4"],"siblings_if_present":[]}},{"key":"audio_direction_doc","label":"Audio Direction Doc","type":"asset","format":"docx","prompt":"Write the audio direction document, identical to the connection.","uses":{"inputs":["feel_statement","world_lore","environments_x4"],"siblings_if_present":["audio_direction"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"C","depends_on":["3.7"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.11 Monetization Design  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.11', 'Monetization Design', 'pre-production', 'standard', 'archived',
  'Define the business model, currency system, IAP catalog, reward structure, and economy balance rules — coherent with audience, platform, and the internal economy.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Design the monetization system for [project]: revenue model with justification for this audience/platform, price point, currency table with sink/source, IAP catalog (no pay-to-win), reward structure mapped to the core loop, 3+ anti-inflation rules.',
  'Model coherent with audience and platform. No pay-to-win — no IAP gives gameplay advantage. Every currency source has a documented sink. Minimum 3 anti-inflation rules.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['monetization_model_design','economy_balancing','iap_catalog_design']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"progression_sys","cardinality":"single","type":"progression_sys","required":true},{"key":"economy_design","cardinality":"single","type":"economy_design","required":true},{"key":"concept_data","cardinality":"single","type":"concept_data","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"revenue_model","label":"Revenue Model","type":"connection","format":"revenue_model","prompt":"Emit the revenue model, price point, currency table, IAP catalog, and anti-inflation rules. Feeds TDD (3.12, store requirements) and Production Plan (3.14, budget).","uses":{"inputs":["progression_sys","economy_design"],"siblings_if_present":[]}},{"key":"monetization_doc","label":"Monetization Doc","type":"asset","format":"docx","prompt":"Write the monetization document, identical to the connection.","uses":{"inputs":["progression_sys","economy_design","concept_data"],"siblings_if_present":["revenue_model"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"C","depends_on":["3.3"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","two_pass_qa","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.12 Technical Design Document  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.12', 'Technical Design Document', 'pre-production', 'standard', 'archived',
  'Specify the full technical stack: engine, language, art pipeline, audio middleware, platform specs, custom systems list, and a feasibility check against art targets and team size.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Produce the TDD for [project]: engine and version (justified), language, art pipeline end-to-end, audio middleware, PC min/recommended specs, custom systems list (each justified), CI/CD stack, and a feasibility check against the visual targets and team size. Assemble the buildable TDD: §A Project Identity (engine, pattern, input_system, test_assembly_prefix, target_platform) with REQUIRED fields filled; reference the §B engineering-ready mechanics from 3.2; ensure each has its §C feature_spec YAML; build §D the cross-mechanic dependency graph from the mechanics'' graph_edges. Use fill markers ([FORGE:node]/[REQUIRED]/[TO-FILL:eng]/[PROJECTED]). Apply the completeness gate before accepting.',
  'Engine compatible with visual_targets FPS and pipeline. No unnecessary custom systems — each must justify why off-the-shelf fails. PC specs in concrete values. Feasibility check verifies the team can build to art targets. TDD INTEGRATION: the TDD is the buildable compendium — it must carry §A project_identity (REQUIRED fields filled), §B engineering-ready mechanics (from 3.2), §C one feature_spec YAML per mechanic, and §D the dependency graph. Completeness gate: every mechanic has quantified rules + io + dependencies + >=1 acceptance criterion + a matching §C YAML, and no [REQUIRED] field left as a placeholder.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['technical_design_document_writing','engine_selection','pipeline_design','feasibility_assessment']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"visual_targets","cardinality":"single","type":"visual_targets","required":true},{"key":"core_loop","cardinality":"single","type":"core_loop","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":true},{"key":"revenue_model","cardinality":"single","type":"revenue_model","required":false},{"key":"audio_direction","cardinality":"single","type":"audio_direction","required":false},{"key":"level_map","cardinality":"single","type":"level_map","required":false},{"key":"feedback_system","cardinality":"single","type":"feedback_system","required":false},{"key":"gdd_ref","cardinality":"single","type":"gdd_ref","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"tech_stack","label":"Tech Stack","type":"connection","format":"tech_stack","prompt":"Engine + version (justified), language, art pipeline, audio middleware, PC specs. Feeds Production Plan (3.14).","uses":{"inputs":["visual_targets","core_loop","mechanic_specs"],"siblings_if_present":[]}},{"key":"custom_systems","label":"Custom Systems","type":"connection","format":"custom_systems","prompt":"Each custom system with purpose/complexity/priority and a justification of why off-the-shelf fails.","uses":{"inputs":["mechanic_specs"],"siblings_if_present":["tech_stack"]}},{"key":"project_identity","label":"Project Identity","type":"connection","format":"project_identity","note":"TDD §A — engine, pattern, input_system, test_assembly_prefix, target_platform, save/multiplayer model. REQUIRED: project_name, engine, input_system, test_assembly_prefix."},{"key":"dependency_graph","label":"Dependency Graph","type":"connection","format":"dependency_graph","note":"TDD §D — assembled from the graph_edges of every 3.2 mechanic_spec; node ids match mechanic names."},{"key":"tdd_complete","label":"Tdd Complete","type":"asset","format":"docx","prompt":"Write the full TDD with a navigable section index, identical to the connections.","uses":{"inputs":["visual_targets","core_loop","mechanic_specs"],"siblings_if_present":["tech_stack","custom_systems"]},"section_index":"llm_generated"}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"C","depends_on":["3.12","3.2"],"status":"mandatory_in_full_preprod | optional_in_ideation_factory","amendments":["real_files","two_pass_qa","structure_not_skin","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.13 Vertical Slice Specification  (document) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.13', 'Vertical Slice Specification', 'pre-production', 'standard', 'archived',
  'Produce the vertical slice SPECIFICATION as the final documentation artifact: it consumes the GDD (design), the ADI (art bar) and the TDD (technical bar) and defines which section is built, at what quality, covering which mechanics, with binary success criteria and the structured payload the later VS build consumes. This is a document, not a build — it closes the documentation phase.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Produce the vertical slice specification for [project] from the GDD, the ADI (style_guide + visual_targets) and the TDD (tech_stack): slice scope, art quality bar (ref style_guide/visual_targets), technical constraints (ref tech_stack), 3-5 binary success criteria observable externally, and the structured vs_spec payload the VS build will consume downstream.',
  'VS scope is a single coherent slice — one environment, all its mechanics, at production art quality. Success criteria observable by an external reviewer (publisher/investor) who has not seen the GDD.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['vertical_slice_scoping','production_quality_bar_definition']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"gdd_ref","cardinality":"single","type":"gdd_ref","required":true},{"key":"style_guide","cardinality":"single","type":"style_guide","required":true},{"key":"visual_targets","cardinality":"single","type":"visual_targets","required":true},{"key":"tech_stack","cardinality":"single","type":"tech_stack","required":true},{"key":"custom_systems","cardinality":"single","type":"custom_systems","required":false},{"key":"mechanic_specs","cardinality":"list<mechanic_spec>","type":"list<mechanic_spec>","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"vs_spec","label":"Vs Spec","type":"connection","format":"vs_spec","prompt":"Emit the VS spec: scope, art quality bar, binary external-reviewer criteria, and the build script payload.","uses":{"inputs":["gate_decision","style_guide"],"siblings_if_present":[]}},{"key":"vs_spec_doc","label":"Vs Spec Doc","type":"asset","format":"docx","prompt":"Write the VS spec document, identical to the connection.","uses":{"inputs":["gate_decision","style_guide"],"siblings_if_present":["vs_spec"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"document","sub_phase":"1_documentation","group":"B","depends_on":["3.10b","3.12"],"status":"mandatory_in_full_preprod | optional_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.14 Production Plan  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.14', 'Production Plan', 'pre-production', 'standard', 'archived',
  'Turn the complete GDD, TDD, ADD and prototype results into an executable production roadmap: team composition, milestones with measurable criteria, budget by category, and a risk register.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Produce the Production Plan for [project]: team table, development phases with durations, milestones each with a measurable success criterion, budget by category, and a risk register (minimum 4 risks). Be honest about scope.',
  'Minimum 4 risks, each with probability / impact / mitigation (hard gate). Every milestone has a measurable, objective success criterion. Team size coherent with art style feasibility. Budget in concrete categories: team / tools / marketing / QA / licences / contingency.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['production_planning','risk_register_writing','milestone_definition','budget_estimation']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"gdd_ref","cardinality":"single","type":"gdd_ref","required":true},{"key":"tech_stack","cardinality":"single","type":"tech_stack","required":true},{"key":"custom_systems","cardinality":"single","type":"custom_systems","required":true},{"key":"style_guide","cardinality":"single","type":"style_guide","required":false},{"key":"audio_direction","cardinality":"single","type":"audio_direction","required":false},{"key":"revenue_model","cardinality":"single","type":"revenue_model","required":false},{"key":"playtest_result","cardinality":"one_or_more","type":"playtest_result","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"production_plan","label":"Production Plan","type":"connection","format":"production_plan","prompt":"Emit the production plan: team, phases, milestones with criteria, budget, risk register (>=4).","uses":{"inputs":["gdd_ref","tech_stack","custom_systems"],"siblings_if_present":[]}},{"key":"production_plan_doc","label":"Production Plan Doc","type":"asset","format":"docx","prompt":"Write the production plan document, identical to the connection. Real tables for budget and risk register.","uses":{"inputs":["gdd_ref","tech_stack","custom_systems","playtest_result"],"siblings_if_present":["production_plan"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"C","depends_on":["3.7","3.15"],"status":"mandatory_in_full_preprod | optional_in_ideation_factory","amendments":["real_files","two_pass_qa","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.15 Product Scope  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.15', 'Product Scope', 'pre-production', 'standard', 'archived',
  'Maintain the living Product Scope: vertical-slice goals, production-readiness criteria, launch and post-launch scope, prioritized cuttable features, the non-negotiable minimum, and the gate approval criteria. Updated as prototype/VS results arrive.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Maintain the Product Scope for [project]: VS goals, production-readiness criteria, launch / post-launch scope, prioritized cuttable features, and the non-negotiable minimum. Update it each time a prototype or VS result arrives. This is the living gate document 3.22 reads.',
  'VS goals binary and observable by an external reviewer without the GDD. Production-readiness criteria binary (MET / NOT MET). Cuttable features prioritized, each with a rationale. The non-negotiable minimum shippable game is stated. Re-validated each time a result arrives. 3.22 cannot ACCEPT until this product_scope is accepted.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['product_scope_management','scope_definition','production_readiness_assessment','feature_prioritization','risk_adjusted_planning']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"gdd_ref","cardinality":"single","type":"gdd_ref","required":true},{"key":"production_plan","cardinality":"single","type":"production_plan","required":true},{"key":"playtest_result","cardinality":"one_or_more","type":"playtest_result","required":false},{"key":"vs_result","cardinality":"single","type":"playtest_result","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"product_scope","label":"Product Scope","type":"connection","format":"product_scope","prompt":"Emit the current product scope: VS goals (binary, external-reviewer), production-readiness criteria (binary), launch and post-launch scope, prioritized cuttable features with rationale, the non-negotiable minimum, and the gate approval criteria.","uses":{"inputs":["gdd_ref","production_plan"],"siblings_if_present":[]}},{"key":"product_scope_doc","label":"Product Scope Doc","type":"asset","format":"docx","prompt":"Write/update the Product Scope document (GDD §12), identical to the connection. Mark each readiness criterion MET / NOT MET as results arrive.","uses":{"inputs":["gdd_ref","production_plan","playtest_result","vs_result"],"siblings_if_present":["product_scope"]},"template":"Forge_GDD_Template_v2.4.0 §12"}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"1_documentation","group":"C_living","depends_on":["3.7","3.16"],"status":"mandatory_in_full_preprod | optional_in_ideation_factory","amendments":["real_files","two_pass_qa","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.16 Prototype Specification  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.16', 'Prototype Specification', 'pre-production', 'standard', 'archived',
  'Produce a build-ready prototype specification for one mechanic: what to build, success criteria, playtest structure, and the structured input payload for the build script.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Produce a prototype specification for the mechanic [mechanic_name]. Minimal build that validates this mechanic only. Emit the payload in the feature_spec (§C) shape so 3.17 can consume it directly: name, type, dependencies{kind,id}, components, publicAPI, acceptanceCriteria (from the mechanic), validationGates (specStructural/compileUnity/standardsValidation/codeReviewer/acceptanceCriteria=all_must_pass), specId (snake_case), touches.',
  'Success criteria measurable and binary — not ''feels good'' but ''player completes loop within 90 seconds on first attempt''. Script target specifies Unity or Unreal. Minimal scope — prototype only what validates the mechanic. TDD INTEGRATION (§C): the prototype_spec payload must serialize to the feature_spec YAML shape (specVersion, dependencies, components, publicAPI, acceptanceCriteria, validationGates, specId, touches). Acceptance criteria are carried from the mechanic_spec (3.2), not re-invented.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['prototype_scoping','success_criteria_writing','build_spec_structuring']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"mechanic_spec","cardinality":"single","type":"mechanic_spec","required":true},{"key":"gdd_ref","cardinality":"single","type":"gdd_ref","required":false},{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"prototype_spec","label":"Prototype Spec","type":"connection","format":"prototype_spec","prompt":"Emit the self-contained spec: what to build, what NOT to build, 3-5 binary success criteria, playtest structure, and the structured payload for the build script (target engine, mechanic params). Becomes the script input.","uses":{"inputs":["mechanic_spec"],"siblings_if_present":[]},"note":"Payload conforms to feature_spec (TDD §C companion YAML): components, publicAPI, acceptanceCriteria, validationGates, touches. This IS the build script input consumed by 3.17."},{"key":"prototype_spec_doc","label":"Prototype Spec Doc","type":"asset","format":"docx","prompt":"Write the prototype spec document, identical to the connection.","uses":{"inputs":["mechanic_spec"],"siblings_if_present":["prototype_spec"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"2_prototyping_and_builds","group":"B","depends_on":["3.2"],"status":"mandatory_in_full_preprod | mandatory_in_ideation_factory","amendments":["real_files","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"],"instancing_modes":{"single_mechanic":"Default. Fan-out from list<mechanic_spec> — one lane per mechanic; supporting mechanics available as prompt context.","mechanic_combination":"Optional override. User assembles a list<mechanic_spec> to validate interplay in one lane; selected in the node modal before Accept."}}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.17 Prototype Build  (Script_Execution) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.17', 'Prototype Build', 'pre-production', 'standard', 'archived',
  'Assemble the Unity build handoff package and support a MANUAL build session via MCP. The node gathers the shelf documents the engineer needs (GDD from 3.8, prototype feature_spec from 3.16, Art Bible/ADI_11.1 from 3.9 and TDD from 3.12 when they exist on the shelf), writes a BUILD_BRIEF, and waits for the human build receipt. The automated v57 build pipeline remains the future mode; manual handoff is the default until it exists.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Assemble the Unity handoff package for [prototype_spec]. Include: (1) the GDD (3.8 shelf asset); (2) every feature_spec YAML for the mechanics in scope (3.16); (3) Art Bible / ADI_11.1 Concept Art package (3.9) and the TDD (3.12) IF they exist on the shelf — note their absence otherwise; (4) BUILD_BRIEF.md: project identity (engine, input_system, test_assembly_prefix if the TDD exists — else mark [TO-FILL:eng]), the ordered mechanic list with dependencies, the acceptance-criteria checklist (verbatim from the specs, tagged EditMode/PlayMode), and the MCP session steps (open project → connect MCP → implement one mechanic at a time → run its tests → record pass/fail). Emit the package as one bundle. Then wait: ask the engineer to run the session and paste the build receipt; fill build_result from the receipt only — never simulate results.',
  'MANUAL HANDOFF MODE (default): the node does not execute builds. It must produce a SELF-CONTAINED package — GDD + feature_spec YAML(s) + BUILD_BRIEF.md with the acceptance-criteria checklist — plus Art Bible/ADI_11.1 and TDD if present on the shelf (never force-wired; pulled as shelf assets). The acceptance criteria in the checklist come verbatim from the mechanic/feature specs — never re-invented. build_result is HUMAN-REPORTED: the engineer runs the Unity MCP session, executes EditMode/PlayMode tests, and pastes the receipt (pass/fail per criterion + build link). The node is not accepted until the receipt is attached. When the automated pipeline exists, mode switches without changing the node''s contract.',
  ARRAY[]::text[],
  ARRAY['v57_build_pipeline','unity_project_structure','unreal_project_structure']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"prototype_spec","cardinality":"single","type":"prototype_spec","required":true}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"build_result","label":"Build Result","type":"connection","format":"build_result","prompt":"Emit the repo link or build artifact link plus the checkpoint log from the run.","uses":{"inputs":["prototype_spec"],"siblings_if_present":[]},"note":"HUMAN-REPORTED in manual mode: filled from the engineer''s pasted receipt (pass/fail per acceptance criterion + build link) after the Unity MCP session. Never simulated."},{"key":"unity_handoff_package","label":"Unity Handoff Package","type":"asset","format":"zip"},{"key":"prototype_build","label":"Prototype Build","type":"asset","format":"repo_link|build_artifact","prompt":"Store the playable prototype as an Asset linked to this node and lane.","uses":{"inputs":["prototype_spec"],"siblings_if_present":["build_result"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"Script_Execution","sub_phase":"2_prototyping_and_builds","group":"B","depends_on":["3.8"],"status":"mandatory_in_full_preprod | mandatory_in_ideation_factory","amendments":["real_files"],"script_execution":{"input_payload":"prototype_spec","checkpoint_modes":["blocking","advisory","allowlist"],"default_checkpoint":"blocking","receipt":"build_result"}}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.18 Prototype Playtest & Review  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.18', 'Prototype Playtest & Review', 'pre-production', 'standard', 'archived',
  'Review the prototype build against the spec success criteria and produce a PASS/FAIL/PARTIAL verdict with documented gaps and recommended actions.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Review the prototype for [mechanic_name] against its success criteria. Per criterion: MET or NOT MET with evidence. Overall: PASS / FAIL / PARTIAL. List gaps with the upstream node to revise.',
  'Verdict binary per criterion (MET / NOT MET). Gaps name the specific failed criterion. Recommended actions name the upstream node to revise.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['playtest_analysis','success_criteria_evaluation','gap_identification']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"build_result","cardinality":"single","type":"build_result","required":true},{"key":"prototype_spec","cardinality":"single","type":"prototype_spec","required":true}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"playtest_result","label":"Playtest Result","type":"connection","format":"playtest_result","prompt":"Emit the PASS/FAIL/PARTIAL verdict per mechanic with per-criterion results and gaps. Fan-in at Prototype Gate (3.19).","uses":{"inputs":["build_result","prototype_spec"],"siblings_if_present":[]}},{"key":"playtest_report","label":"Playtest Report","type":"asset","format":"docx","prompt":"Write the playtest report, identical to the verdict connection.","uses":{"inputs":["build_result","prototype_spec"],"siblings_if_present":["playtest_result"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"2_prototyping_and_builds","group":"B","depends_on":["3.9"],"status":"mandatory_in_full_preprod | mandatory_in_ideation_factory","amendments":["real_files","two_pass_qa","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.19 Prototype Gate  (Assembly) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.19', 'Prototype Gate', 'pre-production', 'standard', 'archived',
  'Gather all prototype lane results, present the full package for human decision, and determine which mechanics advance to VS / Production Readiness.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Review all prototype results for [project]. Per mechanic: verdict and key gaps. Recommend: accept all, accept subset (name which), or return specific mechanics for redesign.',
  'Natural-language decision. May accept all lanes, accept a subset (dismissing others), or return specific lanes. A partial accept is valid — not all mechanics need to pass.',
  ARRAY[]::text[],
  ARRAY['prototype_review_facilitation']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"playtest_result","cardinality":"one_or_more","type":"playtest_result","required":true}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"gate_decision","label":"Gate Decision","type":"connection","format":"decision","prompt":"Emit the gate decision: ACCEPT (all/subset) / REFINE (with refine_nodes[]) / KILL (dismiss a lane).","uses":{"inputs":["playtest_result"],"siblings_if_present":[]}},{"key":"prototype_package","label":"Prototype Package","type":"asset","format":"artifact_bundle","prompt":"Bundle the prototype results package (builds + reports per live lane).","uses":{"inputs":["playtest_result"],"siblings_if_present":["gate_decision"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"Assembly","sub_phase":"2_prototyping_and_builds","group":"B_gate","depends_on":["3.10"],"status":"mandatory_in_full_preprod | mandatory_in_ideation_factory","amendments":["real_files","two_pass_qa"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.20 VS Build  (Script_Execution) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.20', 'VS Build', 'pre-production', 'standard', 'archived',
  'Execute the automated VS build script at production art quality, as defined in style_guide and visual_targets.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Run the VS build for [project] using vs_spec and style_guide. Target production art quality. Surface all validation checkpoints in this modal.',
  'Cannot run until 3.9 Art Direction is accepted and style_guide is available. Build targets engine/pipeline from tech_stack if 3.12 has run; otherwise team default.',
  ARRAY[]::text[],
  ARRAY['v57_build_pipeline','vertical_slice_scoping']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"vs_spec","cardinality":"single","type":"vs_spec","required":true},{"key":"style_guide","cardinality":"single","type":"style_guide","required":true},{"key":"visual_targets","cardinality":"single","type":"visual_targets","required":true}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"vs_build_result","label":"Vs Build Result","type":"connection","format":"build_result","prompt":"Emit the VS build artifact link (type=vertical_slice) plus the checkpoint log.","uses":{"inputs":["vs_spec","style_guide","visual_targets"],"siblings_if_present":[]}},{"key":"vs_build","label":"Vs Build","type":"asset","format":"repo_link|build_artifact","prompt":"Store the production-quality playable slice as an Asset.","uses":{"inputs":["vs_spec"],"siblings_if_present":["vs_build_result"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"Script_Execution","sub_phase":"2_prototyping_and_builds","group":"B","depends_on":["3.11","3.12"],"status":"mandatory_in_full_preprod | optional_in_ideation_factory","amendments":["real_files"],"script_execution":{"input_payload":"vs_spec","checkpoint_modes":["blocking","advisory","allowlist"],"default_checkpoint":"blocking","receipt":"vs_build_result"}}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.21 VS Review  (LLM) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.21', 'VS Review', 'pre-production', 'standard', 'archived',
  'Review the VS build against the vs_spec success criteria AND the art direction quality bar; produce a PASS/FAIL/PARTIAL verdict assessable by an external reviewer.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Review the VS build for [project] against vs_spec criteria and the style_guide art quality bar. External reviewer perspective: would a publisher find this compelling? PASS / FAIL / PARTIAL with specific gaps.',
  'Verdict assessable by an external reviewer without GDD context. Art quality criteria evaluated against style_guide, not subjective judgment.',
  ARRAY['doc_gen_docx']::text[],
  ARRAY['vertical_slice_review','art_quality_assessment']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"vs_build_result","cardinality":"single","type":"build_result","required":true},{"key":"vs_spec","cardinality":"single","type":"vs_spec","required":true},{"key":"style_guide","cardinality":"single","type":"style_guide","required":true}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"vs_result","label":"Vs Result","type":"connection","format":"playtest_result","prompt":"Emit the PASS/FAIL/PARTIAL verdict on the VS. Feeds 3.22 Pre-Production Gate.","uses":{"inputs":["vs_build_result","vs_spec","style_guide"],"siblings_if_present":[]}},{"key":"vs_review_report","label":"Vs Review Report","type":"asset","format":"docx","prompt":"Write the VS review report, identical to the verdict connection.","uses":{"inputs":["vs_build_result","vs_spec","style_guide"],"siblings_if_present":["vs_result"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"LLM","sub_phase":"2_prototyping_and_builds","group":"B","depends_on":["3.11b"],"status":"mandatory_in_full_preprod | optional_in_ideation_factory","amendments":["real_files","two_pass_qa","design_bar"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.22 Pre-Production Gate  (Assembly) ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.22', 'Pre-Production Gate', 'pre-production', 'standard', 'archived',
  'Validate and surface the complete Pre-Production package for final human decision and gate entry to Production.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Review the full Pre-Production package for [project]: GDD completeness, TDD feasibility, ADD consistency, Production Plan realism vs scope, product_scope readiness criteria, prototype results. Decision: ACCEPT / REFINE (specific nodes) / HOLD.',
  'Cannot ACCEPT with any Sub-Phase A node in REFINE/REJECT. Prototype Gate must be ACCEPT. The 3.15 product_scope must be accepted (its production-readiness criteria all MET). Natural-language decision. HOLD is a valid outcome.',
  ARRAY[]::text[],
  ARRAY['pre_production_review_facilitation']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"gdd_ref","cardinality":"single","type":"gdd_ref","required":true},{"key":"production_plan","cardinality":"single","type":"production_plan","required":true},{"key":"product_scope","cardinality":"single","type":"product_scope","required":true},{"key":"gate_decision","cardinality":"single","type":"decision","required":true},{"key":"tech_stack","cardinality":"single","type":"tech_stack","required":false},{"key":"style_guide","cardinality":"single","type":"style_guide","required":false},{"key":"vs_result","cardinality":"single","type":"playtest_result","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"preprod_decision","label":"Preprod Decision","type":"connection","format":"decision","prompt":"Emit the decision: ACCEPT (advance to Production) / REFINE (with refine_nodes[]) / HOLD.","uses":{"inputs":["gdd_ref","production_plan","product_scope","gate_decision","vs_result"],"siblings_if_present":[]}},{"key":"preprod_package","label":"Preprod Package","type":"asset","format":"artifact_bundle","prompt":"On ACCEPT, bundle GDD + TDD + ADD + Production Plan + prototype reports for handoff to Production.","uses":{"inputs":["gdd_ref","production_plan"],"siblings_if_present":["preprod_decision"]}}]'::jsonb,
  '{"preview":true,"dna_version":"2.6.0","node_type":"Assembly","sub_phase":"3_final_gate","group":"final_gate","depends_on":["3.7","3.16","3.16b","3.10b"],"status":"mandatory_in_full_preprod | lightweight_in_ideation_factory","amendments":["real_files","two_pass_qa"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── Blueprint: Pre-Production (full v2.6.0)  (22 nodos · edges vía auto-wire) ───
WITH ids AS (
  SELECT node_key, id FROM v57.forge_nodes WHERE node_key IN ('3.1','3.2','3.3','3.4','3.5','3.6','3.7','3.8','3.9','3.10','3.11','3.12','3.13','3.14','3.15','3.16','3.17','3.18','3.19','3.20','3.21','3.22')
)
INSERT INTO v57.forge_blueprints (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
SELECT
  'preprod_full', 'Pre-Production (full v2.6.0)', 'pre-production',
  'Full Pre-Production, 22 nodes, documentation-first order (v2.6.0). GDD=3.8, TDD=3.12.',
  (SELECT jsonb_agg(jsonb_build_object('node_id',(SELECT id FROM ids WHERE node_key=x.k),'order_index',x.o) ORDER BY x.o)
     FROM (VALUES ('3.1',1),('3.2',2),('3.3',3),('3.4',4),('3.5',5),('3.6',6),('3.7',7),('3.8',8),('3.9',9),('3.10',10),('3.11',11),('3.12',12),('3.13',13),('3.14',14),('3.15',15),('3.16',16),('3.17',17),('3.18',18),('3.19',19),('3.20',20),('3.21',21),('3.22',22)) x(k,o)),
  '[]'::jsonb,
  '{"name":"Design Review","mode":"conversational","suggested_rubrics":["pillars testable","real numbers present","mechanics reinforce pillars","zero TBD / banned words","name consistency"],"outcomes":["accept","refine","kill"]}'::jsonb,
  false
ON CONFLICT (blueprint_key) DO UPDATE SET
  name=EXCLUDED.name, phase=EXCLUDED.phase, node_sequence=EXCLUDED.node_sequence,
  edges=EXCLUDED.edges, gate=EXCLUDED.gate, description=EXCLUDED.description, updated_at=now();

-- ─── Blueprint: Pre-Production (critical path · GDD+TDD)  (7 nodos · edges vía auto-wire) ───
WITH ids AS (
  SELECT node_key, id FROM v57.forge_nodes WHERE node_key IN ('3.1','3.2','3.4','3.6','3.9','3.8','3.12')
)
INSERT INTO v57.forge_blueprints (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
SELECT
  'preprod_critical', 'Pre-Production (critical path · GDD+TDD)', 'pre-production',
  'Minimal path to GDD (3.8) and TDD (3.12): 3.1 -> 3.2 / 3.4 -> 3.6 -> 3.9 -> 3.8 / 3.12.',
  (SELECT jsonb_agg(jsonb_build_object('node_id',(SELECT id FROM ids WHERE node_key=x.k),'order_index',x.o) ORDER BY x.o)
     FROM (VALUES ('3.1',1),('3.2',2),('3.4',4),('3.6',6),('3.9',9),('3.8',8),('3.12',12)) x(k,o)),
  '[]'::jsonb,
  '{"name":"Design Review","mode":"conversational","suggested_rubrics":["pillars testable","real numbers present","mechanics reinforce pillars","zero TBD / banned words","name consistency"],"outcomes":["accept","refine","kill"]}'::jsonb,
  false
ON CONFLICT (blueprint_key) DO UPDATE SET
  name=EXCLUDED.name, phase=EXCLUDED.phase, node_sequence=EXCLUDED.node_sequence,
  edges=EXCLUDED.edges, gate=EXCLUDED.gate, description=EXCLUDED.description, updated_at=now();

