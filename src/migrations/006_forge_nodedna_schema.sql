-- ============================================================
-- Migration 006 — Forge NodeDNA v1.1.0
-- Nuevas tablas forge_* para la arquitectura NodeDNA.
-- No toca tablas existentes (excepto ADD COLUMN en projects).
-- Las tablas viejas (step_configs, generation_jobs, pipelines,
-- action_instances) conviven hasta el cleanup final.
--
-- Para empezar con datos limpios, ejecutar primero:
--   TRUNCATE v57.projects CASCADE;
-- ============================================================

-- ─── 1. forge_nodes — librería canónica de nodos ─────────────
create table if not exists v57.forge_nodes (
  id              uuid primary key default gen_random_uuid(),
  node_key        text not null unique,
  title           text not null,
  phase           text not null,
  status          text not null default 'active'
                    check (status in ('active', 'archived')),
  parent_id       uuid references v57.forge_nodes(id),

  -- 7 DNA properties
  purpose         text not null default '',
  inputs          jsonb not null default '{"required":[],"optional":[],"description":""}',
  outputs         jsonb not null default '[]',
  constraints     text not null default '',
  tools           text[] not null default '{}',
  skills          text[] not null default '{}',
  default_prompt  text not null default '',

  created_by      uuid references v57.members(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ─── 2. forge_blueprints — plantillas de workflow ────────────
create table if not exists v57.forge_blueprints (
  id              uuid primary key default gen_random_uuid(),
  blueprint_key   text not null unique,
  name            text not null,
  phase           text not null,
  description     text,
  node_sequence   jsonb not null default '[]',  -- [{node_id, order_index}]
  edges           jsonb not null default '[]',  -- [{from_node_id, to_node_id}]
  gate            jsonb not null default '{}',  -- {name, mode, suggested_rubrics[], outcomes[]}
  is_default      boolean not null default false,

  created_by      uuid references v57.members(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ─── 3. forge_project_blueprints — historial de blueprints por proyecto ──
create table if not exists v57.forge_project_blueprints (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references v57.projects(id) on delete cascade,
  blueprint_id    uuid not null references v57.forge_blueprints(id),
  trigger         text not null
                    check (trigger in ('project_creation', 'gate_accept', 'manual')),
  gate_decision   text
                    check (gate_decision in ('ACCEPT', 'REFINE', 'KILL')),
  loaded_by       uuid references v57.members(id),
  loaded_at       timestamptz not null default now()
);

-- ─── 4. forge_project_nodes — pool de nodos en el canvas ─────
create table if not exists v57.forge_project_nodes (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references v57.projects(id) on delete cascade,
  node_id         uuid not null references v57.forge_nodes(id),
  blueprint_id    uuid references v57.forge_blueprints(id),
  order_index     integer not null default 0,
  removed         boolean not null default false,
  added_at        timestamptz not null default now(),
  removed_at      timestamptz
);

-- ─── 5. forge_sessions — una ejecución de un nodo (audit trail) ──
-- Nota: output_asset_id FK se añade después de crear forge_assets
create table if not exists v57.forge_sessions (
  id              uuid primary key default gen_random_uuid(),
  node_id         uuid not null references v57.forge_nodes(id),
  project_id      uuid not null references v57.projects(id) on delete cascade,
  blueprint_id    uuid references v57.forge_blueprints(id),
  triggered_by    uuid references v57.members(id),
  status          text not null default 'active'
                    check (status in ('active', 'approved', 'rejected', 'abandoned')),
  iteration_count integer not null default 0,
  output_asset_id uuid,  -- FK a forge_assets se añade abajo
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- ─── 6. forge_messages — mensajes de conversación por sesión ─
create table if not exists v57.forge_messages (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references v57.forge_sessions(id) on delete cascade,
  role            text not null
                    check (role in ('human', 'agent', 'system')),
  content         text not null,
  order_index     integer not null,
  tool_calls      jsonb not null default '[]',  -- [{tool, input_summary, output_summary, timestamp}]
  created_at      timestamptz not null default now()
);

-- ─── 7. forge_attachments — archivos adjuntos (Reference Injection) ──
create table if not exists v57.forge_attachments (
  id              uuid primary key default gen_random_uuid(),
  message_id      uuid not null references v57.forge_messages(id) on delete cascade,
  session_id      uuid not null references v57.forge_sessions(id) on delete cascade,
  file_name       text not null,
  mime_type       text,
  file_size_bytes bigint,
  storage_url     text not null,
  storage_bucket  text not null default 'forge-assets',
  extracted_text  text,  -- contenido extraído para contexto del agente
  created_at      timestamptz not null default now()
);

-- ─── 8. forge_assets — outputs versionados e inmutables ──────
create table if not exists v57.forge_assets (
  id              uuid primary key default gen_random_uuid(),
  node_id         uuid not null references v57.forge_nodes(id),
  project_id      uuid not null references v57.projects(id) on delete cascade,
  session_id      uuid not null references v57.forge_sessions(id),
  name            text not null,
  format          text not null
                    check (format in (
                      'docx', 'pptx', 'png', 'markdown', 'markdown_table',
                      'json', 'artifact_bundle', 'single_sentence', 'structured'
                    )),
  version_number  integer not null default 1,
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected')),
  storage_url     text,
  storage_bucket  text default 'forge-assets',
  file_size_bytes bigint,
  mime_type       text,
  metadata        jsonb not null default '{}',
  derived_from_id uuid references v57.forge_assets(id),  -- lineage

  approved_by     uuid references v57.members(id),
  approved_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- ─── FK circular: forge_sessions.output_asset_id → forge_assets ──
alter table v57.forge_sessions
  add constraint forge_sessions_output_asset_id_fkey
  foreign key (output_asset_id) references v57.forge_assets(id)
  deferrable initially deferred;

-- ─── 9. Adiciones a projects (context layer + branch tracking) ──
alter table v57.projects
  add column if not exists studio_name       text,
  add column if not exists target_platform   text,
  add column if not exists team_scale        text,
  add column if not exists budget_range      text,
  add column if not exists timeline          text,
  add column if not exists context_notes     text,
  add column if not exists parent_project_id uuid references v57.projects(id);

-- ─── Índices útiles ───────────────────────────────────────────
create index if not exists idx_forge_project_nodes_project on v57.forge_project_nodes(project_id);
create index if not exists idx_forge_sessions_project_node on v57.forge_sessions(project_id, node_id);
create index if not exists idx_forge_messages_session on v57.forge_messages(session_id, order_index);
create index if not exists idx_forge_assets_session on v57.forge_assets(session_id);
create index if not exists idx_forge_assets_project_node on v57.forge_assets(project_id, node_id);

-- ============================================================
-- SEED DATA — 8 nodos canónicos + 2 blueprints
-- Fuente: Forge_NodeDNA_Reference_1.json v1.1.0
-- ============================================================

-- ─── Nodos — Phase: ideation ──────────────────────────────────

insert into v57.forge_nodes
  (node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt)
values (
  '1.1',
  'Idea Generation',
  'ideation',
  'Capture the first creative provocation for a game concept. Generate concept variations if the prompt is broad; crystallise a single concept if the prompt is a seed.',
  '{"required":["creative_prompt"],"optional":["studio_context","team_preferences","concepts_to_avoid"],"description":"A creative prompt — theme, genre, mechanic, mood, or one-sentence concept seed. Optional studio and team context."}',
  '[{"name":"concept_list","format":"markdown","description":"10-30 concept one-liners","mode":"broad_prompt"},{"name":"scored_shortlist","format":"markdown","description":"Top 5-10 scored on originality, market fit, team fit, feasibility","mode":"broad_prompt"},{"name":"rationales","format":"markdown","description":"One-paragraph rationale per shortlisted concept","mode":"broad_prompt"},{"name":"concept_brief","format":"markdown","description":"One crystallised concept brief, one paragraph","mode":"seed_prompt"}]',
  'Concepts must be commercially viable for the studio scale. No invented IP. Cite real comparables. At least 30% of variations in adjacent genres, not just the prompted one.',
  array['web_search','kb_read'],
  array['game_concept_generation','genre_taxonomy','market_aware_creative_framing'],
  'BROAD MODE: Generate concept variations for [prompt]. Score on originality, market fit, team fit, feasibility. Surface the top 5-10 with one-paragraph rationale. SEED MODE: Crystallise this concept seed into a one-paragraph concept brief: [seed].'
) on conflict (node_key) do nothing;

insert into v57.forge_nodes
  (node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt)
values (
  '1.2',
  'Market & Competitive Research',
  'ideation',
  'Research the market context for this game. Produce three named sub-outputs: competitive scan, market gap analysis, and audience size estimate.',
  '{"required":["concept_seed_or_shortlist"],"optional":["target_platform","reference_titles"],"description":"Concept seed or shortlisted concepts from Idea Generation. Optional platform and reference targets."}',
  '[{"name":"competitive_scan","format":"markdown_table","description":"5-10 comparable titles with revenue and review data"},{"name":"market_gap_analysis","format":"markdown","description":"One paragraph identifying the defensible competitive gap"},{"name":"cultural_moment_anchor","format":"markdown","description":"1-3 named cultural references (films, TV, viral phenomena)"},{"name":"audience_sizing","format":"markdown","description":"Audience size estimate with methodology note"}]',
  'Cite real sources. No invented studios or revenue figures. Always identify a cultural-moment angle if one exists. Flag ambiguity rather than inventing a gap.',
  array['web_search','web_fetch','kb_read'],
  array['game_market_competitive_analysis','steam_console_market_intelligence','audience_sizing_methodology'],
  'Scan the market for [project]. Produce: (1) competitive scan of 5-10 comparable titles with revenue/review data, (2) market gap analysis, (3) cultural moment anchor. Cite sources.'
) on conflict (node_key) do nothing;

insert into v57.forge_nodes
  (node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt)
values (
  '1.3',
  'Audience & Positioning',
  'ideation',
  'Define the target audience and market positioning for this game. Produce a positioning statement the team can commit to.',
  '{"required":["market_research_output_1_2","concept_seed"],"optional":["studio_audience_data"],"description":"Output of Market Research (1.2) and concept seed. Optional studio audience data."}',
  '[{"name":"primary_persona","format":"markdown","description":"Primary audience persona, one paragraph, specific demographics"},{"name":"secondary_persona","format":"markdown","description":"Secondary persona if relevant","optional":true},{"name":"positioning_statement","format":"single_sentence","description":"Format: For [audience] who [need], [project] is the [category] that [differentiator]."},{"name":"audience_fit_rationale","format":"markdown","description":"Why this audience for this game"}]',
  'Audience descriptions must be specific — age range, platforms played, comparable titles they love. No "gamers" as audience. Positioning statement must reference at least one competitor.',
  array['web_search','kb_read'],
  array['audience_persona_development','positioning_statement_writing','game_market_segmentation'],
  'Define the target audience and positioning for [project]. Format: "For [audience] who [need], [project] is the [category] that [differentiator]." Include primary persona, secondary persona if relevant, and rationale.'
) on conflict (node_key) do nothing;

-- ─── Nodos — Phase: concept ───────────────────────────────────

insert into v57.forge_nodes
  (node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt)
values (
  '2.1',
  'Pitch Document',
  'concept',
  'Produce a high-level pitch document (or multiple light pitches in exploration mode) capturing the game''s hook, positioning, and why-now.',
  '{"required":["concept_seed_or_shortlist"],"optional":["audience_positioning_output_1_3","market_research_output_1_2"],"description":"Concept seed or shortlist. Optional audience and market research outputs."}',
  '[{"name":"pitch_document","format":"docx","description":"One-page pitch, V57 High-Level Pitch template: hook, elevator line, why now, production fit","mode":"concept"},{"name":"light_pitches","format":"markdown","description":"5-10 light pitch variations, each one paragraph: hook + elevator line + why now","mode":"ideation"}]',
  'Elevator line must match the one that will appear in the Concept Document. No hedging language. Why-now must cite a specific cultural or market catalyst. Maximum one page per pitch.',
  array['kb_read','doc_gen_docx'],
  array['investment_committee_pitch_writing','v57_pitch_template','game_elevator_line_construction'],
  'CONCEPT MODE: Produce a one-page High-Level Pitch for [project] using the V57 template. Include: hook, elevator line, why now, production fit. IDEATION MODE: Produce 5-10 light pitch variations for [prompt]. Each: one paragraph with hook, elevator line, why now.'
) on conflict (node_key) do nothing;

insert into v57.forge_nodes
  (node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt)
values (
  '2.2',
  'Concept Document',
  'concept',
  'Produce the full High-Level Concept Document in the V57 template format. Structured with named sections, each individually referenceable.',
  '{"required":["pitch_document_output_2_1","audience_positioning_output_1_3","market_research_output_1_2"],"optional":["reference_works","tonal_references"],"description":"Output of Pitch Document (2.1), Audience & Positioning (1.3), and Market Research (1.2)."}',
  '[{"name":"concept_document","format":"docx","description":"Two-page V57 Concept Treatment. Named sections: fact_sheet, one_liner, setting, core_fantasy, core_loop, signature_mechanics, levels, art_and_audio_direction, narrative_hook, differentiators"}]',
  'V57 template structure required. Two-page maximum. Core Loop: 3-5 verb-stages. Signature Mechanics: exactly three. One-liner identical to Pitch Document elevator line. No placeholder language.',
  array['kb_read','doc_gen_docx'],
  array['v57_concept_treatment_template','game_concept_specification','investment_committee_concept_writing'],
  'Produce the High-Level Concept Document for [project] using the V57 template. Core Loop: 3-5 verb-stages. Signature Mechanics: exactly three. One-liner must match the Pitch Document.'
) on conflict (node_key) do nothing;

insert into v57.forge_nodes
  (node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt)
values (
  '2.3',
  'Art Direction',
  'concept',
  'Establish the visual identity through a triptych of three generated images and a written art-direction brief. Images generated in-platform.',
  '{"required":["concept_document_art_audio_section"],"optional":[],"description":"Art & Audio Direction section of the Concept Document, plus Setting and Reference Stack sections."}',
  '[{"name":"image_wide","format":"png","description":"Wide environment shot, 16:9"},{"name":"image_interior","format":"png","description":"Interior or character-scale context, 16:9"},{"name":"image_object","format":"png","description":"Object close-up for social/Steam capsule, 1:1"},{"name":"image_prompts","format":"markdown","description":"Three structured prompts saved for reproducibility"},{"name":"art_direction_brief","format":"markdown","description":"Visual principle + negative-space rules"}]',
  'Palette consistent across all three images — repeat at least three palette phrases verbatim. Named references must be specific artists/films/photographers. Negative prompts must exclude genre clichés.',
  array['image_gen_native','web_search','kb_read'],
  array['v57_image_prompt_architecture','art_direction_brief_writing','triptych_palette_locking'],
  'Produce the art-direction triptych for [project]. Wide environment (16:9), interior context (16:9), object close-up (1:1). Lock palette across all three. Brief: visual principle + what we are deliberately NOT doing.'
) on conflict (node_key) do nothing;

insert into v57.forge_nodes
  (node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt)
values (
  '2.4',
  'Concept Presentation',
  'concept',
  'Produce an investor-ready 8-10 slide presentation deck summarising the concept package using the V57 cinematic template.',
  '{"required":["pitch_document_output_2_1","concept_document_output_2_2","art_direction_output_2_3"],"optional":["market_research_output_1_2"],"description":"Output of Pitch Document (2.1), Concept Document (2.2), and Art Direction (2.3)."}',
  '[{"name":"investor_deck","format":"pptx","description":"Investor-ready 8-10 slide deck, V57 cinematic template. Structure: cover, elevator_line, setting, core_fantasy_and_loop, signature_mechanics, world, differentiators_and_why_now, production_fit, closing"}]',
  'Maximum 10 slides. All images from Art Direction Node only. Elevator line identical to Pitch Document. Production Fit uses Fact Sheet data from Concept Document. No hedging language.',
  array['doc_gen_pptx','image_read','kb_read'],
  array['v57_cinematic_deck_template','investment_committee_presentation','concept_package_narrative_flow'],
  'Produce an 8-10 slide investor deck for [project] using the V57 cinematic template. Pull all images from Art Direction. Structure: Cover → Elevator → Setting → Fantasy + Loop → Mechanics → World → Differentiators + Why Now → Production Fit → Closing.'
) on conflict (node_key) do nothing;

insert into v57.forge_nodes
  (node_key, title, phase, purpose, inputs, outputs, constraints, tools, skills, default_prompt)
values (
  '2.5',
  'Concept Review & Lock',
  'concept',
  'Surface the full concept package for human review and decision. Accept natural-language gate decisions. Absorbs the former Idea Selection & Refinement node.',
  '{"required":["pitch_2_1","concept_doc_2_2","art_direction_2_3","presentation_2_4","project_context"],"optional":[],"description":"All upstream artifacts from the Concept phase plus project context."}',
  '[{"name":"gate_decision","format":"structured","description":"ACCEPT | REFINE | KILL"},{"name":"locked_concept_package","format":"artifact_bundle","description":"Full concept package as a single locked referenceable artifact","condition":"if_ACCEPT"}]',
  'Suggested rubrics (clarity, art direction coherence, scope realism, audience fit) are guidance, not required checkboxes. Decisions are reversible.',
  array['kb_read','artifact_manage'],
  array['concept_review_facilitation','investment_rubric_application'],
  'Review the full concept package for [project]. Accept, refine, or kill. Suggested rubrics: pitch clarity, art direction coherence, scope realism, audience fit.'
) on conflict (node_key) do nothing;

-- ─── Blueprints ───────────────────────────────────────────────

insert into v57.forge_blueprints
  (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
select
  'ideation_default',
  'Ideation Blueprint (default)',
  'ideation',
  'Recommended starting workflow for Ideation. Loaded by default when a new project is created. Users remove Nodes they do not need.',
  jsonb_build_array(
    jsonb_build_object('node_id', n11.id, 'order_index', 1),
    jsonb_build_object('node_id', n12.id, 'order_index', 2),
    jsonb_build_object('node_id', n13.id, 'order_index', 3)
  ),
  jsonb_build_array(
    jsonb_build_object('from_node_id', n11.id, 'to_node_id', n12.id),
    jsonb_build_object('from_node_id', n12.id, 'to_node_id', n13.id)
  ),
  '{"name":"Ideation Review","mode":"conversational","suggested_rubrics":["clear hook","defined audience","market gap identified","team passion"],"outcomes":["accept","refine","kill"]}'::jsonb,
  true
from
  (select id from v57.forge_nodes where node_key = '1.1') n11,
  (select id from v57.forge_nodes where node_key = '1.2') n12,
  (select id from v57.forge_nodes where node_key = '1.3') n13
on conflict (blueprint_key) do nothing;

insert into v57.forge_blueprints
  (blueprint_key, name, phase, description, node_sequence, edges, gate, is_default)
select
  'concept_default',
  'Concept Blueprint (default)',
  'concept',
  'Recommended starting workflow for Concept. Loaded when the Ideation gate is passed.',
  jsonb_build_array(
    jsonb_build_object('node_id', n21.id, 'order_index', 1),
    jsonb_build_object('node_id', n22.id, 'order_index', 2),
    jsonb_build_object('node_id', n23.id, 'order_index', 3),
    jsonb_build_object('node_id', n24.id, 'order_index', 4),
    jsonb_build_object('node_id', n25.id, 'order_index', 5)
  ),
  jsonb_build_array(
    jsonb_build_object('from_node_id', n21.id, 'to_node_id', n22.id),
    jsonb_build_object('from_node_id', n22.id, 'to_node_id', n23.id),
    jsonb_build_object('from_node_id', n23.id, 'to_node_id', n24.id),
    jsonb_build_object('from_node_id', n24.id, 'to_node_id', n25.id)
  ),
  '{"name":"Concept Approval Gate","mode":"conversational","suggested_rubrics":["pitch clarity","art direction coherence","scope realism","audience fit"],"outcomes":["accept","refine","kill"]}'::jsonb,
  true
from
  (select id from v57.forge_nodes where node_key = '2.1') n21,
  (select id from v57.forge_nodes where node_key = '2.2') n22,
  (select id from v57.forge_nodes where node_key = '2.3') n23,
  (select id from v57.forge_nodes where node_key = '2.4') n24,
  (select id from v57.forge_nodes where node_key = '2.5') n25
on conflict (blueprint_key) do nothing;
