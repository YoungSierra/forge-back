require('dotenv').config()

const { validateEnv, PORT, FRONTEND_URL, STORAGE_PATH } = require('./config/env')
validateEnv()

const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const path = require('path')
const fs = require('fs')

const { testConnection } = require('./services/supabase.service')

const gddRoutes = require('./routes/gdd.routes')
const projectsRoutes = require('./routes/projects.routes')
const assetsRoutes = require('./routes/assets.routes')
const validationRoutes = require('./routes/validation.routes')
const membersRoutes = require('./routes/members.routes')
const feedbackRoutes = require('./routes/feedback.routes')
const adminRoutes        = require('./routes/admin.routes')
const adminConfigsRoutes = require('./routes/admin.configs.routes')
const adminPromptsRoutes    = require('./routes/admin.prompts.routes')
const adminSkillsRoutes     = require('./routes/admin.skills.routes')
const adminOrgsRoutes       = require('./routes/admin.orgs.routes')
const imageReferenceRoutes  = require('./routes/image-reference.routes')
const charaterRoutes              = require('./routes/charaters.routes')
const modelingCharactersRoutes    = require('./routes/modeling-characters.routes')
const pipelineConfigRoutes        = require('./routes/pipeline-config.routes')
const webhooksRoutes        = require('./routes/webhooks.routes')
const genIdeaRoutes         = require('./routes/gen-idea.routes')
const ideationRoutes        = require('./routes/ideation.routes')
const marketResearchRoutes  = require('./routes/market-research.routes')
const stage0Routes          = require('./routes/stage0.routes')
const gddSectionsRoutes     = require('./routes/gdd-sections.routes')
const pipelineRoutes        = require('./routes/pipeline.routes')
const pipelineRunRoutes     = require('./routes/pipeline-run.routes')
const { catalogRouter: actionNodesCatalogRoutes, projectRouter: actionNodesProjectRoutes } = require('./routes/action-nodes.routes')
const chatRoutes            = require('./routes/chat.routes')
const { requirePlatformAdmin } = require('./middleware/requirePlatformAdmin')
const { requireAuth } = require('./middleware/requireAuth')
const { requireOrgAdmin } = require('./middleware/requireOrgAdmin')
const orgAdminRoutes        = require('./routes/org-admin.routes')
const forgeNodesRoutes      = require('./routes/forge-nodes.routes')
const forgeBlueprintsRoutes = require('./routes/forge-blueprints.routes')
const forgeCanvasRoutes     = require('./routes/forge-canvas.routes')
const forgeLibraryRoutes    = require('./routes/forge-library.routes')
const analyticsRoutes       = require('./routes/analytics.routes')
const adminAssemblyRoutes   = require('./routes/admin.assembly.routes')
const { publicRouter: changelogPublicRoutes, adminRouter: changelogAdminRoutes } = require('./routes/changelog.routes')

// Ensure base storage dirs exist on startup
fs.mkdirSync(path.join(STORAGE_PATH, 'projects'), { recursive: true })

const app = express()

app.use(cors({ origin: FRONTEND_URL, credentials: true }))
app.use(morgan('dev'))

// Webhook de pagos (Stripe) — DEBE ir ANTES de express.json() para tener el body CRUDO
// (Stripe verifica la firma sobre el raw body). Los créditos se acreditan solo aquí, tras el pago
// confirmado por la pasarela -> nunca se regalan desde el front.
app.post('/api/webhooks/stripe', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const { parseWebhook, PROVIDER } = require('./services/payments.service')
    const { addCredits } = require('./services/credits.service')
    const evt = parseWebhook({ rawBody: req.body, signature: req.headers['stripe-signature'] })
    if (evt?.orgId && evt.amountUsd > 0) {
      await addCredits({ orgId: evt.orgId, amountUsd: evt.amountUsd, paymentProvider: PROVIDER, externalRef: evt.externalRef })
      console.log(`[payments] +$${evt.amountUsd} creditos -> org ${evt.orgId} (ref ${evt.externalRef})`)
    }
    res.json({ received: true })
  } catch (e) {
    console.error('[payments webhook]', e.message)
    res.status(400).send(`Webhook Error: ${e.message}`)
  }
})

app.use(express.json({ limit: '10mb' }))

// Static file serving for generated assets
app.use('/assets', express.static(path.resolve(STORAGE_PATH)))

// Health check — instant, no DB
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), supabase: supabaseReady ? 'connected' : 'warming_up' })
})

// DB health — tests Supabase connection (may be slow on cold start)
app.get('/api/health/db', async (req, res) => {
  try {
    await testConnection()
    res.json({ status: 'ok', supabase: 'connected' })
  } catch (err) {
    res.status(503).json({ status: 'error', supabase: `error: ${err.message}` })
  }
})

// Routes

// ── Frente 2 (Multi-Org): gate de autenticación sobre TODO /api/projects (incluye /canvas y /library).
// La identidad sale del JWT de Supabase (requireAuth), no de datos del cliente.
// EXCEPCIÓN: rutas que sirven ARCHIVOS al navegador (img/model en <img>/<model-viewer>, /play en
// iframe) se cargan sin headers → no pueden llevar el token → pasan sin gate por ahora (se apoyan en
// UUIDs no adivinables; endurecer con URLs firmadas más adelante).
const ASSET_PASSTHROUGH = /\/play$|\/library\/[^/]+\/file$/
app.use('/api/projects', (req, res, next) => {
  if (ASSET_PASSTHROUGH.test((req.originalUrl || '').split('?')[0])) return next()
  return requireAuth(req, res, next)
})

