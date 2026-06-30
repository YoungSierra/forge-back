-- 031_update_selected_seeds_prompt.sql
-- El usuario no debe especificar formato — el LLM lo sabe por su system prompt.
-- Actualiza el campo "prompt" del output "selected_seeds" del nodo 1.4.
-- outputs es un array plano (no objeto con key 'connections').

DO $$
DECLARE
  v_node_id    UUID;
  v_idx        INT;
  v_new_prompt TEXT := 'Emit the curated survivors — the seeds worth developing (often all of them, sometimes a subset, depending on quality). Conclude your response with this section exactly as formatted — it is machine-read to trigger the fan-out into concept lanes:

## selected_seeds
- Seed title: one-liner description

One line per surviving seed. Use each seed''s original title verbatim. No numbering, bold, or extra formatting inside the list items.';
BEGIN
  SELECT id,
    (SELECT (ordinality - 1)::int
     FROM jsonb_array_elements(outputs) WITH ORDINALITY
     WHERE value ->> 'key' = 'selected_seeds'
     LIMIT 1)
  INTO v_node_id, v_idx
  FROM v57.forge_nodes
  WHERE node_key = '1.4'
  LIMIT 1;

  IF v_node_id IS NULL THEN
    RAISE WARNING 'Node 1.4 not found — skipping.';
  ELSIF v_idx IS NULL THEN
    RAISE WARNING 'selected_seeds output not found in node 1.4 — skipping.';
  ELSE
    UPDATE v57.forge_nodes
    SET outputs = jsonb_set(
      outputs,
      ARRAY[v_idx::text, 'prompt'],
      to_jsonb(v_new_prompt)
    )
    WHERE id = v_node_id;

    RAISE NOTICE 'OK — updated selected_seeds prompt on node 1.4 (id: %)', v_node_id;
  END IF;
END $$;
