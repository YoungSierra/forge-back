const express    = require('express')
const router     = express.Router()
const { db }     = require('../services/supabase.service')
const { callLLM } = require('../services/llm.service')

// Catalogo derivado de los 3 templates del frontend (template_2d, template_3d, template_2d_t).
// Debe mantenerse sincronizado con lib/templates/*.json — mismos ids, labels y descripciones.
const PIPELINE_CATALOG = [
  // ── Concept ──────────────────────────────────────────────────────────
  { nodeId: 'visual_guide',         phase: 'concept',     label: 'Visual Guide',         description: 'Art direction, palette & style rules' },
  { nodeId: 'art_direction_intake', phase: 'concept',     label: 'Art Direction Intake',  description: 'Art intake brief, references & style directives' },
  { nodeId: 'concept_art',          phase: 'concept',     label: 'Concept Art',          description: 'Character & world concept sketches' },
  { nodeId: 'image_reference',      phase: 'concept',     label: 'Image Reference',      description: 'Visual reference sheet — T-pose renders per character' },
  // ── Characters ───────────────────────────────────────────────────────
  { nodeId: 'sprites',              phase: 'characters',  label: 'Sprites',              description: 'Character & object sprite sheets' },
  { nodeId: 'charaters',            phase: 'characters',  label: 'Characters',           description: 'Character models & blend shapes' },
  // ── World ────────────────────────────────────────────────────────────
  { nodeId: 'backgrounds',          phase: 'world',       label: 'Backgrounds',          description: 'Parallax background layers' },
  { nodeId: 'environments',          phase: 'world',       label: 'Environments',         description: 'Environment art direction & concept for 3D scenes' },
  { nodeId: 'props',                phase: 'world',       label: 'Props',                description: 'Props & objects art direction for 3D production' },
  { nodeId: 'modeling_characters',  phase: 'world',       label: 'Modeling (Characters)',description: '3D character meshes from renders' },
  { nodeId: 'modeling_environments',phase: 'world',       label: 'Modeling (Envs)',      description: '3D environment and scenario meshes' },
  { nodeId: 'modeling_props',       phase: 'world',       label: 'Modeling (Props)',     description: '3D prop and object meshes' },
  { nodeId: 'texturing',            phase: 'world',       label: 'Texturing',            description: 'PBR materials, UV unwrapping & baking' },
  { nodeId: 'rigging',              phase: 'world',       label: 'Rigging',              description: 'Skeleton setup & weight painting' },
  { nodeId: 'lighting',             phase: 'world',       label: 'Lighting',             description: 'Scene lighting, GI & lightmap baking' },
  { nodeId: 'animation',            phase: 'world',       label: 'Animation',            description: 'Keyframe & procedural character animation' },
  { nodeId: 'vfx',                  phase: 'world',       label: 'VFX',                  description: 'Particles, shaders & real-time FX' },
  { nodeId: 'cinematics',           phase: 'world',       label: 'Cinematics',           description: 'Cutscenes, cameras & sequenced events' },
  { nodeId: 'level_design',         phase: 'world',       label: 'Level Design',         description: 'Tilemaps, layouts & encounter design' },
  // ── Production ───────────────────────────────────────────────────────
  { nodeId: 'uiux',                 phase: 'production',  label: 'UI/UX',                description: 'Menus, buttons & user flows' },
  { nodeId: 'icons',                phase: 'production',  label: 'Icons',                description: 'Items, pickups & status icons' },
  { nodeId: 'hud',                  phase: 'production',  label: 'HUD',                  description: 'Health bars, score & overlays' },
  { nodeId: 'splash_art',           phase: 'production',  label: 'Splash Art',           description: 'Title screen, loading & key art' },
  { nodeId: 'marketing',            phase: 'production',  label: 'Marketing',            description: 'Store banners, social & promotional art' },
  { nodeId: 'source_code',          phase: 'production',  label: 'Source Code',          description: 'Game logic & engine integration' },
  { nodeId: 'music',                phase: 'production',  label: 'Music',                description: 'Adaptive soundtrack & seamless loops' },
  { nodeId: 'sfx',                  phase: 'production',  label: 'SFX',                  description: 'Feedback sounds, hits & ambience' },
  { nodeId: 'voice',                phase: 'production',  label: 'Voice Acting',         description: 'Dialogue recording & character voices' },
  { nodeId: 'playtesting',          phase: 'production',  label: 'Playtesting',          description: 'QA sessions, bug reports & balance' },
]

