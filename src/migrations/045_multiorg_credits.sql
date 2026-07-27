-- ============================================================
-- Migration 045 — Multi-Organización · Frente 4: Créditos y control de consumo
--
-- Modelo (decidido con el usuario):
--   · El saldo (organizations.credit_balance, ya existe desde la 043) está en USD-EQUIVALENTE.
--   · Cada operación descuenta = costo_real_del_proveedor * margin_multiplier (por org, configurable).
--   · Se bloquea la ejecución al llegar a 0; alertas al 10% de la última recarga.
--   · Libro mayor (credit_transactions) agnóstico de pasarela: payment_provider + external_ref.
--
-- Aditivo y no-destructivo. Idempotente. El descuento/recarga se hacen por FUNCIONES atómicas
-- (SELECT ... FOR UPDATE) para que sean a prueba de concurrencia (no cobrar de más ni de menos).
-- ============================================================

-- ── Campos de billing / margen en organizations ──
alter table v57.organizations add column if not exists margin_multiplier   numeric(6,3) not null default 1.5;  -- markup (1.5 = +50%); ajustable por org
alter table v57.organizations add column if not exists billing_customer_id text;    -- id del cliente en la pasarela
alter table v57.organizations add column if not exists payment_provider    text;    -- 'stripe' | 'mercadopago' | ...
alter table v57.organizations add column if not exists billing_email       text;
alter table v57.organizations add column if not exists last_topup_usd      numeric(14,4);  -- última recarga (base para el 10%)

-- ── Libro mayor de créditos: una fila por compra y por consumo ──
create table if not exists v57.credit_transactions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references v57.organizations(id) on delete cascade,
  type              text not null check (type in ('purchase','consumption','adjustment','refund')),
  amount_usd        numeric(14,4) not null,   -- delta con signo: + compra, - consumo
  balance_after     numeric(14,4),            -- saldo tras el movimiento (snapshot)
  -- consumo:
  raw_cost_usd      numeric(14,8),            -- costo real del proveedor (antes de margen)
  margin_multiplier numeric(6,3),             -- margen aplicado
  execution_log_id  uuid,                     -- ref a forge_execution_log (soft, sin FK a propósito)
  -- compra (agnóstico de pasarela):
  payment_provider  text,
  external_ref      text,                     -- id de pago/factura de la pasarela
  -- común:
  created_by        uuid references v57.members(id) on delete set null,
  metadata          jsonb not null default '{}',
  created_at        timestamptz not null default now()
);
create index if not exists idx_credit_tx_org on v57.credit_transactions(org_id, created_at desc);

-- RLS (consistente con Frente 3): la org solo ve sus propios movimientos (service-role los ve todos)
alter table v57.credit_transactions enable row level security;
drop policy if exists credit_tx_org_read on v57.credit_transactions;
create policy credit_tx_org_read on v57.credit_transactions
  for select
  using ( v57.is_platform_admin() or org_id in (select v57.current_member_org_ids()) );

-- ── Descuento ATÓMICO por operación (aplica margen, actualiza saldo, registra en el libro) ──
create or replace function v57.apply_credit_charge(p_org uuid, p_raw numeric, p_exec uuid, p_by uuid)
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
  insert into v57.credit_transactions (org_id, type, amount_usd, balance_after, raw_cost_usd, margin_multiplier, execution_log_id, created_by)
    values (p_org, 'consumption', -v_charge, v_new, p_raw, v_margin, p_exec, p_by);
  return v_new;
end;
$$;

-- ── Recarga ATÓMICA (compra de créditos) ──
create or replace function v57.apply_credit_topup(p_org uuid, p_amount numeric, p_provider text, p_ref text, p_by uuid)
  returns numeric
  language plpgsql
  security definer
  set search_path = v57, public
as $$
declare v_new numeric;
begin
  select credit_balance into v_new from v57.organizations where id = p_org for update;
  if not found then return null; end if;
  v_new := v_new + coalesce(p_amount, 0);
  update v57.organizations set credit_balance = v_new, last_topup_usd = p_amount, updated_at = now() where id = p_org;
  insert into v57.credit_transactions (org_id, type, amount_usd, balance_after, payment_provider, external_ref, created_by)
    values (p_org, 'purchase', p_amount, v_new, p_provider, p_ref, p_by);
  return v_new;
end;
$$;
