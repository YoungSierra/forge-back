// ─── Admin · Assembly dry-run (piloto 0, AISLADO) ───────────────────────────
// POST /api/admin/assembly/dry-run — corre el ensamblador contra plantillas piloto
// con inputs mock. NO despacha executor, NO escribe nodos, NO toca el canvas.
// Reproduce el assembler_test.py de Pedro en el stack real.
const express = require('express')
const router = express.Router()
const fs = require('fs')
const path = require('path')
const { assemble, getTemplate, sha } = require('../services/assembler.service')

const MOCK_INPUTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assembly_templates', '_mock_smack_inputs.json'), 'utf8'))
// Mock del sibling vs_spec para el piloto 0 (tpl_3_13: "identical to the connection").
const MOCK_VS_SPEC = [
  '# Vertical Slice Specification — SMACK',
  '',
  '**sliceScope:** true · **loop:** input → verb → trigger → counter → death → life-advance → house-state closes',
  '',
  '## Scope',
  'One playable life across 13 house states. 8 mechanics (M-01..M-08), all sliceScope:true, dependency-closed.',
  '',
  '## Acceptance',
  '- End-to-end playable loop closes without orphan dependencies.',
  '- Engine pinned: Unity 6000.0 LTS.',
  '- No deprecated markers; pending items resolve-by owner.',
].join('\n')

function summarize(r) {
  return {
    gate: r.gate,
    verifier: r.verifier.map(v => ({ rule: v.rule, pass: v.pass, detail: v.detail })),
    missing_required: r.manifest.missing_required,
    slots_total: r.manifest.slots.length,
    slots_filled: r.manifest.slots.filter(s => s.filled).length,
    assembled_hash: r.assembled ? sha(r.assembled) : null,
    assembled_preview: r.assembled ? r.assembled.slice(0, 500) : null,
  }
}

// El dry-run corre SIN glue a propósito: así sigue siendo determinista, reproducible
// byte a byte y de 0 tokens, que es justo lo que este banco de pruebas valida.
async function runScenarios(tplId, inputs, siblings, dropKey, dropPool) {
  const happy = await assemble(getTemplate(tplId), inputs, siblings)
  const fi = { ...inputs }, fsib = { ...siblings }
  if (dropPool === 'input') delete fi[dropKey]; else delete fsib[dropKey]
  const fail = await assemble(getTemplate(tplId), fi, fsib)
  const a = await assemble(getTemplate(tplId), inputs, siblings)
  const b = await assemble(getTemplate(tplId), inputs, siblings)
  return {
    happy: summarize(happy),
    fail: { dropped: `${dropPool}:${dropKey}`, gate: fail.gate, blocked: fail.assembled == null, missing_required: fail.manifest.missing_required },
    repro: { identical: a.assembled != null && a.assembled === b.assembled, hash: a.assembled ? sha(a.assembled) : null },
    manifest: happy.manifest,
  }
}

router.post('/dry-run', async (req, res, next) => {
  try {
    const report = {
      tpl_3_13: await runScenarios('tpl_3_13_vs_spec_doc', {}, { vs_spec: MOCK_VS_SPEC }, 'vs_spec', 'sibling'),
      tpl_3_8: await runScenarios('tpl_3_8_gdd_complete', MOCK_INPUTS, {}, 'world_lore', 'input'),
    }
    res.json({ success: true, note: 'Piloto 0 AISLADO — no toca canvas/DB/executor.', report })
  } catch (err) { next(err) }
})

module.exports = router
