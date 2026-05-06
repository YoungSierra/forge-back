const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')

const R2_ENDPOINT = `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`

function getR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.CF_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
    },
  })
}

// Lazy fallbacks — only require() when needed (avoids loading all prompts on startup)
const FALLBACK_MAP = {
  gdd:                  () => require('../prompts/gdd.prompt').GDD_SYSTEM_PROMPT,
  levels:               () => require('../prompts/levels.prompt').LEVELS_SYSTEM_PROMPT,
  audio:                () => require('../prompts/audio.prompt').AUDIO_SYSTEM_PROMPT,
  visual_guide:         () => require('../prompts/visual_guide.prompt').VISUAL_GUIDE_SYSTEM_PROMPT,
  art_direction_intake: () => require('../prompts/art_direction_intake.prompt').ART_DIRECTION_INTAKE_SYSTEM_PROMPT,
  backgrounds:          () => require('../prompts/backgrounds.prompt').BACKGROUNDS_SYSTEM_PROMPT,
  sfx:                  () => require('../prompts/sfx.prompt').SFX_SYSTEM_PROMPT,
  concept_art:          () => require('../prompts/concept_art.prompt').CONCEPT_ART_SYSTEM_PROMPT,
  uiux:                 () => require('../prompts/uiux.prompt').UIUX_SYSTEM_PROMPT,
  icons:                () => require('../prompts/icons.prompt').ICONS_SYSTEM_PROMPT,
  hud:                  () => require('../prompts/hud.prompt').HUD_SYSTEM_PROMPT,
  splash:               () => require('../prompts/splash_art.prompt').SPLASH_ART_SYSTEM_PROMPT,
  marketing:            () => require('../prompts/marketing.prompt').MARKETING_SYSTEM_PROMPT,
  modeling:             () => require('../prompts/modeling.prompt').MODELING_SYSTEM_PROMPT,
  charaters:            () => require('../prompts/characters3d.prompt').CHARACTERS3D_SYSTEM_PROMPT,
  vfx:                  () => require('../prompts/vfx.prompt').VFX_SYSTEM_PROMPT,
  texturing:            () => require('../prompts/texturing.prompt').TEXTURING_SYSTEM_PROMPT,
  rigging:              () => require('../prompts/rigging.prompt').RIGGING_SYSTEM_PROMPT,
  lighting:             () => require('../prompts/lighting.prompt').LIGHTING_SYSTEM_PROMPT,
  animation:            () => require('../prompts/animation.prompt').ANIMATION_SYSTEM_PROMPT,
  cinematics:           () => require('../prompts/cinematics.prompt').CINEMATICS_SYSTEM_PROMPT,
  voice:                () => require('../prompts/voice.prompt').VOICE_SYSTEM_PROMPT,
  validation:           () => require('../prompts/validation.prompt').VALIDATION_SYSTEM_PROMPT,
  playtesting:          () => null,
}

let _cache = {}
let _loadPromise = null

async function fetchFromR2(r2Path) {
  const bucket = process.env.CF_R2_PROMPTS_BUCKET
  if (!bucket) throw new Error('CF_R2_PROMPTS_BUCKET is not set')
  const client = getR2Client()
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: r2Path }))
  return res.Body.transformToString('utf-8')
}

async function _loadAllPrompts() {
  const { db } = require('./supabase.service')
  const { data, error } = await db()
    .from('prompt_configs')
    .select('key, r2_path')

  if (error) {
    console.warn('[promptService] Failed to load prompt_configs:', error.message)
    return
  }

  for (const row of data || []) {
    if (!row.r2_path) continue
    try {
      _cache[row.key] = await fetchFromR2(row.r2_path)
      console.log(`[promptService] Loaded "${row.key}" from R2: ${row.r2_path}`)
    } catch (err) {
      console.warn(`[promptService] Failed to load "${row.key}" from R2 (${row.r2_path}): ${err.message}`)
    }
  }
}

function ensureLoaded() {
  if (!_loadPromise) _loadPromise = _loadAllPrompts()
  return _loadPromise
}

async function getPrompt(key) {
  await ensureLoaded()
  if (_cache[key]) return _cache[key]
  const fallback = FALLBACK_MAP[key]?.()
  if (!fallback) console.warn(`[promptService] No prompt found for key "${key}"`)
  return fallback || ''
}

function invalidatePrompts() {
  _cache = {}
  _loadPromise = null
}

module.exports = { getPrompt, invalidatePrompts }
