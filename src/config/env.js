const REQUIRED = [
  'GEMINI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
]

function validateEnv() {
  const missing = REQUIRED.filter(key => !process.env[key])
  if (missing.length > 0) {
    console.error(`[FORGE] Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
}

module.exports = {
  validateEnv,
  PORT: process.env.PORT || 8000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA || 'v57',
  STORAGE_PATH: process.env.STORAGE_PATH || './storage/forge-assets',
  NODE_ENV: process.env.NODE_ENV || 'development',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000'
}
