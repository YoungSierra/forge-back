const express = require('express')
const router  = express.Router()
const { db, TEST_MEMBER_ID } = require('../services/supabase.service')
const { callLLM }            = require('../services/llm.service')
const { getPrompt }          = require('../services/prompt.service')
const { validateStepConfig } = require('../services/config.service')
const { generateImageForNode } = require('../services/image.service')
const { injectVars }         = require('../utils/inject-vars')

// Claves de pipeline que no son outputs de nodos generables
const PIPELINE_META_KEYS = new Set([
  'game_idea', 'idea_expansion', 'direction_lock',
  'gdd_sections', 'gdd',
])

// Schemas de nodos estructurados — define qué campos produce el LLM como array de objetos.
// El campo item_name_field indica cuál se usa como título en el renderer del frontend.
// Extender aquí cuando se agreguen nuevos nodos estructurados.
const STEP_SCHEMAS = {
  gdd_mechanics: {
    fields: ['name', 'category', 'description', 'player_goal', 'rules', 'depth', 'integration'],
    item_name_field: 'name',
  },
}

// Instrucción JSON que se añade al userMessage cuando el nodo es estructurado
function buildJsonInstruction(schema) {
  const fieldsStr = schema.fields.join(', ')
  return `\n\n---\nIMPORTANT: Respond ONLY with a valid JSON array. Each element must have these exact fields: ${fieldsStr}. No markdown code fences, no preamble, no explanation — just the raw JSON array starting with "[" and ending with "]".`
}

