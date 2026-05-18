const express = require('express')
const router  = express.Router()
const { db }  = require('../services/supabase.service')

// GET /api/pipeline/config
// Retorna containers con sus nodos hijos — base de datos para el canvas
router.get('/config', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('step_configs')
      .select('step_key, step_type, parent_key, order_index, label, integration_type, model_name, is_active')
      .order('order_index')

    if (error) return res.status(500).json({ success: false, error: error.message })

    const rows = data || []

    // Separar containers de nodos
    const containers = rows
      .filter(r => r.step_type === 'container')
      .sort((a, b) => (a.order_index ?? 99) - (b.order_index ?? 99))

    const nodes = rows.filter(r => r.step_type === 'node' || !r.step_type)

    // Construir jerarquía
    const result = containers.map(c => ({
      step_key:         c.step_key,
      label:            c.label || c.step_key,
      order_index:      c.order_index,
      integration_type: c.integration_type,
      is_active:        c.is_active,
      children: nodes
        .filter(n => n.parent_key === c.step_key)
        .sort((a, b) => (a.order_index ?? 99) - (b.order_index ?? 99))
        .map(n => ({
          step_key:         n.step_key,
          label:            n.label || n.step_key,
          order_index:      n.order_index,
          integration_type: n.integration_type,
          model_name:       n.model_name,
          is_active:        n.is_active,
        })),
    }))

    res.json({ success: true, containers: result })
  } catch (err) {
    next(err)
  }
})

module.exports = router
