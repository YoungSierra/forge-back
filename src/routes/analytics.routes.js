const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')

// ─── GET /api/admin/analytics/summary ────────────────────────────────────────
// Totales globales con filtro opcional de fecha y proyecto
router.get('/summary', async (req, res, next) => {
  try {
    const { from, to, project_id } = req.query

    let q = db().from('forge_execution_log').select('cost_usd, duration_ms, input_tokens, output_tokens, cached_tokens, status, executor_type')

    if (from)       q = q.gte('created_at', from)
    if (to)         q = q.lte('created_at', to)
    if (project_id) q = q.eq('project_id', project_id)

    const { data, error } = await q
    if (error) return res.status(500).json({ success: false, error: error.message })

    const rows = data || []
    const total_calls    = rows.length
    const total_cost     = rows.reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0)
    const total_input    = rows.reduce((s, r) => s + (r.input_tokens  || 0), 0)
    const total_output   = rows.reduce((s, r) => s + (r.output_tokens || 0), 0)
    const total_cached   = rows.reduce((s, r) => s + (r.cached_tokens || 0), 0)
    const durations      = rows.filter(r => r.duration_ms).map(r => r.duration_ms)
    const avg_duration   = durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : 0
    const error_count    = rows.filter(r => r.status === 'error').length
    const llm_calls      = rows.filter(r => r.executor_type === 'llm').length
    const image_calls    = rows.filter(r => r.executor_type !== 'llm').length

    res.json({
      success: true,
      summary: {
        total_calls, total_cost: parseFloat(total_cost.toFixed(6)),
        total_input, total_output, total_cached,
        avg_duration, error_count, llm_calls, image_calls,
        cache_hit_rate: total_input > 0 ? parseFloat((total_cached / total_input).toFixed(4)) : 0,
      },
    })
  } catch (err) { next(err) }
})

// ─── GET /api/admin/analytics/breakdown ──────────────────────────────────────
// Desglose agrupado — group_by: project | member | provider | day
router.get('/breakdown', async (req, res, next) => {
  try {
    const { group_by = 'project', from, to, project_id } = req.query

    let q = db().from('forge_execution_log')
      .select('cost_usd, duration_ms, input_tokens, output_tokens, cached_tokens, status, executor_type, provider, model, project_id, triggered_by, created_at')

    if (from)       q = q.gte('created_at', from)
    if (to)         q = q.lte('created_at', to)
    if (project_id) q = q.eq('project_id', project_id)

    const { data, error } = await q.order('created_at', { ascending: false }).limit(5000)
    if (error) return res.status(500).json({ success: false, error: error.message })

    const rows = data || []

    // Obtener nombres de proyectos y miembros para enriquecer la respuesta
    const projectIds = [...new Set(rows.map(r => r.project_id).filter(Boolean))]
    const memberIds  = [...new Set(rows.map(r => r.triggered_by).filter(Boolean))]

    const [projectsRes, membersRes] = await Promise.all([
      projectIds.length
        ? db().from('projects').select('id, name').in('id', projectIds)
        : Promise.resolve({ data: [] }),
      memberIds.length
        ? db().from('members').select('id, display_name').in('id', memberIds)
        : Promise.resolve({ data: [] }),
    ])

    const projectNames = Object.fromEntries((projectsRes.data || []).map(p => [p.id, p.name]))
    const memberNames  = Object.fromEntries((membersRes.data  || []).map(m => [m.id, m.display_name]))

    // Función de agrupamiento
    const getKey = (row) => {
      switch (group_by) {
        case 'project':  return row.project_id  || 'unknown'
        case 'member':   return row.triggered_by || 'unknown'
        case 'provider': return `${row.provider || 'unknown'}:${row.model || ''}`
        case 'day':      return (row.created_at || '').slice(0, 10)
        default:         return 'unknown'
      }
    }

    const getLabel = (key, row) => {
      switch (group_by) {
        case 'project':  return projectNames[key] || key
        case 'member':   return memberNames[key]  || key
        case 'provider': return key
        case 'day':      return key
        default:         return key
      }
    }

    // Agrupar y agregar
    const groups = {}
    for (const row of rows) {
      const key = getKey(row)
      if (!groups[key]) {
        groups[key] = { key, label: getLabel(key, row), calls: 0, cost: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, duration_sum: 0, duration_count: 0, errors: 0 }
      }
      const g = groups[key]
      g.calls        += 1
      g.cost         += parseFloat(row.cost_usd) || 0
      g.input_tokens += row.input_tokens  || 0
      g.output_tokens+= row.output_tokens || 0
      g.cached_tokens+= row.cached_tokens || 0
      if (row.duration_ms) { g.duration_sum += row.duration_ms; g.duration_count++ }
      if (row.status === 'error') g.errors++
    }

    const breakdown = Object.values(groups)
      .map(g => ({
        key:           g.key,
        label:         g.label,
        calls:         g.calls,
        cost_usd:      parseFloat(g.cost.toFixed(6)),
        input_tokens:  g.input_tokens,
        output_tokens: g.output_tokens,
        cached_tokens: g.cached_tokens,
        avg_duration:  g.duration_count ? Math.round(g.duration_sum / g.duration_count) : 0,
        errors:        g.errors,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd)

    res.json({ success: true, group_by, breakdown })
  } catch (err) { next(err) }
})

// ─── GET /api/admin/analytics/logs ───────────────────────────────────────────
// Logs detallados paginados
router.get('/logs', async (req, res, next) => {
  try {
    const { page = 1, limit = 50, from, to, project_id, executor_type, status } = req.query
    const pageNum  = Math.max(1, parseInt(page))
    const pageSize = Math.min(200, Math.max(1, parseInt(limit)))
    const offset   = (pageNum - 1) * pageSize

    let q = db().from('forge_execution_log')
      .select('*, projects!forge_execution_log_project_id_fkey(name), members!forge_execution_log_triggered_by_fkey(display_name)', { count: 'exact' })

    if (from)          q = q.gte('created_at', from)
    if (to)            q = q.lte('created_at', to)
    if (project_id)    q = q.eq('project_id', project_id)
    if (executor_type) q = q.eq('executor_type', executor_type)
    if (status)        q = q.eq('status', status)

    const { data, error, count } = await q
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })

    res.json({
      success: true,
      logs:  data || [],
      total: count || 0,
      page:  pageNum,
      pages: Math.ceil((count || 0) / pageSize),
    })
  } catch (err) { next(err) }
})

