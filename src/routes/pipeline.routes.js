const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')

const sort = (arr, key = 'order_index') =>
  [...arr].sort((a, b) => (a[key] ?? 99) - (b[key] ?? 99))

// GET /api/pipeline/config
// Retorna jerarquía completa: phases → containers → nodes + gate
// Mantiene `containers` para compatibilidad con el canvas legacy
router.get('/config', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('step_configs')
      .select('step_key, step_type, parent_key, order_index, label, description, integration_type, model_name, is_active')
      .order('order_index')

    if (error) return res.status(500).json({ success: false, error: error.message })

    const rows = data || []

    const byType  = (type)       => rows.filter(r => r.step_type === type)
    const byParent = (parentKey) => rows.filter(r => r.parent_key === parentKey)

    // ── Helpers de mapeo ──────────────────────────────────────────────────────

    const mapNode = n => ({
      step_key:         n.step_key,
      label:            n.label || n.step_key,
      description:      n.description || null,
      order_index:      n.order_index,
      integration_type: n.integration_type,
      model_name:       n.model_name,
      is_active:        n.is_active,
    })

    const mapContainer = c => ({
      step_key:         c.step_key,
      label:            c.label || c.step_key,
      description:      c.description || null,
      order_index:      c.order_index,
      integration_type: c.integration_type,
      is_active:        c.is_active,
      nodes: sort(byParent(c.step_key).filter(r => r.step_type === 'node')).map(mapNode),
    })

    // ── Jerarquía 3 niveles: phases → containers → nodes + gate ──────────────

    const phases = sort(byType('phase').filter(p => p.is_active)).map(p => {
      const containers = sort(byParent(p.step_key).filter(r => r.step_type === 'container')).map(mapContainer)
      const gate       = byParent(p.step_key).find(r => r.step_type === 'gate')

      return {
        step_key:    p.step_key,
        label:       p.label || p.step_key,
        description: p.description || null,
        order_index: p.order_index,
        is_active:   p.is_active,
        containers,
        gate: gate ? {
          step_key:    gate.step_key,
          label:       gate.label || gate.step_key,
          description: gate.description || null,
          order_index: gate.order_index,
          is_active:   gate.is_active,
        } : null,
      }
    })

    // ── Legacy: containers sin fase (para ForgePipeline.tsx existente) ───────

    const legacyContainers = sort(byType('container').filter(c => !c.parent_key)).map(c => ({
      ...mapContainer(c),
      // el canvas legacy espera `children` en vez de `nodes`
      children: mapContainer(c).nodes,
    }))

    res.json({ success: true, phases, containers: legacyContainers })
  } catch (err) {
    next(err)
  }
})

module.exports = router