app.use('/api/generate', gddRoutes)
app.use('/api/projects', projectsRoutes)
app.use('/api/projects', imageReferenceRoutes)
app.use('/api/projects', charaterRoutes)
app.use('/api/projects', modelingCharactersRoutes)
app.use('/api/projects', pipelineConfigRoutes)
app.use('/api/assets', assetsRoutes)
app.use('/api/validate', validationRoutes)
app.use('/api/members', membersRoutes)
app.use('/api/feedback', feedbackRoutes)
app.use('/api/admin', requirePlatformAdmin, adminRoutes)
app.use('/api/admin', requirePlatformAdmin, adminConfigsRoutes)
app.use('/api/admin', requirePlatformAdmin, adminPromptsRoutes)
app.use('/api/admin', requirePlatformAdmin, adminSkillsRoutes)
app.use('/api/admin', requirePlatformAdmin, adminOrgsRoutes)
app.use('/api/org',   requireAuth, requireOrgAdmin, orgAdminRoutes)
app.use('/api/admin/forge/nodes',      requirePlatformAdmin, forgeNodesRoutes)
app.use('/api/admin/forge/blueprints', requirePlatformAdmin, forgeBlueprintsRoutes)
app.use('/api/admin/analytics',        requirePlatformAdmin, analyticsRoutes)
app.use('/api/admin/assembly',         requirePlatformAdmin, adminAssemblyRoutes)
app.use('/api/admin',                  requirePlatformAdmin, changelogAdminRoutes)
app.use('/api/changelog',              changelogPublicRoutes)
app.use('/api/projects/:id/canvas',   forgeCanvasRoutes)
app.use('/api/projects/:id/library',  forgeLibraryRoutes)
app.use('/api/webhooks', webhooksRoutes)
app.use('/api/gen-idea', genIdeaRoutes)
app.use('/api/ideation', ideationRoutes)
app.use('/api/market-research', marketResearchRoutes)
app.use('/api/generate', stage0Routes)
app.use('/api/generate', gddSectionsRoutes)
app.use('/api/pipeline', pipelineRoutes)
app.use('/api/pipeline', pipelineRunRoutes)
app.use('/api/action-nodes', actionNodesCatalogRoutes)
app.use('/api/projects',     actionNodesProjectRoutes)
app.use('/api/chat',         chatRoutes)

// Models config — reads step models from DB via configService
app.get('/api/models', async (req, res, next) => {
  try {
    const { getStepConfigs } = require('./services/config.service')
    const configs = await getStepConfigs()

    const models = { default: process.env.DEFAULT_MODEL || 'gemini:gemini-2.5-flash' }
    for (const [stepKey, cfg] of Object.entries(configs)) {
      if (cfg.integration_type === 'llm' && cfg.model_name) {
        models[stepKey] = cfg.model_name
      }
    }

    res.json({
      success: true,
      models,
      available_providers: {
        gemini:     !!process.env.GEMINI_API_KEY,
        groq:       !!process.env.GROQ_API_KEY,
        together:   !!process.env.TOGETHER_API_KEY,
        openrouter: !!process.env.OPENROUTER_API_KEY,
        openai:     !!process.env.OPENAI_API_KEY,
      },
    })
  } catch (err) { next(err) }
})


// 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found', code: 'NOT_FOUND' })
})

// Global error handler
app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString()
  console.error(`[${timestamp}] Error:`, err.message)

  const isDev = process.env.NODE_ENV === 'development'
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    ...(isDev && { details: { message: err.message, stack: err.stack } })
  })
})

async function runMigrations() {
  const { db } = require('./services/supabase.service')

  // Renombrar step_key 'modeling' → 'modeling_characters' en step_configs
  const { data: old } = await db().from('step_configs').select('id').eq('step_key', 'modeling').limit(1).single()
  if (old) {
    await db().from('step_configs').update({ step_key: 'modeling_characters' }).eq('step_key', 'modeling')
    console.log('[migration] step_configs: modeling → modeling_characters')
  }

  // Insertar step_configs vacíos para nodos nuevos si no existen
  const NEW_STEPS = ['environments', 'props', 'modeling_environments', 'modeling_props']
  for (const step_key of NEW_STEPS) {
    const { data: exists } = await db().from('step_configs').select('id').eq('step_key', step_key).limit(1).single()
    if (!exists) {
      await db().from('step_configs').insert({ step_key, integration_type: 'llm' })
      console.log(`[migration] step_configs: inserted "${step_key}"`)
    }
  }

}

let supabaseReady = false

const server = app.listen(PORT, () => {
  console.log(`[FORGE] Server running on http://localhost:${PORT}`)
  // Timeout largo para workflows 3D que pueden tardar varios minutos
  server.timeout = 660_000 // 11 minutos (1 min más que el poll de ComfyUI)
  console.log(`[FORGE] Storage path: ${path.resolve(STORAGE_PATH)}`)
  console.log(`[FORGE] Frontend origin: ${FRONTEND_URL}`)

  // Warm up Supabase connection pool in the background so the first real
  // request doesn't pay the cold-start penalty (~60s on free tier).
  testConnection()
    .then(async () => {
      supabaseReady = true
      console.log('[FORGE] Supabase connection ready')
      await runMigrations()
    })
    .catch(err => {
      console.warn('[FORGE] Supabase warm-up failed:', err.message)
    })
})
