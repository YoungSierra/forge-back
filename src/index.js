require('dotenv').config()

console.log('[FORGE] ALL ENV KEYS:', Object.keys(process.env).filter(k => !k.startsWith('npm_')).sort())
console.log('[FORGE] GEMINI RAW:', JSON.stringify(process.env.GEMINI_API_KEY))
console.log('[FORGE] SUPABASE_URL RAW:', JSON.stringify(process.env.SUPABASE_URL))

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

// Ensure base storage dirs exist on startup
fs.mkdirSync(path.join(STORAGE_PATH, 'projects'), { recursive: true })

const app = express()

app.use(cors({ origin: FRONTEND_URL }))
app.use(morgan('dev'))
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
app.use('/api/generate', gddRoutes)
app.use('/api/projects', projectsRoutes)
app.use('/api/assets', assetsRoutes)
app.use('/api/validate', validationRoutes)
app.use('/api/members', membersRoutes)
app.use('/api/feedback', feedbackRoutes)

// Models config
app.get('/api/models', (req, res) => {
  const { getStepModel } = require('./services/llm.service')
  res.json({
    success: true,
    models: {
      default:        process.env.DEFAULT_MODEL || 'gemini:gemini-2.5-flash',
      step_1_gdd:     process.env.STEP_1_GDD_MODEL || process.env.DEFAULT_MODEL,
      step_2_sprites: process.env.STEP_2_SPRITES_MODEL || process.env.DEFAULT_MODEL,
      step_3_levels:  process.env.STEP_3_LEVELS_MODEL || process.env.DEFAULT_MODEL,
      step_4_code:    process.env.STEP_4_CODE_MODEL || process.env.DEFAULT_MODEL,
      step_5_audio:   process.env.STEP_5_AUDIO_MODEL || process.env.DEFAULT_MODEL,
      validation:     process.env.VALIDATION_MODEL || process.env.DEFAULT_MODEL,
    },
    available_providers: {
      gemini:     !!process.env.GEMINI_API_KEY,
      groq:       !!process.env.GROQ_API_KEY,
      together:   !!process.env.TOGETHER_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
    }
  })
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

let supabaseReady = false

app.listen(PORT, () => {
  console.log(`[FORGE] Server running on http://localhost:${PORT}`)
  console.log(`[FORGE] Storage path: ${path.resolve(STORAGE_PATH)}`)
  console.log(`[FORGE] Frontend origin: ${FRONTEND_URL}`)

  // Warm up Supabase connection pool in the background so the first real
  // request doesn't pay the cold-start penalty (~60s on free tier).
  testConnection()
    .then(() => {
      supabaseReady = true
      console.log('[FORGE] Supabase connection ready')
    })
    .catch(err => {
      console.warn('[FORGE] Supabase warm-up failed:', err.message)
    })
})
