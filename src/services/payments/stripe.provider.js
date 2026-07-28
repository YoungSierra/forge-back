// ─── Adaptador de pasarela: STRIPE ───────────────────────────────────────────────────────────
// Aislado detrás de payments.service.js. Cambiar de pasarela = agregar otro provider con la misma
// interfaz (createCheckout / parseWebhook), sin tocar el resto del sistema.
//
// Env: STRIPE_SECRET_KEY (sk_test_… en sandbox), STRIPE_WEBHOOK_SECRET (whsec_…).
// ─────────────────────────────────────────────────────────────────────────────────────────────
const Stripe = require('stripe')

const _stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null
function client() {
  if (!_stripe) throw new Error('Stripe not configured (missing STRIPE_SECRET_KEY)')
  return _stripe
}

// Crea una sesión de Checkout (hosted). El saldo es USD-equivalente, así que amountUsd == créditos.
// Devuelve { url, id }. La org queda en metadata para saber a quién acreditar en el webhook.
async function createCheckout({ orgId, orgName, amountUsd, successUrl, cancelUrl, customerEmail }) {
  const session = await client().checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(Number(amountUsd) * 100), // centavos
        product_data: { name: `Forge credits — ${orgName}` },
      },
    }],
    // Genera una factura (invoice PDF con nº, ítems y datos) por cada compra; Stripe la envía por email
    // si "Email finalized invoices" está activo. El recibo de pago se activa aparte en el Dashboard.
    invoice_creation: { enabled: true, invoice_data: { description: `Forge credit top-up — ${orgName}` } },
    // Prefija el email de facturación de la org (si no hay, Checkout lo pide en la página de pago)
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    metadata: { org_id: orgId, amount_usd: String(amountUsd) },
    success_url: successUrl,
    cancel_url:  cancelUrl,
  })
  return { url: session.url, id: session.id }
}

// Verifica la firma del webhook y, si es un pago completado, devuelve el movimiento de crédito.
// Devuelve { orgId, amountUsd, externalRef } o null si el evento no aplica.
function parseWebhook({ rawBody, signature }) {
  const event = client().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)
  if (event.type !== 'checkout.session.completed') return null
  const s = event.data.object
  if (s.payment_status !== 'paid') return null
  return {
    orgId:       s.metadata?.org_id,
    amountUsd:   Number(s.metadata?.amount_usd),
    externalRef: s.payment_intent || s.id, // id del pago en Stripe (para el libro mayor)
  }
}

module.exports = { createCheckout, parseWebhook }