// POST /api/projects/:id/suggest-pipeline
router.post('/:id/suggest-pipeline', async (req, res, next) => {
  try {
    const { data: project, error } = await db()
      .from('projects')
      .select('id, concept')
      .eq('id', req.params.id)
      .single()

    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    // Si ya hay config guardada y no se fuerza re-análisis, devolverla sin llamar a la IA
    const savedConfig = project.concept?.pipeline_config
    if (savedConfig?.active_nodes && req.query.force !== 'true') {
      const suggestions = PIPELINE_CATALOG.map(n => ({
        nodeId: n.nodeId,
        active: savedConfig.active_nodes.includes(n.nodeId),
        reason: '',
      }))
      return res.json({ success: true, suggestions, catalog: PIPELINE_CATALOG, from_cache: true })
    }

    const gdd  = project.concept?.pipeline?.gdd || project.concept?.gdd || {}
    const proj = gdd.project || {}
    const art  = gdd.art_direction || {}

    // Resumen del GDD para el prompt de la IA
    const gddSummary = [
      proj.name             ? `Name: ${proj.name}`                                                                                      : '',
      proj.genre            ? `Genre: ${proj.genre}`                                                                                    : '',
      proj.target_platform  ? `Platform: ${proj.target_platform}`                                                                       : '',
      proj.elevator_pitch   ? `Concept: ${proj.elevator_pitch}`                                                                         : '',
      proj.tone             ? `Tone: ${proj.tone}`                                                                                      : '',
      proj.core_loop        ? `Core loop: ${proj.core_loop}`                                                                            : '',
      art.style             ? `Visual style: ${art.style}`                                                                              : '',
      gdd.characters?.length ? `Characters: ${gdd.characters.length} (${gdd.characters.map(c => `${c.name} (${c.role})`).join(', ')})` : '',
      gdd.levels?.length    ? `Levels: ${gdd.levels.length}`                                                                           : '',
      proj.design_pillars?.length ? `Design pillars: ${proj.design_pillars.join(', ')}`                                                : '',
    ].filter(Boolean).join('\n')

    const catalogList = PIPELINE_CATALOG.map(n =>
      `- ${n.nodeId} | ${n.label} | ${n.description}`
    ).join('\n')

    const system = `You are a senior AAA game producer with 15 years of experience.
You analyze Game Design Documents and determine which production pipeline nodes are needed to achieve maximum quality given the game's scope and vision.`

    const userMsg = `Analyze this GDD and determine which production pipeline nodes should be activated.

GDD:
${gddSummary}

Available nodes (nodeId | name | description):
${catalogList}

Respond ONLY with valid JSON, no markdown, no explanations outside the JSON:
{
  "suggestions": [
    { "nodeId": "...", "active": true/false, "reason": "brief reason in English (max 12 words)" }
  ]
}

Include ALL nodes from the catalog. Be precise: only activate what genuinely adds value for this specific game.`

    const result = await callLLM(system, userMsg, { maxOutputTokens: 1500, temperature: 0.3 })

    // callLLM devuelve { data: <objeto parseado>, meta: {...} }
    const parsed = result.data
    if (!parsed?.suggestions) return res.status(500).json({ success: false, error: 'AI did not return valid suggestions' })

    res.json({ success: true, suggestions: parsed.suggestions, catalog: PIPELINE_CATALOG })
  } catch (err) { next(err) }
})

// PATCH /api/projects/:id/pipeline-config — guarda la configuracion elegida
router.patch('/:id/pipeline-config', async (req, res, next) => {
  try {
    const { active_nodes } = req.body
    if (!Array.isArray(active_nodes)) {
      return res.status(400).json({ success: false, error: 'active_nodes must be an array' })
    }

    const { data: project, error } = await db()
      .from('projects')
      .select('id, concept')
      .eq('id', req.params.id)
      .single()

    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const updated = {
      ...project.concept,
      pipeline_config: { active_nodes, configured_at: new Date().toISOString() },
    }

    await db().from('projects').update({ concept: updated }).eq('id', req.params.id)

    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
