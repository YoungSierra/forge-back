async function callN8n(webhookUrl, payload, timeoutMs = 120_000) {
  let response
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    throw Object.assign(
      new Error(timedOut ? 'n8n webhook timed out' : `n8n webhook unreachable: ${err.message}`),
      { code: 'N8N_ERROR' }
    )
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw Object.assign(
      new Error(`n8n webhook returned ${response.status}: ${body}`),
      { code: 'N8N_ERROR' }
    )
  }
  return response.json()
}

module.exports = { callN8n }
