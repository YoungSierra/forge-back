-- Seed inicial del changelog desde el buffer aprobado (features nuevas).
-- Se insertan como BORRADORES (published=false): se revisan/publican desde /admin/changelog
-- cuando las features realmente shippeen. source='seed' para distinguir de entradas manuales.
-- Idempotente: no duplica si ya existe una entrada con la misma (version, title).

insert into v57.forge_changelog (version, type, title, items, source, published)
select 'v0.12.2026', 'new_feature', 'Run any scope: full pipeline, single lane, or one phase',
  '["Run an entire project end-to-end, a single instanced lane, or just one phase from the new Run menu.","Lane and phase runs stay inside their boundary and never cross a gate.","Full-pipeline runs cross gates automatically only when you authorize auto-accept."]'::jsonb,
  'seed', false
where not exists (select 1 from v57.forge_changelog where version = 'v0.12.2026' and title = 'Run any scope: full pipeline, single lane, or one phase');

insert into v57.forge_changelog (version, type, title, items, source, published)
select 'v0.12.2026', 'improvement', 'Smarter Run: only runs what''s missing',
  '["Run now executes only pending outputs per node and never overwrites approved work.","Steps in a sealed (gate-accepted) phase are locked from re-running.","The toolbar counter reflects the real number of pending outputs."]'::jsonb,
  'seed', false
where not exists (select 1 from v57.forge_changelog where version = 'v0.12.2026' and title = 'Smarter Run: only runs what''s missing');

insert into v57.forge_changelog (version, type, title, items, source, published)
select 'v0.13.2026', 'new_feature', 'Automatic image generation in Run All',
  '["Image outputs now generate their PNGs automatically during Run All and scoped runs — no manual click needed.","Generated images are saved to the project and available to downstream steps (e.g. the concept presentation).","The number of images follows each step''s definition; nothing is hardcoded."]'::jsonb,
  'seed', false
where not exists (select 1 from v57.forge_changelog where version = 'v0.13.2026' and title = 'Automatic image generation in Run All');