// Parsea el output del LLM como JSON array; retorna null si falla.
// Intenta múltiples estrategias para ser resiliente ante texto extra del LLM.
function parseJsonItems(raw) {
  // Estrategia 1: quitar fences y parsear directo
  try {
    const cleaned = raw
      .replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/```\s*$/im, '')
      .trim()
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) return parsed
  } catch { /* seguir */ }

  // Estrategia 2: extraer el bloque de array del texto (tolerante a preámbulos del LLM)
  try {
    const match = raw.match(/\[[\s\S]*\]/)
    if (match) {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) return parsed
    }
  } catch { /* seguir */ }

  return null
}

// Concatena outputs aprobados de nodos previos para inyectar como contexto
function buildPriorOutputs(pipeline, currentStepKey) {
  const parts = []
  for (const [key, value] of Object.entries(pipeline)) {
    if (PIPELINE_META_KEYS.has(key)) continue
    if (key === currentStepKey) continue
    if (!value || typeof value !== 'object' || !value.approved) continue

    let text = null
    if (typeof value.output === 'string' && value.output.trim()) {
      text = value.output
    } else {
      const { approved, approved_at, image_url, ...rest } = value
      if (Object.keys(rest).length) text = JSON.stringify(rest, null, 2)
    }
    if (text) parts.push(`### ${key}\n${text}`)
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : 'No prior node outputs yet.'
}

// POST /api/pipeline/run
// Body: { project_id, step_key, member_id? }
// Returns: { success, step_key, output, image_url? }
router.post('/run', async (req, res, next) => {
  try {
    const { project_id, step_key } = req.body

    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required' })
    if (!step_key)   return res.status(400).json({ success: false, error: 'step_key is required' })

    // Validar config
    const check = await validateStepConfig(step_key)
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })
    const config = check.config

    // Cargar proyecto
    const { data: project, error: pErr } = await db()
      .from('projects')
      .select('id, name, concept')
      .eq('id', project_id)
      .single()

    if (pErr || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const pipeline     = project.concept?.pipeline || {}
    const gameIdea     = pipeline.game_idea?.text   || ''
    const rawIdea      = pipeline.idea_expansion?.raw_idea || ''
    const priorOutputs = buildPriorOutputs(pipeline, step_key)

    const vars = {
      GAME_IDEA:     gameIdea,
      PROJECT_NAME:  project.name || '',
      RAW_IDEA:      rawIdea,
      PRIOR_OUTPUTS: priorOutputs,
    }

    let output   = null
    let imageUrl = null

    // ── LLM ──────────────────────────────────────────────────────────────────────
    if (config.integration_type === 'llm') {
      const nodeTemplate = await getPrompt(step_key)
      if (!nodeTemplate) {
        return res.status(422).json({
          success: false,
          error: `Prompt for "${step_key}" not configured. Set R2 path in Admin → Prompts.`,
          code: 'PROMPT_NOT_CONFIGURED',
        })
      }

      const rulesTemplate = await getPrompt('rules')

      let systemPrompt, userMessage
      if (rulesTemplate) {
        // Rules como system prompt; node template como user message
        systemPrompt = injectVars(rulesTemplate,  vars)
        userMessage  = injectVars(nodeTemplate,   vars)
      } else {
        // Sin rules: node template como system; game_idea como user message
        systemPrompt = injectVars(nodeTemplate, vars)
        userMessage  = gameIdea || 'Generate the output for this step based on the context above.'
      }

      // Si el nodo tiene schema estructurado, añadir instrucción JSON al mensaje
      const nodeSchema = STEP_SCHEMAS[step_key]
      if (nodeSchema) userMessage += buildJsonInstruction(nodeSchema)

      let result
      try {
        result = await callLLM(systemPrompt, userMessage, {
          step:            step_key,
          rawText:         true,
          maxOutputTokens: 8192,
          temperature:     0.8,
        })
      } catch (err) {
        const isRateLimit = err.status === 429 || err.code === 'RATE_LIMIT'
        return res.status(502).json({
          success: false,
          error:  isRateLimit ? 'Rate limit reached. Try again in a few seconds.' : 'LLM call failed',
          code:   isRateLimit ? 'RATE_LIMIT' : (err.code || 'LLM_ERROR'),
        })
      }

      output = result.data

    // ── n8n ───────────────────────────────────────────────────────────────────────
    } else if (config.integration_type === 'n8n') {
      if (!config.webhook_url) {
        return res.status(422).json({ success: false, error: 'n8n webhook URL not configured', code: 'STEP_NOT_CONFIGURED' })
      }
      let webhookRes
      try {
        webhookRes = await fetch(config.webhook_url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            project_id, step_key,
            game_idea:     gameIdea,
            project_name:  project.name,
            raw_idea:      rawIdea,
            prior_outputs: priorOutputs,
          }),
          signal: AbortSignal.timeout(120_000),
        })
      } catch (err) {
        return res.status(502).json({ success: false, error: `n8n webhook unreachable: ${err.message}`, code: 'N8N_ERROR' })
      }
      if (!webhookRes.ok) {
        const body = await webhookRes.text()
        return res.status(502).json({ success: false, error: `n8n error ${webhookRes.status}: ${body}`, code: 'N8N_ERROR' })
      }
      const webhookData = await webhookRes.json().catch(() => ({}))
      output = webhookData.output ?? webhookData.data ?? JSON.stringify(webhookData)

    // ── ComfyUI ──────────────────────────────────────────────────────────────────
    } else if (config.integration_type === 'comfyui') {
      return res.status(422).json({
        success: false,
        error: 'ComfyUI direct pipeline generation not yet supported via this endpoint.',
        code: 'NOT_IMPLEMENTED',
      })

    } else {
      return res.status(422).json({
        success: false,
        error: `Unknown integration_type "${config.integration_type}" for step "${step_key}".`,
        code: 'STEP_NOT_CONFIGURED',
      })
    }

    // ── Parsear JSON si el nodo tiene schema estructurado ────────────────────────
    let items = null
    if (STEP_SCHEMAS[step_key] && output) {
      items = parseJsonItems(output)
      if (!items) console.warn(`[pipeline/run] JSON parse failed for ${step_key} — falling back to plain text`)
    }

    // ── Imagen por item (nodos estructurados) o imagen única (nodos planos) ──────
    if (config.image_enabled && output) {
      try {
        if (items && items.length > 0) {
          // Generar una imagen por item en paralelo
          const schema = STEP_SCHEMAS[step_key]
          const imgResults = await Promise.all(
            items.map((item, i) => {
              const imgPrompt = String(item.description || item[schema?.item_name_field] || item.name || '')
                .slice(0, 300).replace(/[#*`_\[\]]/g, '').trim()
              const storagePath = `projects/${project_id}/pipeline/${step_key}/items/${i}.png`
              return generateImageForNode(step_key, imgPrompt, 512, 512, storagePath)
                .then(r => r?.url ?? null)
                .catch(err => { console.warn(`[pipeline/run] Image failed for ${step_key}[${i}]:`, err.message); return null })
            })
          )
          items = items.map((item, i) => ({ ...item, image_url: imgResults[i] }))
          imageUrl = null // no imagen única cuando hay items con imágenes propias
        } else {
          // Imagen única para nodos sin schema estructurado
          const storagePath = `projects/${project_id}/pipeline/${step_key}/image.png`
          const imagePrompt = String(output).slice(0, 300).replace(/[#*`_\[\]]/g, '').trim()
          const imgResult   = await generateImageForNode(step_key, imagePrompt, 512, 512, storagePath)
          imageUrl          = imgResult?.url ?? null

          if (imageUrl) {
            let assetId
            const { data: existingAsset } = await db()
              .from('assets').select('id')
              .eq('project_id', project_id).eq('step_key', step_key).eq('name', step_key)
              .maybeSingle()
            if (existingAsset) {
              assetId = existingAsset.id
              await db().from('assets').update({ review_status: 'pending' }).eq('id', assetId)
            } else {
              const { data: newAsset } = await db().from('assets')
                .insert({ project_id, step_key, name: step_key, type: 'image', discipline: 'art', review_status: 'pending' })
                .select('id').maybeSingle()
              assetId = newAsset?.id
            }
            if (assetId) {
              await db().from('asset_versions').update({ is_current: false }).eq('asset_id', assetId)
              const { count } = await db()
                .from('asset_versions').select('*', { count: 'exact', head: true }).eq('asset_id', assetId)
              await db().from('asset_versions').insert({
                asset_id:       assetId,
                version_number: (count || 0) + 1,
                source:         'ai_generated',
                storage_url:    imageUrl,
                storage_bucket: 'r2',
                is_current:     true,
                metadata:       { step_key, storage_path: storagePath },
              })
            }
          }
        }
      } catch (imgErr) {
        console.warn(`[pipeline/run] Image generation failed for ${step_key}:`, imgErr.message)
      }
    }

    console.log(`[pipeline/run] project=${project_id} step=${step_key} chars=${String(output ?? '').length} items=${items?.length ?? 0} image=${!!imageUrl}`)

    res.json({ success: true, step_key, output, image_url: imageUrl, ...(items ? { items } : {}) })
  } catch (err) {
    next(err)
  }
})

// POST /api/pipeline/save-draft
// Guarda el output generado como borrador pendiente de revisión (sin aprobar)
// Body: { project_id, step_key, output, image_url? }
// Returns: { success, step_key }
router.post('/save-draft', async (req, res, next) => {
  try {
    const { project_id, step_key, output, image_url, member_id, items } = req.body
    const actorId = member_id || req.headers['x-member-id'] || TEST_MEMBER_ID

    if (!project_id) return res.status(400).json({ success: false, error: 'project_id is required' })
    if (!step_key)   return res.status(400).json({ success: false, error: 'step_key is required' })
    if (!output && !items) return res.status(400).json({ success: false, error: 'output or items is required' })

    const { data: project, error: pErr } = await db()
      .from('projects')
      .select('id, concept')
      .eq('id', project_id)
      .single()

    if (pErr || !project) {
      return res.status(404).json({ success: false, error: 'Project not found', code: 'NOT_FOUND' })
    }

    const now      = new Date().toISOString()
    const pipeline = project.concept?.pipeline || {}

    // Preservar campos existentes del entry (ej: chat_history) al actualizar draft
    const updatedPipeline = {
      ...pipeline,
      [step_key]: {
        ...(pipeline[step_key] || {}),
        output: output ?? '',
        ...(Array.isArray(items) && items.length > 0 ? { items } : {}),
        ...(image_url ? { image_url } : {}),
        pending_review: true,
        approved: false,
        generated_at: now,
      },
    }

    const { error: uErr } = await db()
      .from('projects')
      .update({ concept: { ...project.concept, pipeline: updatedPipeline }, updated_at: now })
      .eq('id', project_id)

    if (uErr) {
      return res.status(500).json({ success: false, error: 'Failed to save draft', code: 'SUPABASE_ERROR' })
    }

    // Upsert generation_job — un solo registro por (project_id, step_key), se actualiza siempre
    const { data: existingJob } = await db()
      .from('generation_jobs')
      .select('id')
      .eq('project_id', project_id)
      .eq('current_step', step_key)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingJob) {
      await db().from('generation_jobs')
        .update({ status: 'review', progress: 100, started_at: now, completed_at: null })
        .eq('id', existingJob.id)
    } else {
      await db().from('generation_jobs').insert({
        project_id,
        triggered_by: actorId,
        status: 'review',
        progress: 100,
        current_step: step_key,
        input_prompt: `Pipeline node draft: ${step_key}`,
        started_at: now,
      })
    }

    console.log(`[pipeline/save-draft] project=${project_id} step=${step_key} → pending_review`)

    res.json({ success: true, step_key })
  } catch (err) {
    next(err)
  }
})

