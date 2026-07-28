-- ============================================================
-- Migration 046 — Multi-Organización · Sub-topes de crédito por PROYECTO y por MIEMBRO
--
-- Modelo (decidido con el usuario 2026-07-28):
--   · El crédito de la org sigue siendo el tope MAESTRO (bloquea a 0). Estos son sub-límites OPCIONALES.
--   · Cada tope tiene su propio PERÍODO: 'monthly' (default, se resetea solo por fecha) o 'total' (acumulado).
--   · Topes multidimensionales: una operación descuenta de org + miembro + proyecto; se bloquea si CUALQUIERA
--     está agotado (el más restrictivo manda). No hay "prevalencia": cada acción cumple todos los topes que le aplican.
--
-- Aditivo, no destructivo, idempotente.
-- ============================================================

-- ── Tope por proyecto ──
alter table v57.projects add column if not exists credit_cap_usd    numeric(14,4);            -- null = sin tope
alter table v57.projects add column if not exists credit_cap_period text not null default 'monthly';
do $$ begin
  alter table v57.projects add constraint projects_credit_cap_period_chk check (credit_cap_period in ('monthly','total'));
exception when duplicate_object then null; end $$;

-- ── Tope por miembro (dentro de la org) ──
alter table v57.org_members add column if not exists credit_cap_usd    numeric(14,4);
alter table v57.org_members add column if not exists credit_cap_period text not null default 'monthly';
do $$ begin
  alter table v57.org_members add constraint org_members_credit_cap_period_chk check (credit_cap_period in ('monthly','total'));
exception when duplicate_object then null; end $$;

-- ── project_id en el libro mayor: permite sumar gasto por proyecto sin join ──
alter table v57.credit_transactions add column if not exists project_id uuid;
create index if not exists idx_credit_tx_project on v57.credit_transactions(project_id, created_at desc) where project_id is not null;
create index if not exists idx_credit_tx_by      on v57.credit_transactions(org_id, created_by, created_at desc);

-- ── Gasto por período (positivo). 'monthly' filtra desde el inicio del mes UTC -> se resetea solo. ──
create or replace function v57.member_spend(p_org uuid, p_member uuid, p_period text)
  returns numeric language sql stable security definer set search_path = v57, public
as $$
  select coalesce(-sum(amount_usd), 0)
  from v57.credit_transactions
  where org_id = p_org and created_by = p_member and type = 'consumption'
    and (p_period = 'total' or created_at >= date_trunc('month', now() at time zone 'utc'));
$$;

create or replace function v57.project_spend(p_project uuid, p_period text)
  returns numeric language sql stable security definer set search_path = v57, public
as $$
  select coalesce(-sum(amount_usd), 0)
  from v57.credit_transactions
  where project_id = p_project and type = 'consumption'
    and (p_period = 'total' or created_at >= date_trunc('month', now() at time zone 'utc'));
$$;

-- ── apply_credit_charge: nueva firma que además guarda project_id (para el gasto por proyecto) ──
-- Se elimina la versión de 4 args para no dejar un overload muerto.
drop function if exists v57.apply_credit_charge(uuid, numeric, uuid, uuid);
create or replace function v57.apply_credit_charge(p_org uuid, p_raw numeric, p_exec uuid, p_by uuid, p_project uuid)
  returns numeric
  language plpgsql
  security definer
  set search_path = v57, public
as $$
declare v_margin numeric; v_charge numeric; v_new numeric;
begin
  select margin_multiplier, credit_balance into v_margin, v_new
    from v57.organizations where id = p_org for update;   -- lock de fila -> sin carreras
  if not found then return null; end if;
  v_charge := coalesce(p_raw, 0) * coalesce(v_margin, 1.5);
  v_new := v_new - v_charge;
  update v57.organizations set credit_balance = v_new, updated_at = now() where id = p_org;
  insert into v57.credit_transactions (org_id, type, amount_usd, balance_after, raw_cost_usd, margin_multiplier, execution_log_id, created_by, project_id)
    values (p_org, 'consumption', -v_charge, v_new, p_raw, v_margin, p_exec, p_by, p_project);
  return v_new;
end;
$$;
