-- ============================================================
-- Migration 035 — Seed Pre-Production nodes (Sub-Phase A, LLM)
-- Generado por scripts/import-preprod-nodes.js desde NodeDNA v2.4.1.
-- Idempotente: ON CONFLICT (node_key) DO UPDATE. Aplicar en Supabase.
-- Alcance: 3.1–3.6 (incl. 3.4b). 3.7 GDD Assembly → PP-3.
-- ============================================================

-- Columna aditiva para los campos nuevos v2.4.1 (node_type, sub_phase, execution,
-- amendments, instancing/script). El motor la ignora hoy; PP-3/PP-4 la leen.
ALTER TABLE v57.forge_nodes ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

-- ─── 3.1 Design Pillars ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.1', 'Design Pillars', 'pre-production', 'standard', 'archived',
  'Formalize 3-4 named design pillars and anti-pillars from the locked concept package, plus the pillar-level feel statement; the consistency filter for every downstream Design node.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'You are formalizing the design foundations for [project] from the locked concept package. Pillars are testable rules, not adjectives.',
  'Each pillar is an actionable, testable rule with a validation criterion — not an adjective. Anti-pillars mandatory. Feel statement 3-4 sentences. Pillars are content derived from the concept, never a default set.',
  ARRAY['kb_read','doc_gen_docx']::text[],
  ARRAY['design_pillar_formalization','anti_pillar_definition','feel_statement_writing']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"concept_data","cardinality":"single","type":"concept_data","required":true}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"design_pillars","label":"Design Pillars","type":"connection","format":"design_pillars","prompt":"Emit 3-4 named pillars, each with an actionable testable description and a validation criterion, plus the anti-pillars. Each pillar traces to the concept''s core fantasy or loop.","uses":{"inputs":["concept_data"],"siblings_if_present":[]}},{"key":"feel_statement","label":"Feel Statement","type":"connection","format":"feel_statement","prompt":"Emit the pillar-level feel statement (level=pillar): 3-4 sentences on the moment-to-moment experience the pillars promise. 3.2 refines this into a mechanics-grounded version.","uses":{"inputs":["concept_data"],"siblings_if_present":["design_pillars"]}},{"key":"design_pillars_doc","label":"Design Pillars Doc","type":"asset","format":"docx","prompt":"Write the Design Pillars document (pillar matrix table, anti-pillars, feel statement), identical in substance to the connections. Neutral editorial — no art direction exists yet.","uses":{"inputs":["concept_data"],"siblings_if_present":["design_pillars","feel_statement"]}}]'::jsonb,
  '{"preview":true,"node_type":"LLM","sub_phase":"A_design","group":"A1","depends_on":[],"parallel_with":[],"status":"mandatory_in_full_preprod | mandatory_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.2 Core Gameplay ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.2', 'Core Gameplay', 'pre-production', 'standard', 'archived',
  'Define the core loop, all mechanics with concrete rules and real numbers, win/lose conditions, difficulty curve, and the integration map between mechanics.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Define the core gameplay for [project] from the design pillars. Real numbers throughout; every mechanic reinforces a pillar.',
  'Core loop under 15 minutes. All mechanics require real numbers — no ''high damage'', yes ''45 base damage ±20%''. Every mechanic reinforces a design pillar. Integration map required.',
  ARRAY['kb_read','doc_gen_docx']::text[],
  ARRAY['game_loop_design','mechanic_specification','difficulty_curve_design','real_numbers_constraint']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":true},{"key":"feel_statement","cardinality":"single","type":"feel_statement","required":true},{"key":"concept_data","cardinality":"single","type":"concept_data","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"core_loop","label":"Core Loop","type":"connection","format":"core_loop","prompt":"Emit the named loop (4 steps: action / response / feedback / reward), duration under 15 min, retention hook, win/lose with fail-state consequences.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":[]}},{"key":"mechanic_specs","label":"Mechanic Specs","type":"connection","format":"list<mechanic_spec>","prompt":"Emit all mechanics, each with concrete rules and real numbers, plus an integration map of how they affect each other. INSTANCING TRIGGER: fans out one prototype lane per mechanic at 3.8.","uses":{"inputs":["design_pillars"],"siblings_if_present":["core_loop"]}},{"key":"feel_statement","label":"Feel Statement","type":"connection","format":"feel_statement","prompt":"Re-emit the feel statement grounded in the mechanics (level=mechanics); show how the mechanics express the pillar feel. Replaces the upstream value for all downstream nodes. ↻ consumed-and-refined.","uses":{"inputs":["feel_statement"],"siblings_if_present":["mechanic_specs","core_loop"]}},{"key":"core_gameplay_spec","label":"Core Gameplay Spec","type":"asset","format":"docx","prompt":"Write the core gameplay spec: loop, mechanics with real numbers, difficulty curve with escalation points, integration map. Identical to the connections.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":["core_loop","mechanic_specs"]}}]'::jsonb,
  '{"preview":true,"node_type":"LLM","sub_phase":"A_design","group":"A1","depends_on":["3.1"],"parallel_with":[],"status":"mandatory_in_full_preprod | mandatory_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.3 Game Systems ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.3', 'Game Systems', 'pre-production', 'standard', 'archived',
  'Define the secondary systems supporting the core loop: progression, internal economy, player stats, abilities, inventory, unlockables, and the full item catalog.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Define all game systems for [project]: progression and XP curve, internal economy with sink/source mapping, stats table, abilities, unlockables, and the complete item catalog. Real numbers throughout.',
  'Every stat affects >=1 mechanic. Every currency source has a documented sink. Phase durations in concrete hours. Item catalog required: each item has a numeric value, drop_rate (0-1), stack/carry limit, and integration with >=1 mechanic.',
  ARRAY['kb_read','doc_gen_docx']::text[],
  ARRAY['progression_system_design','economy_balancing','stats_and_abilities_design']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"core_loop","cardinality":"single","type":"core_loop","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":true},{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"progression_sys","label":"Progression Sys","type":"connection","format":"progression_sys","prompt":"Progression philosophy + XP curve with concrete hour values; unlockables by category.","uses":{"inputs":["core_loop","mechanic_specs"],"siblings_if_present":[]}},{"key":"economy_design","label":"Economy Design","type":"connection","format":"economy_design","prompt":"Internal economy: every currency with sink & source mapping. Feeds Monetization (3.14).","uses":{"inputs":["mechanic_specs"],"siblings_if_present":[]}},{"key":"player_stats","label":"Player Stats","type":"connection","format":"player_stats","prompt":"Full stats table base/max/growth; every stat affects >=1 mechanic.","uses":{"inputs":["mechanic_specs"],"siblings_if_present":[]}},{"key":"item_catalog","label":"Item Catalog","type":"connection","format":"item_catalog","prompt":"Complete item list: each {id, name, category, effect, value, drop_rate(0-1), stack_limit, carry_limit, duration_ms?}, each integrated with >=1 mechanic. Feeds 3.4b, 3.6, 3.12.","uses":{"inputs":["mechanic_specs"],"siblings_if_present":["economy_design"]}},{"key":"game_systems_spec","label":"Game Systems Spec","type":"asset","format":"docx","prompt":"Write the game systems spec, identical to the connections. Real tables for stats, economy, items.","uses":{"inputs":["core_loop","mechanic_specs"],"siblings_if_present":["progression_sys","economy_design","player_stats","item_catalog"]}}]'::jsonb,
  '{"preview":true,"node_type":"LLM","sub_phase":"A_design","group":"A2","depends_on":["3.2"],"parallel_with":["3.4"],"status":"mandatory_in_full_preprod | optional_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.4 World Design ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.4', 'World Design', 'pre-production', 'standard', 'archived',
  'Build the universe: lore, world history, 3-act narrative arc, 4+ environments with gameplay roles, faction map, and the narrative delivery system.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Build the world for [project]: logline, setting, 4-5 sentence history, 3-act arc with midpoint twist, 3+ themes that manifest in gameplay, faction map, 4+ environments (look / gameplay role / narrative meaning), and the narrative delivery system. Lore must justify the core loop.',
  'Minimum 4 fully described environments. Lore justifies the player''s actions in the core loop. >=1 narrative theme expressed through a mechanic. History in 4-5 sentences. Narrative delivery system required (dialogue trigger system, tree structure, skip mechanic; cutscene frequency/duration if used).',
  ARRAY['kb_read','doc_gen_docx']::text[],
  ARRAY['world_building','narrative_arc_design','environment_design','faction_design']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"design_pillars","cardinality":"single","type":"design_pillars","required":true},{"key":"feel_statement","cardinality":"single","type":"feel_statement","required":true},{"key":"core_loop","cardinality":"single","type":"core_loop","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"world_lore","label":"World Lore","type":"connection","format":"world_lore","prompt":"Logline, setting, 4-5 sentence history, 3+ themes manifesting in gameplay.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":[]}},{"key":"environments_x4","label":"Environments X4","type":"connection","format":"environments_x4","prompt":"4+ environments, each with visual look / gameplay role / narrative meaning. Feeds Art Direction (3.12).","uses":{"inputs":["design_pillars"],"siblings_if_present":["world_lore"]}},{"key":"faction_map","label":"Faction Map","type":"connection","format":"faction_map","prompt":"Faction map with relationships.","uses":{"inputs":["world_lore"],"siblings_if_present":[]}},{"key":"narrative_arc","label":"Narrative Arc","type":"connection","format":"narrative_arc","prompt":"3-act arc with midpoint twist and per-act beats. Feeds Art Direction (3.12) for visual tone shifts.","uses":{"inputs":["world_lore"],"siblings_if_present":[]}},{"key":"dialogue_system","label":"Dialogue System","type":"connection","format":"dialogue_system","prompt":"Narrative delivery spec: trigger system, dialogue tree structure, skip mechanic, VO approach/scope; cutscene frequency/duration/engine if used. Feeds 3.6 (dialogue UI) and 3.13 (VO scope).","uses":{"inputs":["world_lore"],"siblings_if_present":["narrative_arc"]}},{"key":"world_bible","label":"World Bible","type":"asset","format":"docx","prompt":"Write the world bible (large doc, LLM-generated section index), identical to the connections.","uses":{"inputs":["design_pillars","feel_statement"],"siblings_if_present":["world_lore","environments_x4","faction_map","narrative_arc","dialogue_system"]}}]'::jsonb,
  '{"preview":true,"node_type":"LLM","sub_phase":"A_design","group":"A2","depends_on":["3.1","3.2"],"parallel_with":["3.3"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.4b Level Design ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.4b', 'Level Design', 'pre-production', 'standard', 'archived',
  'Define the level structure: per-level spatial layout, objectives, pacing arc, difficulty placement, environmental storytelling, and encounter design philosophy — the spatial expression of the core loop.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Design the complete level structure for [project]. Per level: all required fields with real numbers. First level teaches the full core loop. Encounter design philosophy with placement rules and difficulty scaling. No vague terms.',
  'Every level names: environment, primary mechanic(s), new mechanic (or none), objective type, duration in minutes, pacing arc, difficulty delta vs previous, item spawn density, one env-storytelling beat. No ''various/different/multiple/several'' without enumeration. First level teaches the full core loop with no tutorial screen.',
  ARRAY['kb_read','doc_gen_docx']::text[],
  ARRAY['level_design','encounter_design','pacing_design','environmental_storytelling','difficulty_curve_mapping']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"world_lore","cardinality":"single","type":"world_lore","required":true},{"key":"environments_x4","cardinality":"one_or_more","type":"environments_x4","required":true},{"key":"core_loop","cardinality":"single","type":"core_loop","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":true},{"key":"progression_sys","cardinality":"single","type":"progression_sys","required":false},{"key":"narrative_arc","cardinality":"single","type":"narrative_arc","required":false},{"key":"item_catalog","cardinality":"single","type":"item_catalog","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"level_map","label":"Level Map","type":"connection","format":"level_map","prompt":"Complete level list with structure, objectives, pacing, difficulty placement and item density per level. Feeds 3.6 (objective display, onboarding) and 3.15 (streaming/loading).","uses":{"inputs":["world_lore","environments_x4","core_loop","mechanic_specs"],"siblings_if_present":[]}},{"key":"encounter_design","label":"Encounter Design","type":"connection","format":"encounter_design","prompt":"Encounter philosophy, enemy placement rules, difficulty scaling, encounter templates. Feeds 3.6 (feedback) and 3.15 (AI complexity).","uses":{"inputs":["mechanic_specs","environments_x4"],"siblings_if_present":["level_map"]}},{"key":"level_design_doc","label":"Level Design Doc","type":"asset","format":"docx","prompt":"Full level design document, one section per level plus global encounter philosophy.","uses":{"inputs":["world_lore","environments_x4","core_loop","mechanic_specs"],"siblings_if_present":["level_map","encounter_design"]}}]'::jsonb,
  '{"preview":true,"node_type":"LLM","sub_phase":"A_design","group":"A2b","depends_on":["3.4","3.2"],"parallel_with":["3.5"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.5 Characters ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.5', 'Characters', 'pre-production', 'standard', 'archived',
  'Define 3+ complete character profiles with narrative arcs, mechanical roles, protagonist abilities tied to identity, and a relationship map coherent with the faction map.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Define 3+ characters for [project]. Each: role, look, personality, backstory, motivation, narrative arc, gameplay abilities and mechanical role. Relationship map. Names must fit the established world.',
  'Minimum 3 profiles. Names coherent with setting. Protagonist motivation compatible with the world logline. Mechanical roles documented for every character. Protagonist abilities (2-3) tied to identity, not generic.',
  ARRAY['kb_read','doc_gen_docx']::text[],
  ARRAY['character_design','narrative_arc_writing','mechanical_role_assignment']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"world_lore","cardinality":"single","type":"world_lore","required":true},{"key":"faction_map","cardinality":"single","type":"faction_map","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"char_profiles","label":"Char Profiles","type":"connection","format":"char_profiles","prompt":"Per character: role, look, personality, backstory, motivation, arc, abilities, mechanical role; plus the relationship map. Feeds 3.6 and 3.12.","uses":{"inputs":["world_lore","faction_map"],"siblings_if_present":[]}},{"key":"char_abilities","label":"Char Abilities","type":"connection","format":"char_abilities","prompt":"Protagonist abilities (2-3) tied to identity, each with a mechanical hook. Feeds 3.6 (control map/HUD) and 3.12 (ability VFX).","uses":{"inputs":["mechanic_specs"],"siblings_if_present":["char_profiles"]}},{"key":"character_bible","label":"Character Bible","type":"asset","format":"docx","prompt":"Write the character bible, identical to the connections.","uses":{"inputs":["world_lore","faction_map"],"siblings_if_present":["char_profiles","char_abilities"]}}]'::jsonb,
  '{"preview":true,"node_type":"LLM","sub_phase":"A_design","group":"A2b","depends_on":["3.4"],"parallel_with":["3.4b"],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── 3.6 UX / UI Design ───
INSERT INTO v57.forge_nodes
  (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs, metadata)
VALUES (
  '3.6', 'UX / UI Design', 'pre-production', 'standard', 'archived',
  'Define how the player interacts on screen: HUD, full menu tree, control map, visual feedback rules, onboarding flow, and accessibility features.',
  'The user will describe or attach the inputs this step needs directly. Extract what they provide and proceed.',
  'Design the UX/UI for [project]: HUD element table (max 7), full menu tree, complete control map (kb/mouse + gamepad, incl. all char_abilities), visual feedback rules by event type, onboarding (first 10 min teaches the loop, no tutorial screen), 5+ accessibility features.',
  'HUD max 7 simultaneous elements (more requires justification). Onboarding teaches the full loop in 10 minutes without a tutorial screen. 5+ accessibility features with implementation. Control map covers keyboard/mouse AND gamepad. Objective indicator per level_map objective type. Inventory display per item_catalog limits. Dialogue UI if dialogue scope is not none.',
  ARRAY['kb_read','doc_gen_docx']::text[],
  ARRAY['ux_design','hud_design','menu_architecture','accessibility_design','onboarding_flow_design']::text[],
  '{"type":"llm"}'::jsonb,
  '{"wired":[{"key":"core_loop","cardinality":"single","type":"core_loop","required":true},{"key":"mechanic_specs","cardinality":"one_or_more","type":"mechanic_spec","required":true},{"key":"player_stats","cardinality":"single","type":"player_stats","required":true},{"key":"level_map","cardinality":"single","type":"level_map","required":true},{"key":"char_profiles","cardinality":"one_or_more","type":"char_profiles","required":false},{"key":"encounter_design","cardinality":"single","type":"encounter_design","required":false},{"key":"char_abilities","cardinality":"one_or_more","type":"char_abilities","required":false},{"key":"dialogue_system","cardinality":"single","type":"dialogue_system","required":false}],"direct_context":"Paste or describe the inputs this step needs, or attach a document."}'::jsonb,
  '[{"key":"hud_layout","label":"Hud Layout","type":"connection","format":"hud_layout","prompt":"HUD element table (max 7): position / data / visibility rule / mechanic served; objective indicator per level_map objective type.","uses":{"inputs":["core_loop","player_stats","level_map"],"siblings_if_present":[]}},{"key":"menu_tree","label":"Menu Tree","type":"connection","format":"menu_tree","prompt":"Full menu tree.","uses":{"inputs":["player_stats"],"siblings_if_present":[]}},{"key":"control_map","label":"Control Map","type":"connection","format":"control_map","prompt":"Complete control map for keyboard/mouse and gamepad, including all char_abilities mapped to inputs.","uses":{"inputs":["mechanic_specs","char_abilities"],"siblings_if_present":[]}},{"key":"feedback_system","label":"Feedback System","type":"connection","format":"feedback_system","prompt":"Visual feedback rules by event type (trigger -> animation -> color shift -> sound -> duration ms, with priority). Feeds 3.12 (VFX) and 3.15 (rendering budget).","uses":{"inputs":["mechanic_specs","encounter_design"],"siblings_if_present":[]}},{"key":"ux_ui_spec","label":"Ux Ui Spec","type":"asset","format":"docx","prompt":"Write the UX/UI spec, identical to the connections, with the onboarding flow and accessibility features.","uses":{"inputs":["core_loop","mechanic_specs","player_stats","level_map"],"siblings_if_present":["hud_layout","menu_tree","control_map","feedback_system"]}}]'::jsonb,
  '{"preview":true,"node_type":"LLM","sub_phase":"A_design","group":"A3","depends_on":["3.2","3.3","3.5","3.4b"],"parallel_with":[],"status":"mandatory_in_full_preprod | removable_in_ideation_factory","amendments":["real_files","game_derived_skin","two_pass_qa","structure_not_skin","design_bar","examples_as_illustration"]}'::jsonb
)
ON CONFLICT (node_key) DO UPDATE SET
  title=EXCLUDED.title, phase=EXCLUDED.phase, role=EXCLUDED.role, status=EXCLUDED.status,
  purpose=EXCLUDED.purpose, standalone_prompt=EXCLUDED.standalone_prompt, default_prompt=EXCLUDED.default_prompt,
  constraints=EXCLUDED.constraints, tools=EXCLUDED.tools, skills=EXCLUDED.skills, executor=EXCLUDED.executor,
  inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, metadata=EXCLUDED.metadata, updated_at=now();

-- ─── Blueprint: Pre-Production (Sub-Phase A) ───
-- node_sequence y edges se resuelven desde node_key. Gate placeholder conversacional
-- (lo reemplaza 3.7 GDD Assembly en PP-3). Se irá extendiendo con B/C en waves siguientes.
WITH ids AS (
  SELECT node_key, id FROM v57.forge_nodes WHERE node_key IN ('3.1','3.2','3.3','3.4','3.4b','3.5','3.6')
)
INSERT INTO v57.forge_blueprints (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
SELECT
  'preprod_full', 'Pre-Production (full)', 'pre-production',
  'Full Pre-Production workflow. Sub-Phase A (Design) seeded first; B/C added in later waves.',
  (SELECT jsonb_agg(jsonb_build_object('node_id',(SELECT id FROM ids WHERE node_key=x.k),'order_index',x.o) ORDER BY x.o)
     FROM (VALUES ('3.1',1),('3.2',2),('3.3',3),('3.4',3),('3.4b',4),('3.5',4),('3.6',5)) x(k,o)),
  (SELECT jsonb_agg(jsonb_build_object('from_node_id',(SELECT id FROM ids WHERE node_key=e.f),'to_node_id',(SELECT id FROM ids WHERE node_key=e.t)))
     FROM (VALUES ('3.1','3.2'),('3.2','3.3'),('3.1','3.4'),('3.2','3.4'),('3.4','3.4b'),('3.2','3.4b'),('3.4','3.5'),('3.2','3.6'),('3.3','3.6'),('3.5','3.6'),('3.4b','3.6')) e(f,t)),
  '{"name":"Design Review","mode":"conversational","suggested_rubrics":["pillars testable","real numbers present","mechanics reinforce pillars","world justifies loop","UX teaches the loop"],"outcomes":["accept","refine","kill"]}'::jsonb,
  false
ON CONFLICT (blueprint_key) DO UPDATE SET
  name=EXCLUDED.name, phase=EXCLUDED.phase, node_sequence=EXCLUDED.node_sequence,
  edges=EXCLUDED.edges, gate=EXCLUDED.gate, description=EXCLUDED.description, updated_at=now();
