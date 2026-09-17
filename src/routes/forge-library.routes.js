const express = require('express')
const multer  = require('multer')
const router  = express.Router({ mergeParams: true })
const { db, dbAsUser } = require('../services/supabase.service')
const { uploadToStorage }       = require('../services/storage.service')
const { extractText, detectAssetType } = require('../services/extraction.service')

// Multer en memoria — el buffer se sube directo a R2
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } })

// ─── GET /api/projects/:id/library ───────────────────────────────────────────
// Lista todos los assets de la librería del proyecto
router.get('/', async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    const asUser = dbAsUser(req.auth.token)  // RLS: librería del proyecto como el usuario

    const { data, error } = await asUser
      .from('forge_project_library_assets')
      .select('id, display_name, description, file_name, mime_type, file_size_bytes, asset_type, storage_url, extracted_text, created_at')
      .eq('project_id', project_id)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ success: true, assets: data })
  } catch (err) { next(err) }
})

// ─── POST /api/projects/:id/library ──────────────────────────────────────────
// Sube un asset a la librería del proyecto
router.post('/', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'File too large. Maximum size is 200 MB.' })
    }
    if (err) return next(err)
    next()
  })
}, async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    const { display_name, description, member_id } = req.body

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'file es requerido' })
    }

    const { buffer, originalname, mimetype, size } = req.file
    const asset_type    = detectAssetType(mimetype)
    const slug          = `${Date.now()}-${originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const storagePath   = `projects/${project_id}/library/${slug}`

    // Subir a R2
    const storage_url = await uploadToStorage(buffer, storagePath, mimetype)

    // Extraer texto (documentos) — null para imágenes y modelos 3D
    const extracted_text = await extractText(buffer, mimetype)

    const { data, error } = await db()
      .from('forge_project_library_assets')
      .insert({
        project_id,
        display_name: display_name || originalname,
        description:  description  || null,
        file_name:    originalname,
        mime_type:    mimetype,
        file_size_bytes: size,
        asset_type,
        storage_url,
        extracted_text,
        uploaded_by: member_id || null,
      })
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, asset: data })
  } catch (err) { next(err) }
})

// ─── GET /api/projects/:id/library/:asset_id/file ────────────────────────────
//
// Dice DÓNDE está el archivo; no lo sirve.
//
// Antes lo bajaba de R2 y lo volvía a emitir por acá, para esquivar el CORS del bucket. Funciona,
// y cuesta: cada apertura paga el tamaño entero en el ancho de banda de Render —bajarlo y
// servirlo—. En esta librería hay 148 MB con dos modelos de 55 y 45 MB: noventa aperturas del
// grande son los 5 GB del plan. El 17-09 el workspace se suspendió por agotarlos.
//
// Ahora contesta un redirect de un par de cientos de bytes y sirve R2, cuya salida no se cobra.
// Es lo mismo que hace la ruta de miniaturas.
//
// Lo que un redirect NO arregla es el CORS que motivó el proxy: quien necesite LEER los bytes
// —`fetch`, un canvas— seguirá topándose con el bucket, que no manda `Access-Control-Allow-Origin`
// y contesta 403 al preflight (medido el 16-09). Hoy no le afecta a nadie: el front usa
// `storage_url` directo para mostrar y descargar, y lo que necesita leer bytes —las miniaturas 3D,
// el visor— pasa por su propio proxy. Si algún día hace falta de verdad, la solución es ponerle
// CORS al bucket, no volver a pagar el tráfico dos veces.
router.get('/:asset_id/file', async (req, res, next) => {
  try {
    const { id: project_id, asset_id } = req.params

    const { data, error } = await db()
      .from('forge_project_library_assets')
      .select('storage_url, mime_type, file_name')
      .eq('id', asset_id)
      .eq('project_id', project_id)
      .single()

    if (error || !data) return res.status(404).json({ success: false, error: 'Asset not found' })
    if (!data.storage_url) return res.status(404).json({ success: false, error: 'Asset has no file' })

    res.setHeader('Access-Control-Allow-Origin', '*')
    // Una hora: el archivo no cambia de sitio, y el redirect es lo único que se pide a Render.
    res.setHeader('Cache-Control', 'public, max-age=3600')
    return res.redirect(302, data.storage_url)
  } catch (err) { next(err) }
})

// ─── PATCH /api/projects/:id/library/:asset_id ───────────────────────────────
// Actualiza display_name y/o description de un asset
router.patch('/:asset_id', async (req, res, next) => {
  try {
    const { id: project_id, asset_id } = req.params
    const { display_name, description } = req.body

    if (!display_name?.trim()) {
      return res.status(400).json({ success: false, error: 'display_name es requerido' })
    }

    const { data, error } = await db()
      .from('forge_project_library_assets')
      .update({ display_name: display_name.trim(), description: description ?? null })
      .eq('id', asset_id)
      .eq('project_id', project_id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, asset: data })
  } catch (err) { next(err) }
})

// ─── DELETE /api/projects/:id/library/:asset_id ──────────────────────────────
// Elimina un asset de la librería
// Nota: no borra el archivo de R2 para no romper referencias activas en node inputs
router.delete('/:asset_id', async (req, res, next) => {
  try {
    const { id: project_id, asset_id } = req.params

    // Verificar que no está en uso como input en ningún nodo
    const { data: usages } = await db()
      .from('forge_project_node_inputs')
      .select('id')
      .eq('project_id', project_id)
      .eq('source_asset_id', asset_id)
      .limit(1)

    if (usages?.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'This asset is used as input in one or more nodes. Remove it from those nodes first.',
      })
    }

    const { error } = await db()
      .from('forge_project_library_assets')
      .delete()
      .eq('id', asset_id)
      .eq('project_id', project_id)

    if (error) throw error
    res.json({ success: true })
  } catch (err) { next(err) }
})

// ─── GET /api/projects/:id/project-assets ────────────────────────────────────
// Lista unificada de assets del proyecto: forge_assets (nuevo) + assets legacy (temporal)
// Forma normalizada para el Asset Library principal
router.get('/project-assets', async (req, res, next) => {
  try {
    const { id: project_id } = req.params
    // NOTA: sigue en service-role a propósito — se une a tablas legacy (assets/asset_versions) que
    // están por deprecarse y no tienen RLS. Enforcement de esta vista queda como pendiente (junto con
    // el gate de /api/assets). Ver plan multi-org.

    // ── forge_assets (nuevo sistema) ──────────────────────────────────────────
    const { data: forgeAssets } = await db()
      .from('forge_assets')
      .select(`
        id, name, format, status, storage_url, content, approved_at, created_at,
        node_id,
        forge_nodes ( node_key, title, phase )
      `)
      .eq('project_id', project_id)
      .order('approved_at', { ascending: false, nullsFirst: false })

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

    // ── assets legacy (temporal — se quitará cuando el usuario lo indique) ───
    const { data: legacyAssets } = await db()
      .from('assets')
      .select(`
        id, name, step_key, review_status, created_at,
        asset_versions ( id, storage_url, version_number, is_current, model_used, created_at )
      `)
      .eq('project_id', project_id)
      .order('created_at', { ascending: false })

    // Inferir format desde step_key
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

    const unified = [...forgeNormalized, ...legacyNormalized]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    res.json({ success: true, assets: unified })
  } catch (err) { next(err) }
})

module.exports = router
