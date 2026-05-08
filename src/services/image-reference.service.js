const { db }                  = require('./supabase.service')
const { getStepConfig, getWorkflowById } = require('./config.service')
const { generateImageFal }    = require('./image.service')
const { generateImageOpenAI } = require('./providers/openai.image.provider')
const { generateImageComfyUI } = require('./providers/comfyui.provider')

const MAX_POOL      = parseInt(process.env.IMAGE_REF_MAX_POOL     || '20')
const DEFAULT_COUNT = parseInt(process.env.IMAGE_REF_DEFAULT_COUNT || '5')
const GLOBAL_KEY    = 'global'

function buildGlobalPrompt(gdd) {
  const proj = gdd.project || {}
  const art  = gdd.art_direction || {}

  // Concept block: genre/platform + elevator pitch + core loop + tone
  const conceptParts = []
  const genreLine = [proj.genre, proj.target_platform].filter(Boolean).join(', ')
  if (genreLine) conceptParts.push(genreLine)
  if (proj.elevator_pitch || proj.description) conceptParts.push(proj.elevator_pitch || proj.description)
  if (proj.core_loop) conceptParts.push(`Core mechanics: ${proj.core_loop}`)
  if (proj.tone) conceptParts.push(`Tone: ${proj.tone}`)
  const concept = conceptParts.filter(Boolean).join('. ') || proj.name || 'game character'

  // Character types: pull sprite_prompt + description from GDD characters so the AI
  // knows what kind of beings to draw (e.g. anthropomorphic animals, not humans)
  const chars = gdd.characters || []
  const charLines = chars
    .slice(0, 4)
    .map(c => [c.name, c.sprite_prompt || c.description].filter(Boolean).join(': '))
    .filter(Boolean)
  const charTypes = charLines.length ? `Character types: ${charLines.join(' | ')}` : ''

  // Visual style block
  const styleParts = [art.style, art.lighting_style].filter(Boolean)
  const style = styleParts.join(', ') || 'stylized game character design'

  // Color palette
  const palette = [art.palette].filter(Boolean).join(', ')

  // Optional themes from design pillars / player motivation
  const themeParts = [
    proj.player_motivation,
    Array.isArray(proj.design_pillars) && proj.design_pillars.length ? proj.design_pillars.join(', ') : null,
  ].filter(Boolean)
  const theme = themeParts.join('. ')

  // References
  const refs = Array.isArray(art.references) && art.references.length ? `Visual references: ${art.references.join(', ')}` : ''

  return `Create a new character based on the following concept: ${concept}.
${charTypes ? `\n${charTypes}.` : ''}
Visual style: ${style}.${palette ? `\nColor palette: ${palette}.` : ''}${theme ? `\nOptional context / role / theme: ${theme}.` : ''}${refs ? `\n${refs}.` : ''}

The character must be designed with a highly cohesive and internally consistent visual identity, as if it belongs to a single polished stylized universe. The design must feel unified in proportions, form language, silhouette, materials, color, lighting, and finish.

Respect these character construction rules:
- consistent proportions between head, torso, arms, and legs
- clear and readable silhouette
- unified shape language
- controlled stylization
- clean and intentional design
- consistent material treatment
- harmonious color palette
- polished render quality

Maintain strict consistency in:
- head, body, and limb scale
- shape language (curves vs. angles)
- level of simplification
- silhouette clarity
- color palette and chromatic harmony
- material treatment
- lighting and render style
- stylization level

The visual style must follow this direction consistently:
- preserve the intended style described in Visual style
- ensure the character fully reflects that style in proportions, shape language, materials, rendering, and finish
- do not deviate into a different aesthetic language
- do not mix unrelated visual influences

Do not make the character more realistic or more cartoonish than the rest of the design.
Do not mix different visual languages.
Do not introduce unrelated stylistic influences.

The character MUST be in a strict T-pose:
front-facing, perfectly centered, arms fully extended horizontally at shoulder height, straight and symmetrical, no bending, no rotation, no gesture, no variation in pose.

The body must remain upright, rigid, and fully aligned, with a neutral stance and identical left and right balance.

The background MUST be pure white, completely clean and seamless, with no gradients, no environment, no props, and no additional elements.
Only a very subtle grounding shadow under the feet is allowed.

The final result must feel like a production-ready character design from one single consistent visual universe.`
}

