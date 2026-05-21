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
  modeling_characters:  () => require('../prompts/modeling.prompt').MODELING_SYSTEM_PROMPT,
  environments:         () => require('../prompts/environments.prompt').ENVIRONMENTS_SYSTEM_PROMPT,
  props:                () => require('../prompts/props.prompt').PROPS_SYSTEM_PROMPT,
  modeling_environments:() => require('../prompts/modeling_environments.prompt').MODELING_ENVIRONMENTS_SYSTEM_PROMPT,
  modeling_props:       () => require('../prompts/modeling_props.prompt').MODELING_PROPS_SYSTEM_PROMPT,
  charaters:            () => require('../prompts/characters3d.prompt').CHARACTERS3D_SYSTEM_PROMPT,
  image_reference:      () => require('../prompts/image_reference.prompt').IMAGE_REFERENCE_PROMPT_TEMPLATE,
  vfx:                  () => require('../prompts/vfx.prompt').VFX_SYSTEM_PROMPT,
  texturing:            () => require('../prompts/texturing.prompt').TEXTURING_SYSTEM_PROMPT,
  rigging:              () => require('../prompts/rigging.prompt').RIGGING_SYSTEM_PROMPT,
  lighting:             () => require('../prompts/lighting.prompt').LIGHTING_SYSTEM_PROMPT,
  animation:            () => require('../prompts/animation.prompt').ANIMATION_SYSTEM_PROMPT,
  cinematics:           () => require('../prompts/cinematics.prompt').CINEMATICS_SYSTEM_PROMPT,
  voice:                () => require('../prompts/voice.prompt').VOICE_SYSTEM_PROMPT,
  validation:           () => require('../prompts/validation.prompt').VALIDATION_SYSTEM_PROMPT,
  gen_idea:             () => require('../prompts/gen_idea.prompt').GEN_IDEA_SYSTEM_PROMPT,
  idtn_generate_concepts:   () => require('../prompts/idtn_generate_concepts.prompt').IDTN_GENERATE_CONCEPTS_SYSTEM_PROMPT,
  idtn_score_rank:          () => require('../prompts/idtn_score_rank.prompt').IDTN_SCORE_RANK_SYSTEM_PROMPT,
  idtn_surface_candidates:  () => require('../prompts/idtn_surface_candidates.prompt').IDTN_SURFACE_CANDIDATES_SYSTEM_PROMPT,
  rules:                () => null,
  '00a_idea_expansion': () => null,
  '00b_direction_lock': () => null,
  playtesting:          () => null,
}

// Cache por clave: { [step_key]: string }
// Las claves en curso de carga usan una Promise para evitar fetches dobles simultáneos
let _cache = {}
let _inflight = {}

async function fetchFromR2(r2Path) {
  const bucket = process.env.CF_R2_PROMPTS_BUCKET
  if (!bucket) throw new Error('CF_R2_PROMPTS_BUCKET is not set')
  const client = getR2Client()
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: r2Path }))
  return res.Body.transformToString('utf-8')
}

async function _loadOne(key) {
  const { db } = require('./supabase.service')
  const { data, error } = await db()
    .from('step_configs')
    .select('prompt_r2_path')
    .eq('step_key', key)
    .maybeSingle()

  if (error) {
    console.warn(`[promptService] DB error for "${key}":`, error.message)
    return null
  }

  const r2Path = data?.prompt_r2_path
  if (!r2Path) return null

  try {
    const text = await fetchFromR2(r2Path)
    console.log(`[promptService] Loaded "${key}" from R2: ${r2Path}`)
    return text
  } catch (err) {
    console.warn(`[promptService] Failed to load "${key}" from R2 (${r2Path}): ${err.message}`)
    return null
  }
}

async function getPrompt(key) {
  // Cache hit
  if (_cache[key] !== undefined) {
    console.log(`[promptService] getPrompt("${key}") → cache (${_cache[key]?.length ?? 0} chars)`)
    return _cache[key] || ''
  }

  // Evitar fetches dobles simultáneos para la misma clave
  if (!_inflight[key]) {
    _inflight[key] = _loadOne(key).then(text => {
      delete _inflight[key]
      return text
    })
  }

  const r2Text = await _inflight[key]

  let finalText = r2Text
  if (r2Text) {
    console.log(`[promptService] getPrompt("${key}") → R2 (${r2Text.length} chars)`)
  } else {
    // Fallback local
    const fallback = FALLBACK_MAP[key]?.()
    if (!fallback) console.warn(`[promptService] No prompt found for key "${key}"`)
    else console.log(`[promptService] getPrompt("${key}") → fallback local`)
    finalText = fallback || ''
  }

  // Cachear el resultado final (R2 o fallback) para que el segundo llamado también funcione
  _cache[key] = finalText
  return finalText
}

function invalidatePrompts() {
  _cache = {}
  _inflight = {}
}

module.exports = { getPrompt, invalidatePrompts }
