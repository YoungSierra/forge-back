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

// ─── GET /api/assets/:id/content ─────────────────────────────────────────────
// El texto completo de UN documento. El listado del moodboard va sin `content` a propósito
// —son ~1,4 MB de texto que la galería no muestra— así que el detalle lo pide cuando hace
// falta, de a uno. Sirve tanto para un output del pipeline como para algo subido a la librería.
router.get('/:id/content', async (req, res, next) => {
  try {
    const { id } = req.params

    const { data: forge } = await db()
      .from('forge_assets')
      .select('name, content, format')
      .eq('id', id)
      .maybeSingle()
    if (forge?.content) {
      return res.json({ success: true, name: forge.name, format: forge.format, content: forge.content })
    }

    const { data: lib } = await db()
      .from('forge_project_library_assets')
      .select('display_name, file_name, extracted_text, mime_type')
      .eq('id', id)
      .maybeSingle()
    if (lib?.extracted_text) {
      return res.json({
        success: true,
        name: lib.display_name || lib.file_name,
        format: /markdown/.test(lib.mime_type || '') ? 'markdown' : 'document',
        content: lib.extracted_text,
      })
    }

    res.status(404).json({ success: false, error: 'No content for this asset', code: 'NOT_FOUND' })
  } catch (err) { next(err) }
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

// ─── Tema visual del proyecto ────────────────────────────────────────────────
// El moodboard se pinta con la identidad del proyecto cuando existe. Hoy la única fuente real
// es la paleta bloqueada que emite el 3.9 dentro del style_guide, en prosa; se extraen sus hex.
// Si el proyecto todavía no llegó a tener dirección de arte, se devuelve el tema neutro y el
// moodboard se ve sobrio en vez de disfrazado de otro juego.
//
// `motion` es el arquetipo de animación. Todavía no hay de dónde deducirlo, así que siempre
// sale 'neutral'; cuando exista el campo por proyecto se resuelve acá y el front no cambia.
const NEUTRAL_THEME = { accent: '#7d8493', colors: ['#7d8493'], motion: 'neutral', source: 'default' }

// El asomo de un documento viaja como MARKDOWN CRUDO, no como texto pelado. La miniatura y el
// detalle lo renderizan con el mismo componente, así el documento se ve igual desde el primer
// momento y no hay salto de "texto ilegible" a "markdown" cuando llega el contenido completo.
//
// Se corta en un límite de línea y se descartan los bloques que quedarían partidos: media tabla
// o un fence de código sin cerrar se renderizan peor que no estar.
function recortarMd(texto, tope = 900) {
  const t = String(texto || '').trim()
  if (!t) return null
  if (t.length <= tope) return t

  let corte = t.slice(0, tope)
  corte = corte.slice(0, Math.max(corte.lastIndexOf('\n'), 1))   // hasta el último salto entero

  const lineas = corte.split('\n')
  // Una tabla necesita cabecera + separador para renderizar; si el corte la dejó a medias, fuera.
  while (lineas.length && /^\s*\|/.test(lineas[lineas.length - 1])) {
    const quedan = lineas.filter(l => /^\s*\|/.test(l)).length
    if (quedan > 2) break
    lineas.pop()
  }
  // Fence de código impar = quedó abierto.
  if ((lineas.join('\n').match(/```/g) || []).length % 2) lineas.push('```')

  return lineas.join('\n').trim() || null
}

async function resolveProjectTheme(projectId) {
  if (!projectId) return NEUTRAL_THEME
  try {
    const { data } = await db()
      .from('forge_assets')
      .select('name, content, forge_nodes(node_key)')
      .eq('project_id', projectId)
      .in('status', ['approved', 'auto_approved'])
      .not('content', 'is', null)
      .order('created_at', { ascending: false })

    // El style_guide es la fuente canónica de la paleta; el resto del ADI sirve de respaldo.
    const isGuide = a => /style\s*guide/i.test(a.name || '')
    const art     = (data || []).filter(a => a.forge_nodes?.node_key === '3.9')
    const src     = art.find(isGuide) || art[0]
    if (!src?.content) return NEUTRAL_THEME

    // Se prioriza la zona de la paleta: ahí los hex son los roles, no ejemplos sueltos.
    const i     = src.content.search(/color\s+language|closed\s+palette|§\s*0\.4/i)
    const scope = i >= 0 ? src.content.slice(i, i + 2500) : src.content.slice(0, 4000)
    const hexes = [...new Set((scope.match(/#[0-9A-Fa-f]{6}\b/g) || []).map(h => h.toUpperCase()))]
    if (hexes.length < 2) return NEUTRAL_THEME

    // El acento es el color con más luz: el primero suele ser el fondo oscuro del documento.
    const lum = h => {
      const n = parseInt(h.slice(1), 16)
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
    }
    const palette = hexes.slice(0, 6)
    const accent  = [...palette].sort((a, b) => lum(b) - lum(a))[0]

    return { accent, colors: palette, motion: 'neutral', source: 'style_guide' }
  } catch {
    return NEUTRAL_THEME   // el tema es decoración: nunca debe romper el listado
  }
}

// ─── GET /api/assets/project-assets?project_id=xxx ───────────────────────────
// Lista unificada: forge_assets (nuevo) + assets legacy, normalizados.
// project_id es opcional — sin él trae todos los proyectos.
router.get('/project-assets', async (req, res, next) => {
  try {
    const { project_id } = req.query
    // `media=1` — vista visual (moodboard): solo activos que se ven, y sin traer `content`.
    // Un documento de este proyecto pesa hasta 109 KB en ese campo; el listado completo son
    // ~1,4 MB de texto que la galería nunca muestra. Con el filtro, viaja el metadato y la URL.
    const mediaOnly = req.query.media === '1' || req.query.media === 'true'
    // Los documentos entran al moodboard porque tienen su propia pestaña (Docs), pero SIEMPRE
    // sin el campo `content`: lo que pesaba era el texto, no la fila.
    const MEDIA_FORMATS = ['image', 'png', 'jpg', 'jpeg', 'model_3d', 'glb', 'video', 'mp4', 'audio']
    const DOC_FORMATS   = ['document', 'docx', 'pdf', 'pptx']

    // ── forge_assets ──────────────────────────────────────────────────────────
    let forgeQuery = db()
      .from('forge_assets')
      .select(`
        id, name, format, status, storage_url, ${mediaOnly ? '' : 'content,'} approved_at, created_at,
        node_id, project_id,
        forge_nodes ( node_key, title, phase )
      `)
      .order('approved_at', { ascending: false, nullsFirst: false })

    if (mediaOnly) forgeQuery = forgeQuery.in('format', [...MEDIA_FORMATS, ...DOC_FORMATS])

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

    // La tarjeta de un documento muestra sus primeras líneas, así que en modo media hace falta
    // un asomo del texto — pero solo de los documentos. Se pide en una consulta aparte y no la
    // primera para que las imágenes, los modelos y el video no arrastren texto que nadie mira.
    let previewMap = {}
    if (mediaOnly) {
      const docIds = (forgeAssets || []).filter(a => DOC_FORMATS.includes(a.format)).map(a => a.id)
      if (docIds.length) {
        const { data: docs } = await db().from('forge_assets').select('id, content').in('id', docIds)
        for (const d of (docs || [])) previewMap[d.id] = recortarMd(d.content)
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
      preview:     previewMap[a.id] ?? null,
      created_at:  a.approved_at ?? a.created_at,
      versions:    (forgeVersionsMap[a.id] || []).map(v => ({
        id:             v.id,
        storage_url:    v.storage_url,
        version_number: v.version_number,
        is_current:     v.is_current,
        model_used:     v.metadata?.model_used ?? null,
        // Aprobada es distinto de vigente: una version puede estar a la vista sin haber sido
        // elegida. Vive en metadata para no migrar una columna.
        approved_at:    v.metadata?.approved_at ?? null,
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

    // ── librería del proyecto (Refs) ───────────────────────────────────────────
    // Archivos que subió el usuario: no pertenecen a ningún nodo, son del PROYECTO, y
    // cualquier nodo puede referenciarlos conectándolos como `library_asset` en el canvas.
    // Solo se listan en la vista de medios; la librería de activos ya los muestra por su lado.
    const libraryNormalized = []
    if (mediaOnly && project_id) {
      const { data: lib } = await db()
        .from('forge_project_library_assets')
        .select('id, display_name, file_name, mime_type, asset_type, storage_url, created_at, extracted_text')
        .eq('project_id', project_id)
        .order('created_at', { ascending: false })

      for (const a of (lib || [])) {
        if (!a.storage_url) continue
        const mime = String(a.mime_type || '')
        const fmt  = mime.startsWith('image/') ? 'image'
                   : mime.startsWith('video/') ? 'video'
                   : mime.startsWith('audio/') ? 'audio'
                   : a.asset_type === 'model_3d' ? 'model_3d'
                   : /pdf|word|presentation|markdown|text/.test(mime) ? 'document'
                   : null
        if (!fmt) continue

        libraryNormalized.push({
          id:          a.id,
          source:      'library',
          name:        a.display_name || a.file_name,
          project_id,
          node_key:    null,          // sin nodo: es del proyecto
          node_title:  'Library',
          phase:       null,
          format:      fmt,
          status:      'library',
          storage_url: a.storage_url,
          content:     null,
          // Lo que subió el usuario ya trae su texto extraído; se usa el mismo asomo que en
          // los documentos del pipeline para que la tarjeta se vea igual venga de donde venga.
          preview:     fmt === 'document' ? recortarMd(a.extracted_text) : null,
          created_at:  a.created_at,
          versions:    [],
        })
      }
    }

    let unified = [...forgeNormalized, ...legacyNormalized, ...generatedNormalized, ...libraryNormalized]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    // El normalizado de legacy deriva el formato del step_key y cae en 'document' por defecto,
    // así que el filtro de la query no alcanza: hay que volver a pasarlo sobre el resultado.
    if (mediaOnly) unified = unified.filter(a => [...MEDIA_FORMATS, ...DOC_FORMATS].includes(a.format) && a.storage_url)

    // El tema solo lo pide el moodboard; no se calcula para la librería de activos.
    const theme = mediaOnly ? await resolveProjectTheme(project_id) : undefined

    // Paginación del RESULTADO, no de la consulta: se unen cuatro fuentes y se ordenan por
    // fecha, así que no hay forma de paginar en SQL sin rehacer el endpoint. Medido hoy, el
    // proyecto más cargado son 41 activos y el payload ~11 KB, así que el moodboard no la
    // necesita y sigue pidiendo todo — el tope existe para la llamada SIN `project_id`, que
    // recorre los 34 proyectos. Sin `limit` el comportamiento es el de siempre.
    const total  = unified.length
    const limit  = Number.parseInt(req.query.limit, 10)
    const offset = Number.parseInt(req.query.offset, 10) || 0
    if (Number.isFinite(limit) && limit > 0) unified = unified.slice(offset, offset + limit)

    res.json({ success: true, assets: unified, total, ...(theme ? { theme } : {}) })
  } catch (err) { next(err) }
})

module.exports = router
