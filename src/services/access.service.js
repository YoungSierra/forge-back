// ─── access.service · Frente 2 (Multi-Org) ───────────────────────────────────────────────────
// PUNTO ÚNICO de permiso sobre un proyecto. Toda ruta project-scoped debe pasar por aquí en vez
// de filtrar a mano con .eq() regados. Regla forward-compat: el acceso se decide por org_id.
//
// Uso:  const project = await assertProjectAccess(projectId, req.auth)
//       (lanza un Error con .status y .code si no hay acceso; el error handler los usa)
// ─────────────────────────────────────────────────────────────────────────────────────────────
const { db } = require('./supabase.service')

function deny(msg, status, code) {
  const e = new Error(msg); e.status = status; e.code = code; return e
}

// Verifica que ctx (= req.auth) puede acceder al proyecto. Devuelve el proyecto o lanza.
async function assertProjectAccess(projectId, ctx) {
  const { data: project, error } = await db()
    .from('projects').select('id, org_id, owner_member_id').eq('id', projectId).maybeSingle()
  if (error) throw deny('Database error', 500, 'DB_ERROR')
  if (!project) throw deny('Project not found', 404, 'NOT_FOUND')

  // Super-admin de plataforma (V57): acceso total.
  if (ctx?.isPlatformAdmin) return project

  // El resto: el proyecto debe ser de la organización ACTIVA del usuario.
  if (!ctx?.activeOrgId || project.org_id !== ctx.activeOrgId) {
    throw deny('No access to project', 403, 'PROJECT_FORBIDDEN')
  }
  return project
}

module.exports = { assertProjectAccess }
