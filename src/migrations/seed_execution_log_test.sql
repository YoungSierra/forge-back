-- Seed de prueba para forge_execution_log
-- Proyecto: 61b3869c-a4f2-45cf-b271-be8c76fbfb68
-- Miembro de prueba: 87a11cda-5ef9-4933-a664-70915551d681 (TEST_MEMBER_ID)

do $$
declare
  pid  uuid := '61b3869c-a4f2-45cf-b271-be8c76fbfb68';
  mid  uuid := '87a11cda-5ef9-4933-a664-70915551d681';
begin

-- ── Últimos 7 días — chat LLM (Gemini 2.5 Flash) ────────────────────────────
insert into v57.forge_execution_log
  (project_id, triggered_by, trigger_type, executor_type, provider, model, input_tokens, output_tokens, cached_tokens, cost_usd, is_estimated, duration_ms, started_at, status, metadata)
values
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 4120, 1830, 0,    0.000580, false, 4200,  now() - interval '6 days 14 hours', 'success', '{"node_key":"concept_gen"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 6340, 2210, 1200, 0.000742, false, 5100,  now() - interval '6 days 11 hours', 'success', '{"node_key":"concept_gen"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 8900, 3420, 3100, 0.001122, false, 6800,  now() - interval '5 days 22 hours', 'success', '{"node_key":"art_direction"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 5200, 1980, 0,    0.000651, false, 4900,  now() - interval '5 days 18 hours', 'success', '{"node_key":"art_direction"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 12400, 4100, 5200,0.001540, false, 8200,  now() - interval '5 days 10 hours', 'success', '{"node_key":"market_research"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 3800, 1420, 0,    0.000482, false, 3900,  now() - interval '4 days 20 hours', 'success', '{"node_key":"concept_gen"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 9100, 3800, 4200, 0.001228, false, 7100,  now() - interval '4 days 15 hours', 'success', '{"node_key":"market_research"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 7200, 2900, 2800, 0.000988, false, 5800,  now() - interval '4 days 8 hours',  'success', '{"node_key":"pitch_deck"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 15300, 5200, 0,   0.001759, false, 11200, now() - interval '3 days 21 hours', 'success', '{"node_key":"pitch_deck"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 4400, 1680, 1400, 0.000554, false, 4100,  now() - interval '3 days 16 hours', 'success', '{"node_key":"concept_gen"}'),

-- ── Chat LLM (OpenAI GPT-4o) ─────────────────────────────────────────────────
  (pid, mid, 'chat', 'llm', 'openai', 'gpt-4o', 5100, 2200, 0,    0.034750, false, 6400,  now() - interval '5 days 5 hours',  'success', '{"node_key":"investor_deck"}'),
  (pid, mid, 'chat', 'llm', 'openai', 'gpt-4o', 8300, 3100, 2400, 0.051750, false, 9100,  now() - interval '4 days 2 hours',  'success', '{"node_key":"investor_deck"}'),
  (pid, mid, 'chat', 'llm', 'openai', 'gpt-4o', 6700, 2800, 0,    0.044750, false, 7800,  now() - interval '3 days 9 hours',  'success', '{"node_key":"investor_deck"}'),
  (pid, mid, 'chat', 'llm', 'openai', 'gpt-4o', 4200, 1600, 0,    0.026500, false, 5200,  now() - interval '2 days 14 hours', 'error',   '{"node_key":"investor_deck","error":"context_length"}'),

-- ── Chat LLM (Anthropic Claude) ──────────────────────────────────────────────
  (pid, mid, 'chat', 'llm', 'anthropic', 'claude-sonnet-4-6', 6800, 2400, 3200, 0.056400, false, 8900,  now() - interval '3 days 4 hours',  'success', '{"node_key":"creative_brief"}'),
  (pid, mid, 'chat', 'llm', 'anthropic', 'claude-sonnet-4-6', 9200, 3600, 4800, 0.081600, false, 11400, now() - interval '2 days 18 hours', 'success', '{"node_key":"creative_brief"}'),

-- ── Chat LLM (Groq — rápido y barato) ───────────────────────────────────────
  (pid, mid, 'chat', 'llm', 'groq', 'llama-3.3-70b-versatile', 3200, 1400, 0, 0.002998, false, 980,  now() - interval '2 days 10 hours', 'success', '{"node_key":"quick_summary"}'),
  (pid, mid, 'chat', 'llm', 'groq', 'llama-3.3-70b-versatile', 4800, 2100, 0, 0.004481, false, 1240, now() - interval '1 day 22 hours',  'success', '{"node_key":"quick_summary"}'),
  (pid, mid, 'chat', 'llm', 'groq', 'llama-3.3-70b-versatile', 2900, 980,  0, 0.002489, false, 820,  now() - interval '1 day 14 hours',  'success', '{"node_key":"quick_summary"}'),

-- ── Generación de imágenes (ComfyUI) ─────────────────────────────────────────
  (pid, mid, 'image_gen',  'comfyui', 'comfyui', 'concept_ref',  0, 0, 0, 0.040000, true, 18400, now() - interval '5 days 12 hours', 'success', '{"node_key":"art_direction","output_key":"characters","item_index":0,"width":1024,"height":1024}'),
  (pid, mid, 'image_gen',  'comfyui', 'comfyui', 'concept_ref',  0, 0, 0, 0.040000, true, 21200, now() - interval '5 days 11 hours', 'success', '{"node_key":"art_direction","output_key":"characters","item_index":1,"width":1024,"height":1024}'),
  (pid, mid, 'variation',  'comfyui', 'comfyui', 'concept_ref',  0, 0, 0, 0.040000, true, 19800, now() - interval '4 days 23 hours', 'success', '{"node_key":"art_direction","output_key":"characters","item_index":0,"width":1024,"height":1024}'),
  (pid, mid, 'image_gen',  'comfyui', 'comfyui', 'environment',  0, 0, 0, 0.040000, true, 23600, now() - interval '4 days 6 hours',  'success', '{"node_key":"art_direction","output_key":"environments","item_index":0,"width":1024,"height":1024}'),
  (pid, mid, 'variation',  'comfyui', 'comfyui', 'environment',  0, 0, 0, 0.040000, true, 20100, now() - interval '3 days 19 hours', 'success', '{"node_key":"art_direction","output_key":"environments","item_index":0,"width":1024,"height":1024}'),
  (pid, mid, 'image_gen',  'comfyui', 'comfyui', 'concept_ref',  0, 0, 0, 0.040000, true, 17900, now() - interval '2 days 8 hours',  'success', '{"node_key":"art_direction","output_key":"characters","item_index":2,"width":1024,"height":1024}'),
  (pid, mid, 'variation',  'comfyui', 'comfyui', 'concept_ref',  0, 0, 0, 0.040000, true, 24300, now() - interval '1 day 20 hours',  'error',   '{"node_key":"art_direction","error":"COMFYUI_CREDITS"}'),

-- ── Generación de imágenes (OpenAI DALL-E) ───────────────────────────────────
  (pid, mid, 'image_gen', 'openai_image', 'openai', 'dall-e-3', 0, 0, 0, 0.040000, true, 8200,  now() - interval '3 days 1 hour',   'success', '{"node_key":"mood_board","output_key":"references","item_index":0,"width":1024,"height":1024}'),
  (pid, mid, 'image_gen', 'openai_image', 'openai', 'dall-e-3', 0, 0, 0, 0.040000, true, 7900,  now() - interval '2 days 22 hours', 'success', '{"node_key":"mood_board","output_key":"references","item_index":1,"width":1024,"height":1024}'),
  (pid, mid, 'variation', 'openai_image', 'openai', 'dall-e-3', 0, 0, 0, 0.040000, true, 8600,  now() - interval '1 day 16 hours',  'success', '{"node_key":"mood_board","output_key":"references","item_index":0,"width":1024,"height":1024}'),

-- ── Hoy ──────────────────────────────────────────────────────────────────────
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 5800, 2300, 2100, 0.000822, false, 5400, now() - interval '4 hours', 'success', '{"node_key":"pitch_deck"}'),
  (pid, mid, 'chat', 'llm', 'gemini', 'gemini-2.5-flash', 7100, 3100, 3400, 0.001073, false, 6200, now() - interval '2 hours', 'success', '{"node_key":"pitch_deck"}'),
  (pid, mid, 'image_gen', 'comfyui', 'comfyui', 'concept_ref', 0, 0, 0, 0.040000, true, 20400, now() - interval '1 hour', 'success', '{"node_key":"art_direction","output_key":"characters","item_index":3,"width":1024,"height":1024}');

end $$;
