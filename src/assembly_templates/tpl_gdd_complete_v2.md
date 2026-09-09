<!-- tpl_gdd_complete_v2 — Forge GDD assembly template.
     Content and structure: gdd_template_population.md v2.4.0 (canonical Template Body), verbatim.
     Every {{slot:ID}} is declared in tpl_gdd_complete_v2.manifest.json with its kind (transcribe | glue | pointer), source and rules.
     The assembler fills transcribe/pointer slots without a model; glue slots are the ONLY model-authored text. -->

# {{slot:s1.title}} — Game Design Document
*V57 Studio · Forge GDD Template v2.4.0 · assembled by node 3.8*

{{slot:s0.executive_summary}}

> **THE REAL NUMBERS RULE.** Every quantity, duration, cost, damage value, drop rate, cooldown or progression rate carries a number and a unit. **BANNED WORDS at gate:** fun · epic · amazing · revolutionary · unique (as a claim) · AAA-quality (without a spec) · AI-driven (without the system) · innovative (without the innovation) · TBD · TBC · TK · ???

## 1 Game Identity
**Title:** {{slot:s1.title}}

**Elevator line:** *"{{slot:s1.elevator_line}}"*

**One-liner:** {{slot:s1.one_liner}}

{{slot:s1.fact_sheet}}
*Source: 2.7 · concept_data (via 3.1 pass-through)*

## 2 Design Pillars
{{slot:s2.pillars}}
{{slot:s2.anti_pillars}}
{{slot:s2.feel_statement}}
*Source: 3.1 · design_pillars · feel_statement*

## 3 Core Gameplay
{{slot:s3.core_loop}}
{{slot:s3.signature_mechanics}}
{{slot:s3.difficulty_curve}}
*Source: 3.2 · core_loop · mechanic_specs*

## 4 Game Systems
{{slot:s4.progression}}
{{slot:s4.economy}}
{{slot:s4.player_stats}}
{{slot:s4.item_catalog}}
*Source: 3.3 · progression_sys · economy_design · player_stats · item_catalog*

## 5 World & Narrative
{{slot:s5.world_premise}}
{{slot:s5.environments}}
{{slot:s5.factions}}
{{slot:s5.narrative_arc}}
{{slot:s5.dialogue_system}}
*Source: 3.4 · world_lore · environments_x4 · faction_map · narrative_arc · dialogue_system*

## 6 Level Design
{{slot:s6.level_structure}}
{{slot:s6.encounters}}
{{slot:s6.pacing}}
*Source: 3.5 · level_map · encounter_design*

## 7 Characters
{{slot:s7.player_characters}}
{{slot:s7.principal_cast}}
{{slot:s7.abilities}}
{{slot:s7.character_faction_map}}
*Source: 3.6 · char_profiles · char_abilities*

## 8 UX / UI
{{slot:s8.hud}}
{{slot:s8.menu_architecture}}
{{slot:s8.controls}}
{{slot:s8.feedback}}
{{slot:s8.onboarding}}
{{slot:s8.accessibility}}
*Source: 3.7 · hud_layout · menu_tree · control_map · feedback_system*

## 9 Audio Brief *(forward brief — consumed by the Audio Direction Document)*
{{slot:s9.audio_brief}}
*Source: authored at 3.8 from §1–§8*

## 10 Technical Systems Brief *(forward brief — consumed by the Technical Design Document)*
{{slot:s10.technical_brief}}
*Source: authored at 3.8 from §1–§8*

## 11 MVP / Prototype Scope *(forward brief — consumed by the Prototype Specification)*
{{slot:s11.mvp_scope}}
*Source: authored at 3.8 from §2, §3, §6*

## 12 Product Scope seed *(refined by Product Scope)*
{{slot:s12.product_scope_seed}}
*Source: authored at 3.8 from §1, §3–§8*

## 13 Monetization reference
{{slot:s13.monetization}}
*Source: 2.3 · financial_case — or `[PROJECTED — set at 3.11]` when not wired*

## 14 External Document References
{{slot:s14.downstream_documents}}
{{slot:s14.reference_stack}}
*Source: assembled at 3.8*

## Appendix — Section → Source Map
{{slot:appendix.section_map}}
