-- Seed: 11 nodos v1.3.0 (Ideation + Concept)
-- Ejecutar DESPUÉS de 025_node_dna_v1_3_0.sql

INSERT INTO forge_nodes (node_key, title, phase, role, status, purpose, standalone_prompt, default_prompt, constraints, tools, skills, executor, inputs, outputs) VALUES

-- ─── 1.1 Concept Exploration ─────────────────────────────────
('1.1', 'Concept Exploration', 'ideation', 'standard', 'active',
'Explore the user''s creative brief and crystallise it into one or more named concept seeds, each strong enough to develop into a full concept.',
'The user will describe their creative brief directly in chat — it may be a rough idea, a genre, a reference, or a full brief. Extract what they give you and begin exploring from there.',
'Explore this brief: [brief]. Diverge first across angles (mechanic / fantasy / market-gap / X-meets-Y / constraint). Then converge to the strongest few — one if clear, several if open. Each seed: id, title, one-liner, rationale. Cite real comparables.',
'Commercially viable at studio scale. No invented IP. Cite real comparables. Each seed distinct in fantasy or mechanic. Diverge before converging. Seed count honest: one if clear, several if open.',
ARRAY['web_search','kb_read'],
ARRAY['Game concept generation','Genre taxonomy','Market-aware creative framing','Elevator-line construction'],
'{"type":"llm"}',
'{"wired":[],"direct_context":"Describe your creative brief, genre ideas, references, or any starting point"}',
'[
  {"key":"concept_seeds","label":"Concept Seeds","type":"connection","format":"list<concept_seed>","prompt":"Emit the curated concept seeds as structured data: id, title, one_liner, rationale for each."},
  {"key":"exploration_summary","label":"Exploration Summary","type":"asset","format":"markdown","prompt":"Produce a markdown summary of the exploration: angles considered, seeds generated, rationale for each keep/cull."}
]'::jsonb),

-- ─── 1.2 Market & Competitive Research ──────────────────────
('1.2', 'Market & Competitive Research', 'ideation', 'standard', 'active',
'Research the market context and identify a defensible competitive gap, anchored in a cultural moment when one exists.',
'The user will describe the concept(s) to research directly. Extract genre, setting, and target platform from their message and proceed.',
'Scan the market for [seeds]. Produce the competitive scan (5–10 real titles), gap analysis with cultural-moment anchor, and audience sizing (estimate + methodology). Cite every source.',
'Cite real sources; most recent data first. No invented studios/revenue. Flag ambiguity rather than inventing a gap. Sizing shows its method.',
ARRAY['web_search','web_fetch','kb_read'],
ARRAY['Game-market competitive analysis','Steam/console market intelligence','Audience sizing methodology'],
'{"type":"llm"}',
'{"wired":[{"key":"concept_seeds","cardinality":"one_or_more","type":"concept_seed","required":false}],"direct_context":"Describe the concept(s) to research — genre, platform, setting, comparable titles"}',
'[
  {"key":"market_gap_analysis","label":"Market Gap Analysis","type":"connection","format":"gap_analysis","prompt":"Emit the market gap analysis as structured data: text summary and cultural_moment anchor."},
  {"key":"competitive_scan","label":"Competitive Scan","type":"asset","format":"markdown","prompt":"Produce a markdown table of 5–10 real titles with revenue, reviews, platform, and differentiators. Cite all sources."},
  {"key":"audience_sizing","label":"Audience Sizing","type":"asset","format":"markdown","prompt":"Produce audience sizing: estimated addressable audience with methodology. Label as indicative if comparables-based."}
]'::jsonb),

-- ─── 1.3 Audience & Positioning ─────────────────────────────
('1.3', 'Audience & Positioning', 'ideation', 'standard', 'active',
'Decide the target audience and the positioning that distinguishes this game from the competitive set. Research gathers; Positioning decides.',
'The user will describe their concept and any market context directly. Extract what they provide and define audience and positioning from there.',
'Define audience and positioning for [seeds]. Format: ''For [audience] who [need], [project] is the [category] that [differentiator].'' Persona specific; positioning names a competitor.',
'Audience specific — age, platforms, comparable titles they love. Never "gamers". Positioning names ≥1 competitor and one true differentiator.',
ARRAY['web_search','kb_read'],
ARRAY['Audience persona development','Positioning statement writing','Market segmentation'],
'{"type":"llm"}',
'{"wired":[{"key":"concept_seeds","cardinality":"one_or_more","type":"concept_seed","required":false},{"key":"market_gap_analysis","cardinality":"single","type":"gap_analysis","required":false}],"direct_context":"Describe your concept and any market research — paste it directly or attach a document"}',
'[
  {"key":"positioning_statement","label":"Positioning Statement","type":"connection","format":"positioning","prompt":"Emit the positioning statement as structured data: ''For [audience] who [need], [project] is the [category] that [differentiator].''"},
  {"key":"primary_persona","label":"Primary Persona","type":"asset","format":"markdown","prompt":"Produce the primary persona: name, age range, platforms, titles they love, motivations, and why this game fits them."}
]'::jsonb),

