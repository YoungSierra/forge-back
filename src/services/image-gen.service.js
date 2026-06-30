// ─── Servicio de generación de imágenes ───────────────────────────────────────
// Núcleo reutilizable extraído de la ruta generate-item-image. Lo usan:
//  · la ruta on-demand /generate-item-image (botón ✦ del frontend)
//  · executeImageOutput() en el auto-run (Run All / scoped runs)
//
// Principio: el ADN manda. El conteo de imágenes NO se hardcodea — sale de cuántos
// ítems produzca el contenido del output (parseOutputItems), tal como pida su prompt.

const { logExecution } = require('./execution-log.service')

// ─── Filtro estricto de outputs de imagen auto-generables ──────────────────────
// Solo png/image con image_gen:true. Los outputs prose/markdown con image_gen:true
// (botón ✦ manual) quedan user-decided y NO se auto-generan.
function imageOutputsOf(node) {
  const outs = (Array.isArray(node?.outputs) ? node.outputs : []).map(o => ({ ...o, key: o.key || o.name }))
  return outs.filter(o => o.key && o.image_gen === true && (o.format === 'png' || o.format === 'image'))
}

// ─── Port de parseOutputItems (frontend NodeChatWindow.tsx) ────────────────────
// Diferencia clave con el frontend: NO se colapsa png/image a 1 ítem. El contenido
// se parsea en N ítems (la lista de prompts que escribe el agente) → N imágenes.
// Respeta el ADN: si el prompt pide "2–3 imágenes", el agente produce 2–3 prompts.
function parseOutputItems(content, format) {
  if (format === 'json') {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) return parsed.map(String).filter(s => s.trim().length > 0)
    } catch { /* continúa */ }
  }

  // Bullet list: "- item", "* item", "• item"
  const bulletRx   = /^[ \t]*[-*•][ \t]+(.+)$/gm
  // Numbered list: "1. item", "1) item"
  const numberedRx = /^[ \t]*\d+[.)]\s+(.+)$/gm
  // Markdown heading con número: "## 1. title", "### Variation 1: title"
  const headingRx  = /^#{1,4}\s+(?:\*{0,2})(?:[A-Za-z]+\s+)?\d+[:.)]?\s+(.+)$/gm

  const bullets = [...content.matchAll(bulletRx)].map(m => m[1].trim())
  if (bullets.length > 0) return bullets

  const numbered = [...content.matchAll(numberedRx)].map(m => m[1].trim())
  if (numbered.length > 0) return numbered

  // Labeled con descripción: dividir por cada "Variation N:" y capturar el bloque completo
  const labeledParts = content
    .split(/(?=^[A-Za-z]+[ \t]+\d+[:.]\s)/m)
    .map(p => p.trim())
    .filter(p => /^[A-Za-z]+[ \t]+\d+[:.]\s/.test(p))
  if (labeledParts.length > 0) return labeledParts

  // Heading con número + contenido subsiguiente (bloque completo por ítem)
  const richBlocks = []
  const richRx = /^#{1,4}[ \t]+([^\n]+(?:\n(?!#{1,4}[ \t])[^\n]*)*)/gm
  for (const m of content.matchAll(richRx)) {
    const block = m[1].trim()
    if (/^(?:\*{0,2})(?:[A-Za-z]+[ \t]+)+\d+/.test(block)) richBlocks.push(block)
  }
  if (richBlocks.length > 0) return richBlocks

  const headings = [...content.matchAll(headingRx)].map(m => m[1].trim())
  if (headings.length > 0) return headings

  // Bloques tipo "Seed 001" / "Concept 002" — encabezado plano sin # ni delimitador
  const seedBlocks = content
    .split(/(?=^[A-Za-z][A-Za-z ]*[ \t]+\d{1,4}\s*$)/m)
    .map(p => p.trim())
    .filter(p => /^[A-Za-z][A-Za-z ]*[ \t]+\d{1,4}/.test(p) && p.length > 40)
  if (seedBlocks.length > 1) return seedBlocks

  // Fallback: el contenido completo es un solo prompt → 1 imagen
  const trimmed = content.trim()
  return trimmed ? [trimmed.slice(0, 700)] : []
}

// ─── Limpieza de markdown del texto del ítem para usarlo como prompt visual ────
function cleanItemText(text) {
  return (text || '').trim()
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')  // quitar negrita/cursiva
    .replace(/^[-*]\s+/, '')                    // quitar bullet inicial
    .replace(/^(Variation\s+\d+:\s*)/i, '')     // quitar prefijo "Variation N:"
}

// ─── Genera UNA imagen y devuelve { url } ──────────────────────────────────────
// No toca la base de datos (salvo el log de costo no bloqueante). El caller decide
// cómo persistir (output_images / forge_assets).
async function generateOneImage({
  project_id, node_id, session_id, node_key,
  output_key, image_gen_model, item_index, item_text, condition, member_id,
}) {
  if (!image_gen_model) {
    throw new Error(`Output "${output_key}" no tiene image_gen_model definido`)
  }

  // Parsear "provider:model_o_workflow"
  const colonIdx = image_gen_model.indexOf(':')
  if (colonIdx < 0) {
    throw new Error(`image_gen_model debe tener formato "provider:model" — recibido: "${image_gen_model}"`)
  }
  const provider  = image_gen_model.slice(0, colonIdx)
  const modelOrWf = image_gen_model.slice(colonIdx + 1)

  const storagePath = `projects/${project_id}/item-images/${node_key}/${output_key}-${session_id}-${item_index}-${Date.now()}.png`

  // Construir prompt final con la condición de variación opcional
  const cleanText = cleanItemText(item_text)
  const imagePrompt = condition?.trim()
    ? `${cleanText}\n\nAdditional visual requirement: ${condition.trim()}`
    : cleanText

  const imgStart = Date.now()

  let result
  if (provider === 'comfyui') {
    const { generateImageComfyUI } = require('./providers/comfyui.provider')
    result = await generateImageComfyUI(modelOrWf, imagePrompt, 1024, 1024, storagePath)
  } else if (provider === 'openai') {
    const { generateImageOpenAI } = require('./providers/openai.image.provider')
    result = await generateImageOpenAI(modelOrWf, imagePrompt, 1024, 1024, storagePath)
  } else if (provider === 'fal') {
    const { generateImageFal } = require('./providers/fal.image.provider')
    result = await generateImageFal(modelOrWf, imagePrompt, 1024, 1024, storagePath)
  } else {
    throw new Error(`Provider de imagen no soportado: "${provider}"`)
  }

  // Registrar costo estimado (no bloqueante, nunca rompe el flujo)
  try {
    logExecution({
      project_id, node_id, session_id,
      triggered_by:  member_id || null,
      trigger_type:  'image_gen',
      executor_type: provider === 'openai' ? 'openai_image' : provider,
      provider,
      model:         modelOrWf,
      is_estimated:  true,
      duration_ms:   Date.now() - imgStart,
      started_at:    new Date(imgStart).toISOString(),
      status:        'success',
      metadata:      { output_key, item_index, width: 1024, height: 1024, node_key },
    })
  } catch (logErr) {
    console.error('[image-gen.service] logExec failed (non-fatal):', logErr.message)
  }

  return { url: result.url, provider, model: modelOrWf }
}

module.exports = { imageOutputsOf, parseOutputItems, cleanItemText, generateOneImage }
