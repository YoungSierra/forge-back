-- Permite múltiples edges entre el mismo par de nodos (distintos handles/slots)
-- El constraint anterior bloqueaba conectar más de un output de A → B
ALTER TABLE v57.forge_project_edges
  DROP CONSTRAINT IF EXISTS forge_project_edges_project_id_source_node_id_target_node_i_key;
