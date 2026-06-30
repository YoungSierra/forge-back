-- ============================================================
-- Migration 026 — Actualizar blueprints a nodos v1.3.0
-- Reemplaza node_sequence de ideation_default y concept_default
-- para que apunten a los nuevos UUIDs (node_keys 1.1-1.4 y 2.1-2.7).
-- Los nodos viejos (99.x) quedaron archivados en migration 025.
-- ============================================================

-- ─── 1. Ideation Blueprint → 1.1, 1.2, 1.3, 1.4 (gate = 1.4) ──

UPDATE v57.forge_blueprints
SET
  node_sequence = (
    SELECT jsonb_build_array(
      jsonb_build_object('node_id', n11.id, 'order_index', 1),
      jsonb_build_object('node_id', n12.id, 'order_index', 2),
      jsonb_build_object('node_id', n13.id, 'order_index', 3),
      jsonb_build_object('node_id', n14.id, 'order_index', 4)
    )
    FROM
      (SELECT id FROM v57.forge_nodes WHERE node_key = '1.1' AND status = 'active') n11,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '1.2' AND status = 'active') n12,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '1.3' AND status = 'active') n13,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '1.4' AND status = 'active') n14
  ),
  edges = (
    SELECT jsonb_build_array(
      jsonb_build_object('from_node_id', n11.id, 'to_node_id', n12.id),
      jsonb_build_object('from_node_id', n12.id, 'to_node_id', n13.id),
      jsonb_build_object('from_node_id', n13.id, 'to_node_id', n14.id)
    )
    FROM
      (SELECT id FROM v57.forge_nodes WHERE node_key = '1.1' AND status = 'active') n11,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '1.2' AND status = 'active') n12,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '1.3' AND status = 'active') n13,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '1.4' AND status = 'active') n14
  ),
  gate = '{"name":"Concept Selection Gate","mode":"conversational","suggested_rubrics":["clear hook","defined audience","market gap identified","team passion","concept commercially viable"],"outcomes":["accept","refine","kill"]}'::jsonb,
  updated_at = now()
WHERE blueprint_key = 'ideation_default';

-- ─── 2. Concept Blueprint → 2.1-2.7 (gate = 2.7) ──────────────

UPDATE v57.forge_blueprints
SET
  node_sequence = (
    SELECT jsonb_build_array(
      jsonb_build_object('node_id', n21.id, 'order_index', 1),
      jsonb_build_object('node_id', n22.id, 'order_index', 2),
      jsonb_build_object('node_id', n23.id, 'order_index', 3),
      jsonb_build_object('node_id', n24.id, 'order_index', 4),
      jsonb_build_object('node_id', n25.id, 'order_index', 5),
      jsonb_build_object('node_id', n26.id, 'order_index', 6),
      jsonb_build_object('node_id', n27.id, 'order_index', 7)
    )
    FROM
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.1' AND status = 'active') n21,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.2' AND status = 'active') n22,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.3' AND status = 'active') n23,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.4' AND status = 'active') n24,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.5' AND status = 'active') n25,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.6' AND status = 'active') n26,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.7' AND status = 'active') n27
  ),
  edges = (
    SELECT jsonb_build_array(
      jsonb_build_object('from_node_id', n21.id, 'to_node_id', n22.id),
      jsonb_build_object('from_node_id', n22.id, 'to_node_id', n23.id),
      jsonb_build_object('from_node_id', n23.id, 'to_node_id', n24.id),
      jsonb_build_object('from_node_id', n24.id, 'to_node_id', n25.id),
      jsonb_build_object('from_node_id', n25.id, 'to_node_id', n26.id),
      jsonb_build_object('from_node_id', n26.id, 'to_node_id', n27.id)
    )
    FROM
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.1' AND status = 'active') n21,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.2' AND status = 'active') n22,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.3' AND status = 'active') n23,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.4' AND status = 'active') n24,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.5' AND status = 'active') n25,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.6' AND status = 'active') n26,
      (SELECT id FROM v57.forge_nodes WHERE node_key = '2.7' AND status = 'active') n27
  ),
  gate = '{"name":"Concept Lock Gate","mode":"conversational","suggested_rubrics":["pitch clarity","art direction coherence","scope realism","audience fit","financial viability"],"outcomes":["accept","refine","kill"]}'::jsonb,
  updated_at = now()
WHERE blueprint_key = 'concept_default';
