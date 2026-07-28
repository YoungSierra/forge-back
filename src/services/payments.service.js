// ─── payments.service · Frente 4 (Multi-Org) ─────────────────────────────────────────────────
// Dispatcher AGNÓSTICO de pasarela. El resto del sistema (créditos, consolas) usa solo estas
// funciones; la pasarela concreta se elige por env PAYMENT_PROVIDER. Cambiar de pasarela =
// agregar un provider en ./payments/ con la misma interfaz.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const PROVIDER = process.env.PAYMENT_PROVIDER || 'stripe'

const providers = {
  stripe: require('./payments/stripe.provider'),
  // mercadopago: require('./payments/mercadopago.provider'),  // <- futuro
}

function provider() {
  const p = providers[PROVIDER]
  if (!p) throw new Error(`Unknown PAYMENT_PROVIDER: ${PROVIDER}`)
  return p
}

// Crea una sesión de pago y devuelve { url, id } para redirigir al usuario a la pasarela.
async function createCheckout(args) {
  return provider().createCheckout(args)
}

// Verifica/parsea el webhook -> { orgId, amountUsd, externalRef } o null.
function parseWebhook(args) {
  return provider().parseWebhook(args)
}

module.exports = { createCheckout, parseWebhook, PROVIDER }