-- ─── 1.4 Concept Selection (Ideation Gate) ──────────────────
('1.4', 'Concept Selection', 'ideation', 'gate', 'active',
'Act as the Ideation gate: review the shortlist against a light rubric and decide which seeds advance to Concept.',
'The user will provide concept seeds directly — paste, describe, or attach. Review them against the rubric and curate which advance.',
'Review [seeds] as the Ideation gate. Score each against the rubric (hook, audience, gap, passion, scope) as guidance. Advance the seeds worth developing with a one-line reason; note refined or dropped. Emit the curated seed list.',
'Rubric is guidance, never checkboxes (hook · audience · gap · passion · scope). Advance only seeds worth developing. Name the reason for every advance/refine/drop. Reversible. No forced picker inside chat.',
ARRAY['kb_read'],
ARRAY['Investment rubric application','Concept review facilitation'],
'{"type":"llm"}',
'{"wired":[{"key":"concept_seeds","cardinality":"one_or_more","type":"concept_seed","required":false},{"key":"market_gap_analysis","cardinality":"single","type":"gap_analysis","required":false},{"key":"positioning_statement","cardinality":"single","type":"positioning","required":false}],"direct_context":"Paste or describe your concept seeds and any research or positioning you have"}',
'[
  {"key":"selected_seeds","label":"Selected Seeds","type":"connection","format":"list<concept_seed>","prompt":"Emit the curated list of seeds that advance. Same schema as concept_seed, survivors only."},
  {"key":"selection_scorecard","label":"Selection Scorecard","type":"asset","format":"markdown","prompt":"Produce the scorecard: for each seed, rubric scores and a one-line verdict (advance / refine / drop) with reason."}
]'::jsonb),

-- ─── 2.1 Pitch Document ──────────────────────────────────────
('2.1', 'Pitch Document', 'concept', 'standard', 'active',
'Produce the high-level rhetorical pitch for this concept: hook, elevator line, why-now, production fit. One page max. Locks the elevator line for the lane.',
'The user will describe the concept seed directly. Extract title, one-liner, and any context they provide, then produce the pitch.',
'Produce the one-page High-Level Pitch for [seed] using the V57 template: hook, elevator line, why now, production fit. Lock the elevator line; why-now cites a specific catalyst.',
'Readable in under 2 minutes. No hedging. Why-now cites a specific catalyst. Elevator line locked verbatim for downstream use.',
ARRAY['kb_read','doc_gen_docx'],
ARRAY['Investment-committee pitch writing','V57 High-Level Pitch template','Elevator-line construction'],
'{"type":"llm"}',
'{"wired":[{"key":"concept_seed","cardinality":"single","type":"concept_seed","required":false,"note":"single<concept_seed> vs upstream list<concept_seed> → fan-out in Phase 2"},{"key":"positioning_statement","cardinality":"single","type":"positioning","required":false},{"key":"market_gap_analysis","cardinality":"single","type":"gap_analysis","required":false}],"direct_context":"Describe the concept seed: title, one-liner, genre, setting, core fantasy"}',
'[
  {"key":"elevator_line","label":"Elevator Line","type":"connection","format":"text","prompt":"Emit the locked elevator line as structured data: one sentence, no hedging."},
  {"key":"pitch_document","label":"Pitch Document","type":"asset","format":"docx","prompt":"Produce the one-page High-Level Pitch docx using V57 template: hook, elevator line, why now, production fit."}
]'::jsonb),

-- ─── 2.2 Concept Development ─────────────────────────────────
('2.2', 'Concept Development', 'concept', 'standard', 'active',
'Develop one concept seed into the full two-page Concept Treatment in the V57 template. The structural expansion of the pitch.',
'The user will describe the concept directly — paste a seed description, a rough concept, or any notes. Extract what they provide and develop the full treatment from there.',
'Develop [seed] into the full Concept Treatment using the V57 template. Core loop as 3–5 verbs. Exactly three signature mechanics. One-liner must match the pitch elevator line. No placeholders.',
'V57 template exactly. Two pages max. Core Loop 3–5 verb-stages. Exactly three signature mechanics. One-liner identical to the pitch elevator line. No placeholders.',
ARRAY['kb_read','doc_gen_docx'],
ARRAY['V57 Concept Treatment template','Game concept specification'],
'{"type":"llm"}',
'{"wired":[{"key":"concept_seed","cardinality":"single","type":"concept_seed","required":false},{"key":"elevator_line","cardinality":"single","type":"text","required":false},{"key":"positioning_statement","cardinality":"single","type":"positioning","required":false},{"key":"market_gap_analysis","cardinality":"single","type":"gap_analysis","required":false}],"direct_context":"Describe your concept: title, genre, core fantasy, mechanics, setting — paste notes or a document"}',
'[
  {"key":"concept_data","label":"Concept Data","type":"connection","format":"concept_data","prompt":"Emit the concept as structured data: title, one_liner, setting, core_fantasy, core_loop[], signature_mechanics[], differentiators[]."},
  {"key":"concept_document","label":"Concept Document","type":"asset","format":"docx","prompt":"Produce the two-page Concept Treatment docx using V57 template: Fact Sheet, One-Liner, Setting, Core Fantasy, Core Loop, Signature Mechanics, Levels, Art & Audio, Narrative Hook, Differentiators."}
]'::jsonb),

