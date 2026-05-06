// Test de conexión con n8n chatTrigger
// Correr con: node src/workflows/test_n8n_chat.js
// IMPORTANTE: el workflow en n8n debe estar en modo "Test" (escuchando) antes de correr esto

const WEBHOOK_URL = 'https://miguelamez.app.n8n.cloud/webhook-test/c843d20c-9ccb-49c7-9eeb-8bfe92264774'

const TEST_PROMPT = `Genera ideas para un juego mobile casual con estas características:
- Género: puzzle
- Tono: colorido y relajante
- Plataforma: iOS y Android
- Target: adultos 25-40 años`

async function testN8nChat() {
  console.log('Llamando al workflow n8n...')
  console.log('URL:', WEBHOOK_URL)
  console.log('Prompt:', TEST_PROMPT)
  console.log('---')

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatInput: TEST_PROMPT,
        sessionId: 'forge-test-001',
      }),
    })

    console.log('Status:', res.status, res.statusText)

    const contentType = res.headers.get('content-type') || ''
    const raw = await res.text()

    console.log('Content-Type:', contentType)
    console.log('--- RESPUESTA ---')

    if (contentType.includes('application/json')) {
      try {
        const json = JSON.parse(raw)
        console.log(JSON.stringify(json, null, 2))
      } catch {
        console.log(raw)
      }
    } else {
      console.log(raw)
    }
  } catch (err) {
    console.error('Error de conexión:', err.message)
  }
}

testN8nChat()
