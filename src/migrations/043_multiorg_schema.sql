-- ============================================================
-- Migration 043 — Multi-Organización · Frente 1: estructura de organizaciones
--
-- Agrega la capa de organización (tenant) al modelo. TODO ADITIVO Y NO-DESTRUCTIVO:
-- tablas nuevas + columnas nullable + índices. No borra ni modifica datos existentes.
--
-- El backfill a "V57 Studio" y el sellado a NOT NULL van APARTE (scripts/backfill-org.js
-- + una migración posterior), para poder revisar antes de cerrar.
--
-- Decisiones (plan Multi-Org aprobado 2026-07-22): Modelo A, 2 niveles org->proyecto.
--   · Roles por org: owner/admin/member/viewer.
--   · Créditos prepago: saldo vive en organizations.credit_balance.
--   · Blueprints: org_id NULL = estándar de V57 (global, visible para todas);
--     org_id con valor = privado de esa organización.
--
-- Idempotente (if not exists en todo). Runnable también sobre una BD limpia (prod nuevo).
-- ============================================================

-- ── Organizaciones (el tenant) ──────────────────────────────
create table if not exists v57.organizations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,
  status         text not null default 'active',   -- 'active' | 'suspended'
  credit_balance numeric(14,4) not null default 0,  -- saldo de créditos prepago (Frente 4)
  created_by     uuid references v57.members(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Membresía persona↔organización, con rol POR org ─────────
-- (distinto de project_members, que es por-proyecto; y de members.role, que es global de plataforma)
create table if not exists v57.org_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references v57.organizations(id) on delete cascade,
  member_id  uuid not null references v57.members(id)       on delete cascade,
  org_role   text not null default 'member'
             check (org_role in ('owner','admin','member','viewer')),
  joined_at  timestamptz not null default now(),
  unique (org_id, member_id)
);
create index if not exists idx_org_members_org    on v57.org_members(org_id);
create index if not exists idx_org_members_member on v57.org_members(member_id);

-- NOTA — DOS EJES DE ROLES (independientes, no mezclar):
--   · members.role  = ROL DE PLATAFORMA (global): 'super_admin' (V57, dueños de Forge) | 'user'.
--     Gobierna el poder TRANSVERSAL a todas las orgs: crear organizaciones, designar el primer
--     org-admin, gestionar catálogos/blueprints estándar, vender créditos, ver todo.
--     NO deriva de pertenecer a ninguna org (V57 Studio es solo la org por defecto de los datos).
--   · org_members.org_role = ROL DENTRO DE UNA ORG: owner/admin/member/viewer.
--   La migración de valores de members.role ('admin'->'super_admin', 'member'->'user') va en el
--   backfill, y debe aplicarse JUNTO con el cambio requireAdmin -> requirePlatformAdmin (Frente 2)
--   para no dejar el panel admin sin reconocer administradores en el intervalo.

-- ── org_id en las tablas raíz (NULLABLE por ahora; se sella tras el backfill) ──
alter table v57.projects            add column if not exists org_id uuid references v57.organizations(id);
alter table v57.forge_execution_log add column if not exists org_id uuid references v57.organizations(id);
-- Blueprints: NULL = estándar de V57 (global); con valor = privado de la org que lo creó
alter table v57.forge_blueprints    add column if not exists org_id uuid references v57.organizations(id);

create index if not exists idx_projects_org   on v57.projects(org_id);
create index if not exists idx_fel_org        on v57.forge_execution_log(org_id);
create index if not exists idx_blueprints_org on v57.forge_blueprints(org_id);

-- ── PENDIENTE (migración posterior, junto con RLS) ──────────
-- La unicidad global de blueprints (forge_blueprints.blueprint_key UNIQUE) debe pasar a
-- UNIQUE(org_id, blueprint_key) para que una org pueda tener un blueprint con la misma key que
-- un estándar. NO se toca aquí a propósito: es un cambio de constraint que conviene hacer con el
-- backfill ya corrido (todos los blueprints actuales quedan org_id NULL = estándar) para no
-- romper el catálogo. Ver Frente 3 (RLS) donde también se activan las políticas por org_id.
