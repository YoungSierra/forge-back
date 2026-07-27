// ─── Backfill Multi-Organización · Frente 1.6 ────────────────────────────────────────────────
//
// Mete todos los datos actuales bajo la organización por defecto "V57 Studio":
//   1. Crea la org "V57 Studio" (slug v57-studio) si no existe.
//   2. Mete a TODOS los members actuales en org_members (owner al dueño, el resto 'member').
//   3. Asigna projects.org_id = V57 Studio donde esté NULL.
//   4. Asigna forge_execution_log.org_id = V57 Studio donde esté NULL.
//   5. Los blueprints actuales quedan org_id NULL = estándar de V57 (no se tocan, es correcto).
//   6. Verifica que no quede ningún proyecto ni member sin organización.
//
// IDEMPOTENTE y re-ejecutable: solo crea lo que falta y solo actualiza filas con org_id NULL.
// Requiere la migración 043 aplicada antes.
//
// Uso:
//   node scripts/backfill-org.js                      -> DRY-RUN (solo muestra qué haría, no escribe)
//   node scripts/backfill-org.js --write              -> aplica los cambios (org + org_members + org_id)
//   node scripts/backfill-org.js --owner=<member_id>  -> fija el owner (default: el 1er admin, o el 1er member)
//   node scripts/backfill-org.js --roles [--write]    -> ADEMÁS migra members.role: admin->super_admin,
//                                                        member->user. OPT-IN: correr junto con F2
//                                                        (requireAdmin -> requirePlatformAdmin), si no
//                                                        el panel admin queda sin reconocer admins.
// ─────────────────────────────────────────────────────────────────────────────────────────────
require('dotenv').config()
const { db } = require('../src/services/supabase.service')

const WRITE   = process.argv.includes('--write')
const ROLES   = process.argv.includes('--roles')  // opt-in: normaliza members.role al eje de plataforma
const ownerArg = (process.argv.find(a => a.startsWith('--owner=')) || '').split('=')[1] || null
const SLUG = 'v57-studio'
const NAME = 'V57 Studio'

const log = (...a) => console.log(...a)
const tag = WRITE ? '[WRITE]' : '[DRY-RUN]'

async function main() {
  log(`\n${tag} Backfill a "${NAME}"\n`)

  // 1) Org por defecto
  let { data: org } = await db().from('organizations').select('id, name, slug').eq('slug', SLUG).maybeSingle()

  // 2) Resolver owner (para created_by y el rol owner)
  const { data: members } = await db().from('members').select('id, display_name, role, created_at').order('created_at', { ascending: true })
  if (!members || members.length === 0) { log('No hay members. Nada que hacer.'); return }

  let ownerId = ownerArg
  if (ownerId && !members.some(m => m.id === ownerId)) {
    log(`! El --owner=${ownerId} no existe en members. Abortando.`); return
  }
  if (!ownerId) {
    const firstAdmin = members.find(m => m.role === 'admin')
    ownerId = (firstAdmin || members[0]).id
  }
  const ownerName = members.find(m => m.id === ownerId)?.display_name
  log(`Owner: ${ownerName} (${ownerId})`)

  if (!org) {
    log(`Org "${NAME}" no existe -> ${WRITE ? 'creando' : 'se crearía'} (slug=${SLUG})`)
    if (WRITE) {
      const { data: created, error } = await db().from('organizations')
        .insert({ name: NAME, slug: SLUG, created_by: ownerId }).select('id, name, slug').single()
      if (error) throw error
      org = created
    }
  } else {
    log(`Org "${org.name}" ya existe (${org.id})`)
  }
  const orgId = org?.id ?? '(pendiente de crear)'

  // 3) org_members — meter a todos los members que aún no estén
  let existingIds = new Set()
  if (org) {
    const { data: existing } = await db().from('org_members').select('member_id').eq('org_id', org.id)
    existingIds = new Set((existing || []).map(r => r.member_id))
  }
  const toAdd = members.filter(m => !existingIds.has(m.id))
  log(`\norg_members: ${existingIds.size} ya están · ${toAdd.length} ${WRITE ? 'a insertar' : 'se insertarían'}`)
  if (WRITE && org && toAdd.length) {
    const rows = toAdd.map(m => ({
      org_id: org.id, member_id: m.id, org_role: m.id === ownerId ? 'owner' : 'member',
    }))
    const { error } = await db().from('org_members').insert(rows)
    if (error) throw error
  }

  // 4) projects.org_id donde NULL
  const { count: projNull } = await db().from('projects').select('*', { count: 'exact', head: true }).is('org_id', null)
  log(`\nprojects sin org: ${projNull} ${WRITE ? '-> asignando' : 'se asignarían'} a ${NAME}`)
  if (WRITE && org && projNull) {
    const { error } = await db().from('projects').update({ org_id: org.id }).is('org_id', null)
    if (error) throw error
  }

  // 5) forge_execution_log.org_id donde NULL
  const { count: felNull } = await db().from('forge_execution_log').select('*', { count: 'exact', head: true }).is('org_id', null)
  log(`forge_execution_log sin org: ${felNull} ${WRITE ? '-> asignando' : 'se asignarían'} a ${NAME}`)
  if (WRITE && org && felNull) {
    const { error } = await db().from('forge_execution_log').update({ org_id: org.id }).is('org_id', null)
    if (error) throw error
  }

  // 5.b) Rol de PLATAFORMA (opt-in con --roles) — 'admin' -> 'super_admin', 'member' -> 'user'.
  // ¡OJO! El requireAdmin ACTUAL chequea role==='admin'. Tras esto, el panel admin deja de
  // reconocer administradores hasta que Frente 2 cambie el middleware a requirePlatformAdmin.
  // Por eso es opt-in (--roles) y debe correrse en la MISMA ventana que el cambio de F2.
  const nAdmin  = members.filter(m => m.role === 'admin').length
  const nMember = members.filter(m => m.role === 'member').length
  if (ROLES) {
    log(`\n[--roles] rol de plataforma: ${nAdmin} 'admin'->'super_admin' · ${nMember} 'member'->'user' ${WRITE ? '(aplicando)' : '(se aplicaría)'}`)
    log(`          OJO: corre esto junto con el cambio requireAdmin -> requirePlatformAdmin (F2).`)
    if (WRITE) {
      await db().from('members').update({ role: 'super_admin' }).eq('role', 'admin')
      await db().from('members').update({ role: 'user' }).eq('role', 'member')
    }
  } else {
    log(`\nRol de plataforma: ${nAdmin} 'admin' / ${nMember} 'member' — SIN tocar (usá --roles junto con F2 para migrarlos a super_admin/user).`)
  }

  // 6) Verificación (solo tiene sentido tras --write)
  if (WRITE && org) {
    const { count: pLeft } = await db().from('projects').select('*', { count: 'exact', head: true }).is('org_id', null)
    const { count: mLeft } = await db().from('org_members').select('*', { count: 'exact', head: true }).eq('org_id', org.id)
    log(`\n[VERIFICACIÓN] proyectos sin org: ${pLeft} (debe ser 0) · members en ${NAME}: ${mLeft}/${members.length}`)
  }

  log(`\n${tag} listo. Blueprints actuales quedan como estándar (org_id NULL) — correcto.`)
  if (!WRITE) log('Re-córrelo con --write para aplicar.')
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1) })
