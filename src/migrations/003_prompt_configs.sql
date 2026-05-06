-- prompt_configs: maps node keys to R2 object paths for system prompts.
-- Admin uploads .md files to R2 via Cloudflare Dashboard and configures the path here.
-- Backend reads from R2 at startup (cached in memory). Falls back to .js files if no r2_path set.

create table if not exists prompt_configs (
  key         text primary key,
  r2_path     text,
  description text,
  updated_at  timestamptz not null default now()
);

-- Seed all known prompt keys with empty r2_path (fallback mode by default)
insert into prompt_configs (key, description) values
  ('gdd',                  'Game Design Document — full GDD generation from concept prompt'),
  ('levels',               'Level design expander — enriches GDD levels with detailed layout data'),
  ('audio',                'Audio design plan — music, SFX direction and adaptive audio spec'),
  ('visual_guide',         'Visual style guide — palette, sprite rules, background rules, UI rules'),
  ('art_direction_intake', 'Art direction intake — distills GDD into actionable visual pillars'),
  ('backgrounds',          'Background prompt generator — generates detailed image prompts per level'),
  ('sfx',                  'SFX pack — categorized sound effects spec with implementation notes'),
  ('concept_art',          'Concept art prompts — character and environment concept image prompts'),
  ('uiux',                 'UI/UX design spec — screen flows, HUD elements, design system'),
  ('icons',                'Icons spec — game icon prompts aligned with art direction'),
  ('hud',                  'HUD layout spec — heads-up display design and image prompt'),
  ('splash',               'Splash art spec — hero key art composition and image prompt'),
  ('marketing',            'Marketing assets — social and store asset prompts per platform'),
  ('modeling',             '3D modeling spec — mesh, polygon budget, and LOD guidelines'),
  ('charaters',            '3D characters spec — rig-ready character modeling guidelines'),
  ('vfx',                  'VFX spec — particle systems, shaders, and performance notes'),
  ('texturing',            'Texturing spec — UV, material, and texture atlas guidelines'),
  ('rigging',              'Rigging spec — bone hierarchy, IK chains, and blend shapes'),
  ('lighting',             'Lighting spec — light setup, baking strategy, and mood per level'),
  ('animation',            'Animation spec — state machine, blend trees, and clip list'),
  ('cinematics',           'Cinematics spec — cutscene breakdown and camera choreography'),
  ('voice',                'Voice acting spec — character voice direction and line delivery notes'),
  ('validation',           'Idea validation — coherence and viability scoring for game concepts'),
  ('playtesting',          'Playtesting report — automated QA and balance feedback generation')
on conflict (key) do nothing;
