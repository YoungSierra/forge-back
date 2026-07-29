-- ============================================================
-- Migration 047 — Multi-Organización · Frente 3 (etapa 2): RLS en TABLAS HIJAS
--
-- Extiende el aislamiento por org a las hijas del proyecto (nodos, edges, sesiones, mensajes, assets,
-- blueprints cargados). Una fila es visible si su proyecto pertenece a una org del usuario (o super-admin).
--
-- SEGURA DE APLICAR YA (igual que la 044): el backend usa service-role (BYPASSRLS) -> IGNORA estas
-- políticas, así que la app actual no cambia. Solo se hacen valer cuando una lectura corre con el JWT
-- del usuario (dbAsUser). Escrituras siguen por service-role (app-layer): con RLS activa y sin política
-- de insert/update/delete, un cliente JWT no puede escribir -> mismo comportamiento que hoy.
--
-- Idempotente. Depende de los helpers de la 044 (current_member_org_ids, is_platform_admin).
-- ============================================================

-- Helper: proyectos que el usuario puede ver (super-admin ve todos). No recursivo: projects RLS se
-- resuelve vía current_member_org_ids (otra función), nunca vía ésta.
create or replace function v57.current_member_project_ids()
  returns setof uuid
  language sql stable security definer
  set search_path = v57, public
as $$
  select p.id
  from v57.projects p
  where v57.is_platform_admin()
     or p.org_id in (select v57.current_member_org_ids())
$$;

-- ── Hijas con project_id directo ──
alter table v57.forge_project_nodes enable row level security;
drop policy if exists fpn_org_read on v57.forge_project_nodes;
create policy fpn_org_read on v57.forge_project_nodes
  for select using ( project_id in (select v57.current_member_project_ids()) );

alter table v57.forge_project_edges enable row level security;
drop policy if exists fpe_org_read on v57.forge_project_edges;
create policy fpe_org_read on v57.forge_project_edges
  for select using ( project_id in (select v57.current_member_project_ids()) );

alter table v57.forge_sessions enable row level security;
drop policy if exists fses_org_read on v57.forge_sessions;
create policy fses_org_read on v57.forge_sessions
  for select using ( project_id in (select v57.current_member_project_ids()) );

alter table v57.forge_assets enable row level security;
drop policy if exists fast_org_read on v57.forge_assets;
create policy fast_org_read on v57.forge_assets
  for select using ( project_id in (select v57.current_member_project_ids()) );

alter table v57.forge_project_blueprints enable row level security;
drop policy if exists fpb_org_read on v57.forge_project_blueprints;
create policy fpb_org_read on v57.forge_project_blueprints
  for select using ( project_id in (select v57.current_member_project_ids()) );

alter table v57.forge_lanes enable row level security;
drop policy if exists flan_org_read on v57.forge_lanes;
create policy flan_org_read on v57.forge_lanes
  for select using ( project_id in (select v57.current_member_project_ids()) );

alter table v57.forge_project_library_assets enable row level security;
drop policy if exists fpla_org_read on v57.forge_project_library_assets;
create policy fpla_org_read on v57.forge_project_library_assets
  for select using ( project_id in (select v57.current_member_project_ids()) );

alter table v57.forge_project_node_inputs enable row level security;
drop policy if exists fpni_org_read on v57.forge_project_node_inputs;
create policy fpni_org_read on v57.forge_project_node_inputs
  for select using ( project_id in (select v57.current_member_project_ids()) );

-- ── Hijas sin project_id -> se scopean por su sesión ──
alter table v57.forge_messages enable row level security;
drop policy if exists fmsg_org_read on v57.forge_messages;
create policy fmsg_org_read on v57.forge_messages
  for select using (
    session_id in (
      select s.id from v57.forge_sessions s
      where s.project_id in (select v57.current_member_project_ids())
    )
  );

alter table v57.forge_attachments enable row level security;
drop policy if exists fatt_org_read on v57.forge_attachments;
create policy fatt_org_read on v57.forge_attachments
  for select using (
    session_id in (
      select s.id from v57.forge_sessions s
      where s.project_id in (select v57.current_member_project_ids())
    )
  );

-- NOTA: service-role (backend actual) IGNORA todo esto por BYPASSRLS. Se activa de verdad al leer con
-- el cliente JWT del usuario (dbAsUser). Escrituras siguen por service-role.
