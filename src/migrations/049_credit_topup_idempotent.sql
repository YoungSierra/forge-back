-- ============================================================
-- Migration 049 — Idempotencia en la recarga de créditos (webhook de pagos)
--
-- Stripe (y toda pasarela) entrega los webhooks "AL MENOS UNA VEZ": el mismo checkout.session.completed
-- puede llegar más de una vez (reintentos, o varios receptores sobre la misma BD). Sin protección, cada
-- entrega acreditaba de nuevo -> doble crédito. Ahora apply_credit_topup NO vuelve a sumar si ya existe
-- una compra con ese external_ref (id del pago). El chequeo va dentro del lock FOR UPDATE del org -> es
-- a prueba de concurrencia (dos entregas casi simultáneas se serializan; la segunda ve la primera y no suma).
--
-- Idempotente. Recargas manuales/CLI sin external_ref (p_ref null) siguen sumando normalmente.
-- ============================================================

create or replace function v57.apply_credit_topup(p_org uuid, p_amount numeric, p_provider text, p_ref text, p_by uuid)
  returns numeric
  language plpgsql
  security definer
  set search_path = v57, public
as $$
declare v_new numeric;
begin
  select credit_balance into v_new from v57.organizations where id = p_org for update;  -- lock de fila
  if not found then return null; end if;

  -- Idempotencia por pago: si ya se acreditó este external_ref, devolver el saldo sin volver a sumar
  if p_ref is not null and exists (
    select 1 from v57.credit_transactions
    where org_id = p_org and type = 'purchase' and external_ref = p_ref
  ) then
    return v_new;
  end if;

  v_new := v_new + coalesce(p_amount, 0);
  update v57.organizations set credit_balance = v_new, last_topup_usd = p_amount, updated_at = now() where id = p_org;
  insert into v57.credit_transactions (org_id, type, amount_usd, balance_after, payment_provider, external_ref, created_by)
    values (p_org, 'purchase', p_amount, v_new, p_provider, p_ref, p_by);
  return v_new;
end;
$$;
