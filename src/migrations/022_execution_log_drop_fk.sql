-- Quitar FK constraints de node_id, session_id y blueprint_id para evitar
-- fallos silenciosos cuando el ID no existe exactamente en la tabla referenciada.
-- project_id y triggered_by se mantienen para poder hacer joins de nombre.

alter table v57.forge_execution_log
  drop constraint if exists forge_execution_log_node_id_fkey,
  drop constraint if exists forge_execution_log_session_id_fkey,
  drop constraint if exists forge_execution_log_blueprint_id_fkey;
