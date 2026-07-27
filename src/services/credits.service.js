// ─── credits.service · Frente 4 (Multi-Org) ──────────────────────────────────────────────────
// Billetera de créditos por organización (saldo en USD-equivalente). El descuento y la recarga se
// hacen por funciones ATÓMICAS en la BD (apply_credit_charge / apply_credit_topup, migración 045)
// para ser a prueba de concurrencia. El alerting compara contra el 10% de la última recarga.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const { db } = require('./supabase.service')

const LOW_BALANCE_FRACTION = 0.10 // alerta cuando a la org le QUEDA el 10% (o menos) de lo que compró

// Saldo actual (USD-equivalente)
async function getBalance(orgId) {
  const { data } = await db().from('organizations').select('credit_balance').eq('id', orgId).maybeSingle()
  return Number(data?.credit_balance ?? 0)
}

// Gate PRE-ejecución: ¿la org puede correr una operación? Bloquea si el saldo llegó a 0.
async function canRun(orgId) {
  const balance = await getBalance(orgId)
  return { ok: balance > 0, balance }
}

// Cobra una operación: aplica margen (por org), descuenta y registra en el libro mayor.
// rawCostUsd = costo real del proveedor (típicamente forge_execution_log.cost_usd).
// Devuelve { newBalance, alert: 'depleted' | 'low' | null }.
async function chargeForOperation({ orgId, rawCostUsd, executionLogId = null, createdBy = null }) {
  if (!orgId) return null
  const { data, error } = await db().rpc('apply_credit_charge', {
    p_org: orgId, p_raw: Number(rawCostUsd || 0), p_exec: executionLogId, p_by: createdBy,
  })
  if (error) throw error
  const newBalance = Number(data)
  return { newBalance, alert: computeAlert(await lastTopup(orgId), newBalance) }
}

// Recarga de créditos (compra). Agnóstico de pasarela: paymentProvider + externalRef.
async function addCredits({ orgId, amountUsd, paymentProvider = null, externalRef = null, createdBy = null }) {
  if (!orgId) return null
  const { data, error } = await db().rpc('apply_credit_topup', {
    p_org: orgId, p_amount: Number(amountUsd), p_provider: paymentProvider, p_ref: externalRef, p_by: createdBy,
  })
  if (error) throw error
  return { newBalance: Number(data) }
}

// ── helpers ──
async function lastTopup(orgId) {
  const { data } = await db().from('organizations').select('last_topup_usd').eq('id', orgId).maybeSingle()
  return Number(data?.last_topup_usd ?? 0)
}
function computeAlert(lastTopupUsd, balance) {
  if (balance <= 0) return 'depleted'
  const threshold = lastTopupUsd > 0 ? lastTopupUsd * LOW_BALANCE_FRACTION : 0
  if (threshold && balance <= threshold) return 'low'  // le queda el 10% (o menos) de lo que compró
  return null
}

// Estado de crédito para mostrar a la org (saldo + alerta). NO expone costo real ni margen.
async function getStatus(orgId) {
  const { data } = await db().from('organizations').select('credit_balance, last_topup_usd').eq('id', orgId).maybeSingle()
  const balance = Number(data?.credit_balance ?? 0)
  const topup   = Number(data?.last_topup_usd ?? 0)
  return { balance, last_topup_usd: topup, alert: computeAlert(topup, balance) }
}

module.exports = { getBalance, canRun, chargeForOperation, addCredits, getStatus }
