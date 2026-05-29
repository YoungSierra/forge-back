const { db } = require('./supabase.service')

// ─── Precios por proveedor/modelo (USD por 1M tokens) ────────────────────────
// Fuente: pricing oficial de cada provider a mayo 2026
const LLM_PRICING = {
  'gemini:gemini-2.5-flash':                    { input: 0.30,  output: 2.50  },
  'gemini:gemini-2.5-pro':                      { input: 1.25,  output: 10.00 },
  'gemini:gemini-2.0-flash':                    { input: 0.10,  output: 0.40  },
  'gemini:gemini-2.0-flash-lite':               { input: 0.075, output: 0.30  },
  'openai:gpt-4o':                              { input: 2.50,  output: 10.00 },
  'openai:gpt-4o-mini':                         { input: 0.15,  output: 0.60  },
  'openai:o3':                                  { input: 10.00, output: 40.00 },
  'openai:o3-mini':                             { input: 1.10,  output: 4.40  },
  'openai:o4-mini':                             { input: 1.10,  output: 4.40  },
  'anthropic:claude-opus-4-7':                  { input: 15.00, output: 75.00 },
  'anthropic:claude-sonnet-4-6':                { input: 3.00,  output: 15.00 },
  'anthropic:claude-haiku-4-5-20251001':        { input: 0.80,  output: 4.00  },
  'anthropic:claude-3-5-sonnet-20241022':       { input: 3.00,  output: 15.00 },
  'anthropic:claude-3-5-haiku-20241022':        { input: 0.80,  output: 4.00  },
  'groq:llama-3.3-70b-versatile':               { input: 0.59,  output: 0.79  },
  'groq:llama-3.1-8b-instant':                  { input: 0.05,  output: 0.08  },
  'groq:mixtral-8x7b-32768':                    { input: 0.24,  output: 0.24  },
  'together:meta-llama/Llama-3.3-70B-Instruct-Turbo': { input: 0.88, output: 0.88 },
  'openrouter:default':                         { input: 1.00,  output: 2.00  },
  'minimax:MiniMax-M2.7':                       { input: 0.40,  output: 1.60  },
}

// Precio estimado fijo para generación de imágenes (sin API de costo real)
const IMAGE_COST_USD = {
  comfyui:      0.04,
  openai_image: 0.04,
  fal:          0.03,
}

// ─── Calcula costo LLM en USD ─────────────────────────────────────────────────
function calculateLLMCost(provider, model, tokens) {
  const key    = `${provider}:${model}`
  const prices = LLM_PRICING[key] || LLM_PRICING[`${provider}:default`] || { input: 1.00, output: 2.00 }
  const input_cost  = ((tokens.input  || 0) * prices.input)  / 1_000_000
  const output_cost = ((tokens.output || 0) * prices.output) / 1_000_000
  return parseFloat((input_cost + output_cost).toFixed(8))
}

// ─── Insert no-bloqueante — nunca rompe el flujo principal ───────────────────
function logExecution(params) {
  setImmediate(async () => {
    try {
      const {
        project_id    = null,
        node_id       = null,
        session_id    = null,
        blueprint_id  = null,
        triggered_by  = null,
        trigger_type,
        executor_type,
        provider      = null,
        model         = null,
        tokens        = null,
        cost_usd      = null,
        is_estimated  = false,
        duration_ms   = null,
        started_at    = null,
        status        = 'success',
        error_code    = null,
        metadata      = {},
      } = params

      // Calcular costo si no viene explícito
      let finalCost = cost_usd
      if (finalCost === null) {
        if (executor_type === 'llm' && tokens) {
          finalCost = calculateLLMCost(provider, model, tokens)
        } else if (IMAGE_COST_USD[executor_type]) {
          finalCost = IMAGE_COST_USD[executor_type]
        } else {
          finalCost = 0
        }
      }

      await db().from('forge_execution_log').insert({
        project_id,
        node_id,
        session_id,
        blueprint_id,
        triggered_by,
        trigger_type,
        executor_type,
        provider,
        model,
        input_tokens:  tokens?.input   ?? 0,
        output_tokens: tokens?.output  ?? 0,
        cached_tokens: tokens?.cached  ?? 0,
        cost_usd:      finalCost,
        is_estimated,
        duration_ms,
        started_at,
        status,
        error_code,
        metadata,
      })
    } catch (e) {
      console.error('[execution-log] insert failed:', e.message)
    }
  })
}

module.exports = { logExecution, calculateLLMCost }
