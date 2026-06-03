const express = require('express')
const router = express.Router()
const { db } = require('../services/supabase.service')

// GET /api/assets?project_id=&step_key=
router.get('/', async (req, res, next) => {
  try {
    const { project_id, step_key } = req.query

    const includeRefs = !step_key || step_key === 'image_reference'
    const includeRegular = !step_key || step_key !== 'image_reference'

    // Regular assets
    let assets = []
    if (includeRegular) {
      let query = db()
        .from('assets')
        .select('*, asset_versions!asset_versions_asset_id_fkey(*), projects!assets_project_id_fkey(id, name)')
        .order('created_at', { ascending: false })
        .limit(300)

      if (project_id) query = query.eq('project_id', project_id)
      if (step_key)   query = query.eq('step_key', step_key)

      const { data, error } = await query
      if (error) return res.status(500).json({ success: false, error: 'Failed to fetch assets', code: 'SUPABASE_ERROR' })
      assets = data || []
    }

    // Image reference assets — incluye cadena de refinamientos via refined_from_id
    let refAssets = []
    if (includeRefs) {
      // Traer todos los refs del proyecto para poder construir cadenas
      let refQuery = db()
        .from('character_image_refs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500)

      if (project_id) refQuery = refQuery.eq('project_id', project_id)

      const { data: allRefs } = await refQuery
      const refsById = Object.fromEntries((allRefs || []).map(r => [r.id, r]))

      // Solo los seleccionados son el "asset principal"
      const selectedRefs = (allRefs || []).filter(r => r.selected)

      refAssets = selectedRefs.map(r => {
        // Construir cadena de ancestros: actual → padre → abuelo → ...
        const chain = []
        let cur = r
        while (cur) {
          chain.push(cur)
          cur = cur.refined_from_id ? refsById[cur.refined_from_id] : null
        }

        const versions = chain.map((ref, i) => ({
          id:             `ref_v_${ref.id}`,
          asset_id:       `ref_${r.id}`,
          version_number: chain.length - i,
          source:         'image_reference',
          storage_url:    ref.image_url,
          is_current:     i === 0,
          created_at:     ref.created_at,
          metadata:       { character_key: ref.character_key, round: ref.round, refined_from_id: ref.refined_from_id },
        }))

        return {
          id:             `ref_${r.id}`,
          project_id:     r.project_id,
          step_key:       'image_reference',
          name:           `Global ref · round ${r.round}`,
          type:           'image',
          discipline:     'reference',
          review_status:  'approved',
          created_at:     r.created_at,
          job_id:         null,
          projects:       null,
          asset_versions: versions,
        }
      })
    }

    res.json({ success: true, assets: [...assets, ...refAssets] })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/assets/:id/review
router.patch('/:id/review', async (req, res, next) => {
  try {
    const { id } = req.params
    const { action, notes, member_id } = req.body

    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action must be approve or reject', code: 'VALIDATION_ERROR' })
    }
    if (action === 'reject' && !notes) {
      return res.status(400).json({ success: false, error: 'notes is required when rejecting', code: 'VALIDATION_ERROR' })
    }

    const { data: existing, error: fErr } = await db().from('assets').select('id').eq('id', id).single()
    if (fErr || !existing) {
      return res.status(404).json({ success: false, error: 'Asset not found', code: 'NOT_FOUND' })
    }

    const update = {
      review_status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: member_id || null,
      reviewed_at: new Date().toISOString()
    }
    if (notes) update.review_notes = notes

    const { data: asset, error: uErr } = await db()
      .from('assets')
      .update(update)
      .eq('id', id)
      .select()
      .single()

    if (uErr) {
      return res.status(500).json({ success: false, error: 'Failed to update asset', code: 'SUPABASE_ERROR' })
    }

    res.json({ success: true, asset })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/assets/project-assets?project_id=xxx ───────────────────────────
// Lista unificada: forge_assets (nuevo) + assets legacy, normalizados.
// project_id es opcional — sin él trae todos los proyectos.
router.get('/project-assets', async (req, res, next) => {
  try {
    const { project_id } = req.query

    // ── forge_assets ──────────────────────────────────────────────────────────
    let forgeQuery = db()
      .from('forge_assets')
      .select(`
        id, name, format, status, storage_url, content, approved_at, created_at,
        node_id, project_id,
        forge_nodes ( node_key, title, phase )
      `)
      .order('approved_at', { ascending: false, nullsFirst: false })

    if (project_id) forgeQuery = forgeQuery.eq('project_id', project_id)

    const { data: forgeAssets } = await forgeQuery

    // Versiones de forge_assets
    const forgeAssetIds = (forgeAssets || []).map(a => a.id)
    let forgeVersionsMap = {}
    if (forgeAssetIds.length > 0) {
      const { data: fv } = await db()
        .from('forge_asset_versions')
        .select('id, asset_id, storage_url, version_number, is_current, metadata, created_at')
        .in('asset_id', forgeAssetIds)
        .order('version_number', { ascending: false })
      for (const v of (fv || [])) {
        if (!forgeVersionsMap[v.asset_id]) forgeVersionsMap[v.asset_id] = []
        forgeVersionsMap[v.asset_id].push(v)
      }
    }

    const forgeNormalized = (forgeAssets || []).map(a => ({
      id:          a.id,
      source:      'forge',
      name:        a.name,
      project_id:  a.project_id ?? null,
      node_key:    a.forge_nodes?.node_key ?? null,
      node_title:  a.forge_nodes?.title    ?? null,
      phase:       a.forge_nodes?.phase    ?? null,
      format:      a.format,
      status:      a.status,
      storage_url: a.storage_url ?? null,
      content:     a.content     ?? null,
      created_at:  a.approved_at ?? a.created_at,
      versions:    (forgeVersionsMap[a.id] || []).map(v => ({
        id:             v.id,
        storage_url:    v.storage_url,
        version_number: v.version_number,
        is_current:     v.is_current,
        model_used:     v.metadata?.model_used ?? null,
        created_at:     v.created_at,
      })),
    }))

    // ── assets legacy ─────────────────────────────────────────────────────────
    let legacyQuery = db()
      .from('assets')
      .select(`
        id, name, step_key, review_status, created_at, project_id,
        asset_versions ( id, storage_url, version_number, is_current, model_used, created_at )
      `)
      .order('created_at', { ascending: false })

    if (project_id) legacyQuery = legacyQuery.eq('project_id', project_id)

    const { data: legacyAssets } = await legacyQuery

    const imageSteps = new Set(['sprites','characters','charaters','concept_art','backgrounds','icons','hud','splash_art','marketing','image_reference','visual_guide'])
    const audioSteps = new Set(['audio','sfx','voice'])
    const codeSteps  = new Set(['code'])
    const modelSteps = new Set(['modeling_characters','modeling_environments','modeling_props','modeling'])

    function legacyFormat(step_key) {
      if (imageSteps.has(step_key)) return 'image'
      if (audioSteps.has(step_key)) return 'audio'
      if (codeSteps.has(step_key))  return 'code'
      if (modelSteps.has(step_key)) return 'model_3d'
      return 'document'
    }

    const legacyNormalized = (legacyAssets || []).map(a => ({
      id:          a.id,
      source:      'legacy',
      name:        a.name,
      project_id:  a.project_id ?? null,
      node_key:    a.step_key,
      node_title:  a.step_key,
      phase:       null,
      format:      legacyFormat(a.step_key),
      status:      a.review_status,
      storage_url: (a.asset_versions?.find(v => v.is_current) ?? a.asset_versions?.[0])?.storage_url ?? null,
      content:     null,
      created_at:  a.created_at,
      versions:    (a.asset_versions || [])
        .sort((x, y) => y.version_number - x.version_number)
        .map(v => ({
          id:             v.id,
          storage_url:    v.storage_url,
          version_number: v.version_number,
          is_current:     v.is_current,
          model_used:     v.model_used ?? null,
          created_at:     v.created_at,
        })),
    }))

    // ── imágenes generadas on-demand (forge_sessions.output_images) ─────────────
    // Se excluyen URLs que ya están en forge_assets (PNGs aprobados) para evitar duplicados
    const approvedPngUrls = new Set(
      (forgeAssets || []).filter(a => a.format === 'png' && a.storage_url).map(a => a.storage_url)
    )

    let sessionsQuery = db()
      .from('forge_sessions')
      .select('id, project_id, node_id, status, created_at, output_images, forge_nodes(node_key, title, phase)')
      .not('output_images', 'is', null)

    if (project_id) sessionsQuery = sessionsQuery.eq('project_id', project_id)

    const { data: sessions } = await sessionsQuery

    const generatedNormalized = []

    for (const session of (sessions || [])) {
      const raw = session.output_images
      if (!raw || typeof raw !== 'object') continue

      const nodeKey   = session.forge_nodes?.node_key ?? null
      const nodeTitle = session.forge_nodes?.title    ?? null
      const nodePhase = session.forge_nodes?.phase    ?? null

      for (const [outputKey, items] of Object.entries(raw)) {
        if (!Array.isArray(items)) continue

        for (const item of items) {
          // Soporta formato viejo { image_url } y nuevo { variations[] }
          const variations = Array.isArray(item.variations)
            ? item.variations
            : item.image_url ? [{ url: item.image_url, condition: null }] : []

          variations.forEach((v, varIdx) => {
            if (!v.url || approvedPngUrls.has(v.url)) return

            const label = v.condition ? ` (${v.condition})` : ''
            generatedNormalized.push({
              id:          `${session.id}_${outputKey}_${item.index}_${varIdx}`,
              source:      'generated',
              name:        `${nodeTitle ?? nodeKey ?? 'Node'} — ${outputKey} #${(item.index ?? 0) + 1}${label}`,
              project_id:  session.project_id ?? null,
              node_key:    nodeKey,
              node_title:  nodeTitle,
              phase:       nodePhase,
              format:      'image',
              status:      'generated',
              storage_url: v.url,
              content:     null,
              created_at:  session.created_at,
              versions:    [],
            })
          })
        }
      }
    }

    const unified = [...forgeNormalized, ...legacyNormalized, ...generatedNormalized]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    res.json({ success: true, assets: unified })
  } catch (err) { next(err) }
})

module.exports = router
