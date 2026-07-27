-- ============================================================
-- Migration 044 — Multi-Organización · Frente 3: RLS (Row-Level Security)
--
-- Activa el aislamiento por organización A NIVEL DE BASE DE DATOS (segunda cerradura / defensa en
-- profundidad). Aunque el código de la app tenga un bug, Postgres bloquea el cruce entre orgs.
--
-- IMPORTANTE — POR QUÉ ES SEGURA DE APLICAR YA:
--   El backend hoy se conecta con la llave service-role, que tiene BYPASSRLS -> IGNORA estas
--   políticas. O sea: aplicar esta migración NO cambia nada para la app actual. Las políticas solo
--   se harán valer cuando enrutemos lecturas por un cliente con el JWT del usuario (Frente 3, etapa 2).
--
-- Alcance de esta etapa: projects, forge_execution_log y forge_blueprints. Las tablas hijas
-- (assets, forge_sessions, forge_project_nodes, etc.) se cubren en la etapa 2 (política vía join al
-- proyecto). Idempotente.
-- ============================================================

-- ── Helpers (SECURITY DEFINER: leen membership sin quedar atrapadas por RLS, evitan recursión) ──
create or replace function v57.current_member_org_ids()
  returns setof uuid
  language sql stable security definer
  set search_path = v57, public
as $$
  select om.org_id
  from v57.org_members om
  join v57.members m on m.id = om.member_id
  where m.auth_user_id = auth.uid()
$$;

create or replace function v57.is_platform_admin()
  returns boolean
  language sql stable security definer
  set search_path = v57, public
as $$
  select exists (
    select 1 from v57.members m
    where m.auth_user_id = auth.uid()
      and m.role in ('super_admin', 'admin')  -- 'admin' tolerado durante la transición
  )
$$;

-- ── projects: solo los de una org a la que pertenece el usuario (o super-admin ve todo) ──
alter table v57.projects enable row level security;
drop policy if exists projects_org_read on v57.projects;
create policy projects_org_read on v57.projects
  for select
  using ( v57.is_platform_admin() or org_id in (select v57.current_member_org_ids()) );

-- ── forge_execution_log: mismo criterio (costos por org) ──
alter table v57.forge_execution_log enable row level security;
drop policy if exists fel_org_read on v57.forge_execution_log;
create policy fel_org_read on v57.forge_execution_log
  for select
  using ( v57.is_platform_admin() or org_id in (select v57.current_member_org_ids()) );

-- ── forge_blueprints: los estándar (org_id NULL) los ve todo el mundo; los propios, solo su org ──
alter table v57.forge_blueprints enable row level security;
drop policy if exists blueprints_read on v57.forge_blueprints;
create policy blueprints_read on v57.forge_blueprints
  for select
  using ( org_id is null or v57.is_platform_admin() or org_id in (select v57.current_member_org_ids()) );

-- NOTA: el service-role (backend actual) IGNORA todo esto por BYPASSRLS. Se activa de verdad al usar
-- el cliente con JWT del usuario (etapa 2). Escrituras siguen por service-role (app-layer) por ahora.
