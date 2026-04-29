const REQUIRED = [
  'GEMINI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CF_ACCOUNT_ID',
  'CF_R2_ACCESS_KEY_ID',
  'CF_R2_SECRET_ACCESS_KEY',
  'CF_R2_PUBLIC_URL',
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
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  CF_R2_BUCKET: process.env.CF_R2_BUCKET || 'forge-assets',
  CF_R2_PUBLIC_URL: process.env.CF_R2_PUBLIC_URL,
  CF_R2_FEEDBACK_BUCKET: process.env.CF_R2_FEEDBACK_BUCKET || 'feedback-screenshots',
  CF_R2_FEEDBACK_PUBLIC_URL: process.env.CF_R2_FEEDBACK_PUBLIC_URL || '',
}