async function generateRound(projectId, gdd, count = DEFAULT_COUNT) {
  const n = Math.min(count, 10)

  const { count: existing } = await db()
    .from('character_image_refs')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('character_key', GLOBAL_KEY)

  if ((existing || 0) >= MAX_POOL) {
    throw new Error(`Pool limit of ${MAX_POOL} images reached. Approve current selection to continue.`)
  }

  const available = Math.min(n, MAX_POOL - (existing || 0))
  const prompt    = buildGlobalPrompt(gdd)
  const config    = await getStepConfig('image_reference')

  const { data: lastRound } = await db()
    .from('character_image_refs')
    .select('round')
    .eq('project_id', projectId)
    .eq('character_key', GLOBAL_KEY)
    .order('round', { ascending: false })
    .limit(1)
  const nextRound = (lastRound?.[0]?.round || 0) + 1

  const generated = []
  for (let i = 0; i < available; i++) {
    const storagePath = `projects/${projectId}/image_reference/global/r${nextRound}_${Date.now()}_${i}.jpg`
    let result

    const imgType = config?.image_integration_type

    if (imgType === 'comfyui' && config?.image_workflow_id) {
      const workflow = await getWorkflowById(config.image_workflow_id)
      if (!workflow) throw new Error(`ComfyUI workflow not found: ${config.image_workflow_id}`)
      result = await generateImageComfyUI(workflow.name, prompt, 1024, 1024, storagePath)
    } else if (imgType === 'llm' && config?.image_model) {
      const [provider, ...parts] = config.image_model.split(':')
      const modelId = parts.join(':')
      if (provider === 'openai') {
        result = await generateImageOpenAI(modelId, prompt, 1024, 1024, storagePath)
      } else if (provider === 'fal') {
        result = await generateImageFal(prompt, 1024, 1024, storagePath)
      } else {
        throw new Error(`Unknown image provider "${provider}"`)
      }
    } else {
      throw new Error('image_reference step config missing or incomplete — configure image integration in Admin → Integrations')
    }

    generated.push({ image_url: result.url, storage_path: storagePath, round: nextRound })
    console.log(`[image-reference] Generated global ref ${storagePath} round ${nextRound}`)
  }

  const { data, error } = await db()
    .from('character_image_refs')
    .insert(generated.map(g => ({
      project_id:    projectId,
      character_key: GLOBAL_KEY,
      image_url:     g.image_url,
      storage_path:  g.storage_path,
      round:         g.round,
      selected:      false,
    })))
    .select()

  if (error) throw new Error(`Failed to save image refs: ${error.message}`)
  return data
}

async function getPool(projectId) {
  const { data, error } = await db()
    .from('character_image_refs')
    .select('*')
    .eq('project_id', projectId)
    .eq('character_key', GLOBAL_KEY)
    .order('round', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to get pool: ${error.message}`)
  return data || []
}

async function approveSelection(projectId, selectedIds) {
  if (!Array.isArray(selectedIds) || selectedIds.length !== 2) {
    throw new Error('Exactly 2 images must be selected')
  }

  const { data: all, error } = await db()
    .from('character_image_refs')
    .select('*')
    .eq('project_id', projectId)
    .eq('character_key', GLOBAL_KEY)

  if (error || !all?.length) throw new Error('No images found in pool')

  const validIds = new Set(all.map(r => r.id))
  const invalid  = selectedIds.filter(id => !validIds.has(id))
  if (invalid.length) throw new Error(`Invalid image ids: ${invalid.join(', ')}`)

  await db().from('character_image_refs').update({ selected: true  }).in('id', selectedIds)

  const toDeselect = all.filter(r => !selectedIds.includes(r.id)).map(r => r.id)
  if (toDeselect.length) {
    await db().from('character_image_refs').update({ selected: false }).in('id', toDeselect)
  }

  return all.map(r => ({ ...r, selected: selectedIds.includes(r.id) }))
}

async function getGlobalStatus(projectId) {
  const { data, count: total } = await db()
    .from('character_image_refs')
    .select('*', { count: 'exact' })
    .eq('project_id', projectId)
    .eq('character_key', GLOBAL_KEY)

  const rows         = data || []
  const selectedCount = rows.filter(r => r.selected).length
  const rounds       = new Set(rows.map(r => r.round)).size
  const status       = selectedCount >= 2 ? 'approved' : rows.length > 0 ? 'pending' : 'empty'

  return {
    total_images:   total || 0,
    selected_count: selectedCount,
    rounds,
    status,
    at_pool_limit:  (total || 0) >= MAX_POOL,
  }
}

async function getSelectedRefs(projectId) {
  const { data, error } = await db()
    .from('character_image_refs')
    .select('*')
    .eq('project_id', projectId)
    .eq('character_key', GLOBAL_KEY)
    .eq('selected', true)
    .order('created_at')

  if (error) throw new Error(`Failed to get selected refs: ${error.message}`)
  return data || []
}

module.exports = { generateRound, getPool, approveSelection, getGlobalStatus, getSelectedRefs, MAX_POOL, DEFAULT_COUNT, buildGlobalPrompt }