// POST /api/pipeline/save-chat-history
// Guarda el historial de chat de un step en concept.pipeline[step_key].chat_history
// Body: { project_id, step_key, chat_history }
router.post('/save-chat-history', async (req, res, next) => {
  try {
    const { project_id, step_key, chat_history } = req.body
    if (!project_id || !step_key || !Array.isArray(chat_history))
      return res.status(400).json({ success: false, error: 'project_id, step_key, and chat_history are required' })

    const { data: project, error: pErr } = await db()
      .from('projects').select('id, concept').eq('id', project_id).single()
    if (pErr || !project)
      return res.status(404).json({ success: false, error: 'Project not found' })

    const pipeline    = project.concept?.pipeline || {}
    const existing    = pipeline[step_key] || {}
    const updatedPipeline = { ...pipeline, [step_key]: { ...existing, chat_history } }

    const { error: uErr } = await db()
      .from('projects')
      .update({ concept: { ...project.concept, pipeline: updatedPipeline } })
      .eq('id', project_id)

    if (uErr) return res.status(500).json({ success: false, error: 'Failed to save chat history' })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/pipeline/save-image-version
// Guarda versión refinada (human_refined) de imagen de un nodo con image_enabled
// Body: { project_id, step_key, image_url }
// Returns: { success, version }
router.post('/save-image-version', async (req, res, next) => {
  try {
    const { project_id, step_key, image_url } = req.body
    if (!project_id || !step_key || !image_url) {
      return res.status(400).json({ success: false, error: 'project_id, step_key, image_url requeridos' })
    }

    const { data: asset } = await db()
      .from('assets').select('id')
      .eq('project_id', project_id).eq('step_key', step_key).eq('name', step_key)
      .maybeSingle()

    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset no encontrado — genera primero' })
    }

    await db().from('asset_versions').update({ is_current: false }).eq('asset_id', asset.id)

    const { count } = await db()
      .from('asset_versions').select('*', { count: 'exact', head: true }).eq('asset_id', asset.id)

    const { data: version } = await db().from('asset_versions').insert({
      asset_id:       asset.id,
      version_number: (count || 0) + 1,
      source:         'human_refined',
      storage_url:    image_url,
      storage_bucket: 'r2',
      is_current:     true,
      metadata:       { step_key },
    }).select().maybeSingle()

    console.log(`[pipeline/save-image-version] project=${project_id} step=${step_key} → human_refined v${(count || 0) + 1}`)
    res.json({ success: true, version })
  } catch (err) { next(err) }
})

// POST /api/pipeline/regenerate-item
// Regenera un elemento individual de un nodo estructurado (texto + imagen si aplica)
// Body: { project_id, step_key, item_index }
// Returns: { success, item, item_index }
router.post('/regenerate-item', async (req, res, next) => {
  try {
    const { project_id, step_key, item_index } = req.body
    if (!project_id || step_key == null || item_index == null) {
      return res.status(400).json({ success: false, error: 'project_id, step_key, item_index required' })
    }

    const schema = STEP_SCHEMAS[step_key]
    if (!schema) return res.status(422).json({ success: false, error: `No schema defined for step "${step_key}"`, code: 'NO_SCHEMA' })

    const check = await validateStepConfig(step_key)
    if (!check.valid) return res.status(422).json({ success: false, error: check.error, code: check.code })
    const config = check.config

    const { data: project, error: pErr } = await db()
      .from('projects')
      .select('id, name, concept')
      .eq('id', project_id)
      .single()
    if (pErr || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const pipeline    = project.concept?.pipeline || {}
    const existing    = pipeline[step_key]
    const currentItems = existing?.items

    if (!Array.isArray(currentItems) || item_index >= currentItems.length) {
      return res.status(400).json({ success: false, error: `Item index ${item_index} not found in ${step_key}` })
    }

    const currentItem = currentItems[item_index]
    const gameIdea    = pipeline.game_idea?.text || ''
    const rawIdea     = pipeline.idea_expansion?.raw_idea || ''
    const fieldsStr   = schema.fields.join(', ')

    const systemPrompt = `You are a game designer creating structured game design content. Return ONLY valid JSON.`
    const userMessage  = `Game concept: ${gameIdea || rawIdea}\n\nRegenerate item #${item_index + 1} (currently named "${currentItem[schema.item_name_field] || currentItem.name || 'unknown'}") for the "${step_key}" section.\n\nReturn ONLY a JSON object with these exact fields: ${fieldsStr}.\nNo markdown fences, no explanation — just the raw JSON object.`

    let llmResult
    try {
      llmResult = await callLLM(systemPrompt, userMessage, {
        step: step_key,
        rawText: true,
        maxOutputTokens: 1024,
        temperature: 0.85,
      })
    } catch (err) {
      const isRateLimit = err.status === 429 || err.code === 'RATE_LIMIT'
      return res.status(502).json({
        success: false,
        error: isRateLimit ? 'Rate limit reached. Try again in a few seconds.' : 'LLM call failed',
        code: isRateLimit ? 'RATE_LIMIT' : 'LLM_ERROR',
      })
    }

    let newItem = parseJsonItems(`[${llmResult.data}]`)?.[0] ?? null
    if (!newItem || typeof newItem !== 'object') {
      // Intentar parsear directamente como objeto
      try {
        const cleaned = llmResult.data
          .replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/```\s*$/im, '').trim()
        newItem = JSON.parse(cleaned)
        if (typeof newItem !== 'object' || Array.isArray(newItem)) newItem = null
      } catch { newItem = null }
    }
    if (!newItem) return res.status(500).json({ success: false, error: 'LLM did not return valid JSON', code: 'PARSE_ERROR' })

    // Imagen si aplica
    if (config.image_enabled) {
      try {
        const imgPrompt = String(newItem.description || newItem[schema.item_name_field] || newItem.name || '')
          .slice(0, 300).replace(/[#*`_\[\]]/g, '').trim()
        const storagePath = `projects/${project_id}/pipeline/${step_key}/items/${item_index}.png`
        const imgResult = await generateImageForNode(step_key, imgPrompt, 512, 512, storagePath)
        newItem.image_url = imgResult?.url ?? null
      } catch (err) {
        console.warn(`[pipeline/regenerate-item] Image failed for ${step_key}[${item_index}]:`, err.message)
        newItem.image_url = null
      }
    }

    // Actualizar el item en BD (sin cambiar approved/pending_review del nodo)
    const updatedItems = [...currentItems]
    updatedItems[item_index] = newItem
    const now = new Date().toISOString()
    const updatedConcept = {
      ...project.concept,
      pipeline: { ...pipeline, [step_key]: { ...existing, items: updatedItems, updated_at: now } },
    }
    await db().from('projects').update({ concept: updatedConcept, updated_at: now }).eq('id', project_id)

    console.log(`[pipeline/regenerate-item] project=${project_id} step=${step_key} idx=${item_index}`)
    res.json({ success: true, item: newItem, item_index })
  } catch (err) { next(err) }
})

module.exports = router