-- ─── 2.3 Business Model & Financials ─────────────────────────
('2.3', 'Business Model & Financials', 'concept', 'standard', 'active',
'Build the business case: model, pricing, budget, funding ask, and break-even framed against comparables or a sized audience.',
'The user will describe the concept and any financial context directly. Extract genre, target platform, team size, and any budget references they provide.',
'Build the financial_case for [concept]: model, price point (genre band), budget range (team × timeline), funding ask with use-of-funds, and break-even. Use audience_sizing if present; otherwise comparables-based labelled indicative. Produce the business_model document.',
'Model justified by genre norms. Price within genre band. Budget tied to team × timeline. Break-even from audience_sizing if present; otherwise comparables-based and labelled indicative. No invented revenue.',
ARRAY['web_search','kb_read'],
ARRAY['Game business model & financials','Audience sizing methodology'],
'{"type":"llm"}',
'{"wired":[{"key":"concept_data","cardinality":"single","type":"concept_data","required":false},{"key":"audience_sizing","cardinality":"single","type":"text","required":false,"note":"Asset from 1.2; firms the break-even when present"}],"direct_context":"Describe the concept, target platform, team size, and any budget or revenue references you have"}',
'[
  {"key":"financial_case","label":"Financial Case","type":"connection","format":"financial_case","prompt":"Emit the financial case as structured data: model, price_point, budget_range, funding_ask, use_of_funds[], break_even_note, key_assumptions[]."},
  {"key":"business_model","label":"Business Model","type":"asset","format":"markdown","prompt":"Produce the business model document: model rationale, pricing, budget breakdown, use-of-funds, break-even analysis with methodology shown."}
]'::jsonb),

-- ─── 2.4 Visual Orientation ──────────────────────────────────
('2.4', 'Visual Orientation', 'concept', 'standard', 'active',
'Produce 2–3 visual-orientation images that demonstrate what this concept looks and feels like. Orientation, not direction. Locks the palette inherited by all downstream artifacts.',
'The user will describe the concept''s visual feel directly — genre, tone, references, setting. Extract what they provide and produce the orientation images from there.',
'Produce 2–3 visual-orientation images for [concept]. Lock a palette derived from the concept and hold it across all images. Specific references; negative-prompt away clichés. These visualize the concept — not final art direction.',
'Consistent palette across all images (locked here, inherited downstream). Specific references. Negative prompts exclude genre clichés. Only node that generates images.',
ARRAY['image_gen_native','web_search','kb_read'],
ARRAY['V57 image-prompt architecture','Palette locking'],
'{"type":"hybrid"}',
'{"wired":[{"key":"concept_data","cardinality":"single","type":"concept_data","required":false}],"direct_context":"Describe the concept''s visual feel: genre, tone, setting, art references, mood"}',
'[
  {"key":"orientation_images","label":"Orientation Images","type":"asset","format":"png","image_gen":true,"prompt":"Generate 2–3 visual-orientation images. Lock a consistent palette across all. Specific references; negative-prompt genre clichés."},
  {"key":"image_prompts","label":"Image Prompts","type":"asset","format":"markdown","prompt":"Produce the saved image prompts used, including the locked palette definition, for reproducibility."}
]'::jsonb),

