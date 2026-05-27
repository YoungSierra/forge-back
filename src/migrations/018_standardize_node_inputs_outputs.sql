-- ============================================================
-- Migration 018 — Estandarizar inputs/outputs de los 8 nodos canónicos
--
-- Cambios:
--   1. inputs: de {required:[], optional:[], description:""} a
--      [{key, label, accepts:[], required}] — formato para auto-wiring
--   2. Renombrar input keys que tenían referencias a nodos
--      (ej. "market_research_output_1_2" → "market_gap_analysis")
--   3. Outputs 1.1 y 2.1: concept_brief / pitch_document promovidos
--      a canonical:true y emitidos siempre sin restricción de modo
-- ============================================================

-- ─── 1.1 — Idea Generation ────────────────────────────────────
UPDATE v57.forge_nodes SET
  inputs = '[
    {"key":"creative_prompt","label":"Creative Prompt","accepts":["text"],"required":true},
    {"key":"studio_context","label":"Studio Context","accepts":["text"],"required":false},
    {"key":"team_preferences","label":"Team Preferences","accepts":["text"],"required":false},
    {"key":"concepts_to_avoid","label":"Concepts to Avoid","accepts":["text"],"required":false}
  ]'::jsonb,
  outputs = '[
    {"name":"concept_brief","format":"markdown","description":"One crystallised concept brief — canonical output, always emitted (winner in broad mode, direct brief in seed mode)","canonical":true},
    {"name":"concept_list","format":"markdown","description":"10-30 concept one-liners","mode":"broad_prompt"},
    {"name":"scored_shortlist","format":"markdown","description":"Top 5-10 scored on originality, market fit, team fit, feasibility","mode":"broad_prompt"},
    {"name":"rationales","format":"markdown","description":"One-paragraph rationale per shortlisted concept","mode":"broad_prompt"}
  ]'::jsonb,
  updated_at = now()
WHERE node_key = '1.1';

-- ─── 1.2 — Market & Competitive Research ──────────────────────
-- concept_seed_or_shortlist → concept_brief
UPDATE v57.forge_nodes SET
  inputs = '[
    {"key":"concept_brief","label":"Concept Brief","accepts":["text"],"required":true},
    {"key":"target_platform","label":"Target Platform","accepts":["text"],"required":false},
    {"key":"reference_titles","label":"Reference Titles","accepts":["text"],"required":false}
  ]'::jsonb,
  updated_at = now()
WHERE node_key = '1.2';

-- ─── 1.3 — Audience & Positioning ────────────────────────────
-- market_research_output_1_2 → market_gap_analysis
-- concept_seed → concept_brief
UPDATE v57.forge_nodes SET
  inputs = '[
    {"key":"market_gap_analysis","label":"Market Gap Analysis","accepts":["text"],"required":true},
    {"key":"concept_brief","label":"Concept Brief","accepts":["text"],"required":true},
    {"key":"studio_audience_data","label":"Studio Audience Data","accepts":["text"],"required":false}
  ]'::jsonb,
  updated_at = now()
WHERE node_key = '1.3';

-- ─── 2.1 — Pitch Document ─────────────────────────────────────
-- concept_seed_or_shortlist → concept_brief
-- audience_positioning_output_1_3 → positioning_statement
-- market_research_output_1_2 → market_gap_analysis
UPDATE v57.forge_nodes SET
  inputs = '[
    {"key":"concept_brief","label":"Concept Brief","accepts":["text"],"required":true},
    {"key":"positioning_statement","label":"Positioning Statement","accepts":["text"],"required":false},
    {"key":"market_gap_analysis","label":"Market Gap Analysis","accepts":["text"],"required":false}
  ]'::jsonb,
  outputs = '[
    {"name":"pitch_document","format":"docx","description":"One-page pitch, V57 High-Level Pitch template: hook, elevator line, why now, production fit","canonical":true},
    {"name":"light_pitches","format":"markdown","description":"5-10 light pitch variations, each one paragraph: hook + elevator line + why now","mode":"ideation"}
  ]'::jsonb,
  updated_at = now()
WHERE node_key = '2.1';

-- ─── 2.2 — Concept Document ───────────────────────────────────
-- pitch_document_output_2_1 → pitch_document
-- audience_positioning_output_1_3 → positioning_statement
-- market_research_output_1_2 → market_gap_analysis
UPDATE v57.forge_nodes SET
  inputs = '[
    {"key":"pitch_document","label":"Pitch Document","accepts":["document","text"],"required":true},
    {"key":"positioning_statement","label":"Positioning Statement","accepts":["text"],"required":true},
    {"key":"market_gap_analysis","label":"Market Gap Analysis","accepts":["text"],"required":true},
    {"key":"reference_works","label":"Reference Works","accepts":["text","image"],"required":false},
    {"key":"tonal_references","label":"Tonal References","accepts":["text"],"required":false}
  ]'::jsonb,
  updated_at = now()
WHERE node_key = '2.2';

-- ─── 2.3 — Art Direction ─────────────────────────────────────
-- concept_document_art_audio_section → concept_document
UPDATE v57.forge_nodes SET
  inputs = '[
    {"key":"concept_document","label":"Concept Document","accepts":["document","text"],"required":true}
  ]'::jsonb,
  updated_at = now()
WHERE node_key = '2.3';

-- ─── 2.4 — Concept Presentation ───────────────────────────────
-- pitch_document_output_2_1 → pitch_document
-- concept_document_output_2_2 → concept_document
-- art_direction_output_2_3 → art_direction_brief
-- imágenes de 2.3 ahora explícitas para auto-wiring
UPDATE v57.forge_nodes SET
  inputs = '[
    {"key":"pitch_document","label":"Pitch Document","accepts":["document","text"],"required":true},
    {"key":"concept_document","label":"Concept Document","accepts":["document","text"],"required":true},
    {"key":"art_direction_brief","label":"Art Direction Brief","accepts":["text"],"required":true},
    {"key":"image_wide","label":"Wide Image (16:9)","accepts":["image"],"required":true},
    {"key":"image_interior","label":"Interior Image (16:9)","accepts":["image"],"required":true},
    {"key":"image_object","label":"Object Image (1:1)","accepts":["image"],"required":true},
    {"key":"market_gap_analysis","label":"Market Gap Analysis","accepts":["text"],"required":false}
  ]'::jsonb,
  updated_at = now()
WHERE node_key = '2.4';

-- ─── 2.5 — Concept Review & Lock ─────────────────────────────
-- pitch_2_1 → pitch_document
-- concept_doc_2_2 → concept_document
-- art_direction_2_3 → art_direction_brief
-- presentation_2_4 → investor_deck
-- project_context eliminado (viene via Layer 2 automáticamente)
UPDATE v57.forge_nodes SET
  inputs = '[
    {"key":"pitch_document","label":"Pitch Document","accepts":["document","text"],"required":true},
    {"key":"concept_document","label":"Concept Document","accepts":["document","text"],"required":true},
    {"key":"art_direction_brief","label":"Art Direction Brief","accepts":["text"],"required":true},
    {"key":"investor_deck","label":"Investor Deck","accepts":["document"],"required":true},
    {"key":"image_wide","label":"Wide Image","accepts":["image"],"required":false},
    {"key":"image_interior","label":"Interior Image","accepts":["image"],"required":false},
    {"key":"image_object","label":"Object Image","accepts":["image"],"required":false}
  ]'::jsonb,
  updated_at = now()
WHERE node_key = '2.5';