// ─── GET /api/admin/analytics/projects-list ──────────────────────────────────
// Lista de proyectos que tienen logs (para el filtro del selector)
router.get('/projects-list', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('forge_execution_log')
      .select('project_id, projects!forge_execution_log_project_id_fkey(name)')
      .not('project_id', 'is', null)
      .limit(1000)

    if (error) return res.status(500).json({ success: false, error: error.message })

    const seen = new Set()
    const projects = []
    for (const row of (data || [])) {
      if (!seen.has(row.project_id)) {
        seen.add(row.project_id)
        projects.push({ id: row.project_id, name: row.projects?.name || row.project_id })
      }
    }
    res.json({ success: true, projects })
  } catch (err) { next(err) }
})

// ─── GET /api/admin/analytics/project-chip/:projectId ────────────────────────
// Endpoint liviano para el chip del toolbar — columnas mínimas, una sola request
router.get('/project-chip/:projectId', async (req, res, next) => {
  try {
    const { projectId } = req.params

    const { data, error } = await db()
      .from('forge_execution_log')
      .select('cost_usd, executor_type, provider, model, input_tokens, cached_tokens')
      .eq('project_id', projectId)

    if (error) return res.status(500).json({ success: false, error: error.message })

    const rows = data || []

    // Totales
    let total_cost = 0, total_input = 0, total_cached = 0, llm_calls = 0, image_calls = 0
    const groups = {}

    for (const r of rows) {
      const cost = parseFloat(r.cost_usd) || 0
      total_cost   += cost
      total_input  += r.input_tokens  || 0
      total_cached += r.cached_tokens || 0

      if (r.executor_type === 'llm') { llm_calls++ } else { image_calls++ }

      const key = `${r.provider || 'unknown'}:${r.model || ''}`
      if (!groups[key]) groups[key] = { key, label: key, calls: 0, cost_usd: 0 }
      groups[key].calls    += 1
      groups[key].cost_usd += cost
    }

    const providers = Object.values(groups)
      .sort((a, b) => b.cost_usd - a.cost_usd)
      .slice(0, 5)
      .map(g => ({ ...g, cost_usd: parseFloat(g.cost_usd.toFixed(6)) }))

    res.json({
      success:     true,
      total_cost:  parseFloat(total_cost.toFixed(6)),
      total_calls: rows.length,
      total_input,
      total_cached,
      llm_calls,
      image_calls,
      providers,
    })
  } catch (err) { next(err) }
})

module.exports = router