-- ─── 2.5 Concept Presentation ────────────────────────────────
('2.5', 'Concept Presentation', 'concept', 'standard', 'active',
'Produce the investor-ready presentation covering the developed concept(s) in the V57 cinematic template, including a business-model slide.',
'The user will describe the concept(s) directly or attach documents. Extract what they provide and produce the investor deck from there.',
'Produce the investor deck for [concepts] using the V57 cinematic template. One section per concept if multiple. Pull images from Visual Orientation; skin it in the locked palette. Include a business-model slide from financial_case. Elevator lines verbatim.',
'Max ~10 slides per concept + one business-model slide. Images only from Visual Orientation. Elevator lines verbatim. No hedging. Look derived from locked palette.',
ARRAY['doc_gen_pptx','image_read','kb_read'],
ARRAY['V57 cinematic deck template','Investment-committee presentation structure'],
'{"type":"llm"}',
'{"wired":[{"key":"concept_data","cardinality":"one_or_more","type":"concept_data","required":false,"note":"one_or_more → fan-in in Phase 2"},{"key":"elevator_line","cardinality":"one_or_more","type":"text","required":false},{"key":"orientation_images","cardinality":"one_or_more","type":"image_set","required":false},{"key":"financial_case","cardinality":"one_or_more","type":"financial_case","required":false}],"direct_context":"Describe the concept(s), paste documents, or attach any relevant materials for the deck"}',
'[
  {"key":"investor_deck","label":"Investor Deck","type":"asset","format":"pptx","prompt":"Produce the investor deck using V57 cinematic template. Structure: Cover, Elevator, Setting, Fantasy+Loop, Mechanics, World, Differentiators+Why Now, Business Model, Production Fit, Closing. Images from Visual Orientation; palette from locked palette."}
]'::jsonb),

-- ─── 2.6 Strategic Review ────────────────────────────────────
('2.6', 'Strategic Review', 'concept', 'standard', 'active',
'Independent, skeptical review of the full concept package before the lock: surface real strengths and risks, run the cross-document coherence audit.',
'The user will provide the package to review directly — paste the deck content, concept documents, or describe what exists. Act as an honest skeptic and review what they give you.',
'Review the full package as an honest skeptic. Output: verdict (READY/CONDITIONS/NOT_READY), top strengths, top risks each with a mitigation, and a coherence check across all artifacts. Flag any incompleteness.',
'Honest critique, not validation. Top strengths and risks each with a mitigation. Coherence audit across all artifacts. Flag incomplete packages. Verdict ∈ READY / CONDITIONS / NOT_READY.',
ARRAY['kb_read'],
ARRAY['Strategic content analyst review'],
'{"type":"llm"}',
'{"wired":[{"key":"investor_deck","cardinality":"single","type":"deck","required":false},{"key":"concept_data","cardinality":"one_or_more","type":"concept_data","required":false},{"key":"financial_case","cardinality":"one_or_more","type":"financial_case","required":false}],"direct_context":"Paste the deck content, concept documents, or describe the package to review"}',
'[
  {"key":"review_verdict","label":"Review Verdict","type":"connection","format":"review_verdict","prompt":"Emit the review verdict as structured data: verdict (READY/CONDITIONS/NOT_READY), top_strengths[], top_risks[], coherence_ok."},
  {"key":"strategic_review","label":"Strategic Review","type":"asset","format":"markdown","prompt":"Produce the written strategic review: strengths with evidence, risks each with a mitigation, coherence audit across all artifacts, and final verdict with reasoning."}
]'::jsonb),

-- ─── 2.7 Concept Lock (Concept Gate) ─────────────────────────
('2.7', 'Concept Lock', 'concept', 'gate', 'active',
'The gate: apply the full rubric over the package and the review verdict, then decide — accept, refine specific nodes/lanes, branch, or kill. On ACCEPT, freeze the locked concept package.',
'The user will provide the package to evaluate directly — paste content, attach documents, or describe what exists. Apply the full rubric and decide.',
'Apply the full rubric over the package and the review verdict. Decide: accept, refine (name nodes/lanes), branch, or kill. Don''t lock an incomplete package. On accept, freeze the locked concept package.',
'Rubrics are guidance, never checkboxes (pitch clarity · visual coherence · scope realism · audience fit · financial case). Don''t lock an incomplete package. Decisions reversible. On ACCEPT, freeze the bundle.',
ARRAY['kb_read','artifact_manage'],
ARRAY['Concept review facilitation','Investment rubric application'],
'{"type":"llm"}',
'{"wired":[{"key":"investor_deck","cardinality":"single","type":"deck","required":false},{"key":"review_verdict","cardinality":"single","type":"review_verdict","required":false},{"key":"financial_case","cardinality":"one_or_more","type":"financial_case","required":false}],"direct_context":"Paste the full package or describe what you have — deck, review, financials, concept docs"}',
'[
  {"key":"gate_decision","label":"Gate Decision","type":"connection","format":"decision","prompt":"Emit the gate decision as structured data: verdict (ACCEPT/REFINE/BRANCH/KILL), refine_nodes[] if applicable."},
  {"key":"locked_concept_package","label":"Locked Concept Package","type":"asset","format":"artifact_bundle","prompt":"If verdict is ACCEPT: produce the locked concept package bundling all approved artifacts. If not ACCEPT: skip this output."}
]'::jsonb);
