-- Migración 028: actualiza skills[] de los 11 nodos activos según Node DNA v1.4.2
-- Solo modifica la columna skills (text[]). No toca outputs, inputs, prompts ni ningún otro campo.

UPDATE v57.forge_nodes SET skills = ARRAY['game_concept_generation','genre_taxonomy','market_aware_creative_framing','game_elevator_line_construction']
WHERE node_key = '1.1' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['game_market_competitive_analysis','steam_console_market_intelligence','audience_sizing_methodology']
WHERE node_key = '1.2' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['audience_persona_development','positioning_statement_writing','game_market_segmentation']
WHERE node_key = '1.3' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['investment_rubric_application','concept_review_facilitation']
WHERE node_key = '1.4' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['investment_committee_pitch_writing','v57_pitch_template','game_elevator_line_construction']
WHERE node_key = '2.1' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['v57_concept_treatment_template','game_concept_specification','investment_committee_concept_writing']
WHERE node_key = '2.2' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['game_business_model_financials','audience_sizing_methodology']
WHERE node_key = '2.3' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['art_direction_brief_writing','triptych_palette_locking']
WHERE node_key = '2.4' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['v57_cinematic_deck_template','investment_committee_presentation','concept_package_narrative_flow']
WHERE node_key = '2.5' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['strategic_content_analyst_review']
WHERE node_key = '2.6' AND status = 'active';

UPDATE v57.forge_nodes SET skills = ARRAY['concept_review_facilitation','investment_rubric_application']
WHERE node_key = '2.7' AND status = 'active';
