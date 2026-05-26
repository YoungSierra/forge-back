const express = require('express')
const multer  = require('multer')
const router  = express.Router({ mergeParams: true })
const { db }  = require('../services/supabase.service')
const { uploadToStorage }       = require('../services/storage.service')
const { extractText, detectAssetType } = require('../services/extraction.service')

// Multer en memoria — el buffer se sube directo a R2
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } })

// ─── GET /api/projects/:id/library ───────────────────────────────────────────
// Lista todos los assets de la librería del proyecto
router.get('/', async (req, res, next) => {
  try {
    const { id: project_id } = req.params

    const { data, error } = await db()
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
// Proxy del archivo desde R2 — evita problemas de CORS en el cliente
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

    const upstream = await fetch(data.storage_url)
    if (!upstream.ok) return res.status(502).json({ success: false, error: 'Failed to fetch from storage' })

    res.setHeader('Content-Type', data.mime_type || 'application/octet-stream')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Disposition', `inline; filename="${data.file_name}"`)

    const { Readable } = require('stream')
    Readable.fromWeb(upstream.body).pipe(res)
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

module.exports = router
