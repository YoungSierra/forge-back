// ─── JSON → markdown legible (SOLO presentación) ──────────────────────────────
// Port del frontend lib/json-display.ts para que los documentos generados (PDF) muestren el JSON
// estructurado de un output (ej. concept_data del 2.2) como markdown legible en vez de JSON crudo.
// NO modifica el contenido real; solo le da forma para renderizar. Devuelve null si no hay JSON.

const OMIT_KEYS = ['title', 'name']

// Renderiza recursivamente los campos de un objeto como bullets markdown (con indentación).
function renderFields(obj, indent) {
  const pad = '  '.repeat(indent)
  const lines = []
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) {
      const scalarArr = v.every(x => x == null || typeof x !== 'object')
      if (scalarArr) {
        const vals = v.filter(x => x != null).map(String)
        if (vals.every(s => s.length <= 30) && vals.length <= 6) {
          lines.push(`${pad}- **${k}:** ${vals.join(', ')}`)
        } else {
          lines.push(`${pad}- **${k}:**`)
          for (const s of vals) lines.push(`${pad}  - ${s}`)
        }
      } else {
        lines.push(`${pad}- **${k}:**`)
        v.forEach((x, i) => {
          if (x && typeof x === 'object') {
            const xo = x
            const t = xo.name || xo.title || `#${i + 1}`
            lines.push(`${pad}  - **${t}**`)
            const rest = Object.fromEntries(Object.entries(xo).filter(([kk]) => !OMIT_KEYS.includes(kk)))
            lines.push(...renderFields(rest, indent + 2))
          } else {
            lines.push(`${pad}  - ${String(x)}`)
          }
        })
      }
    } else if (typeof v === 'object') {
      lines.push(`${pad}- **${k}:**`)
      lines.push(...renderFields(v, indent + 1))
    } else {
      lines.push(`${pad}- **${k}:** ${String(v)}`)
    }
  }
  return lines
}

// Extrae el primer valor JSON (objeto o array) del contenido — fenced ```json o suelto.
function extractTopJson(content) {
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fenceMatch ? fenceMatch[1] : content
  const iObj = text.indexOf('{'), iArr = text.indexOf('[')
  let open, close
  if (iArr !== -1 && (iObj === -1 || iArr < iObj)) { open = '['; close = ']' }
  else if (iObj !== -1) { open = '{'; close = '}' }
  else return null
  const start = text.indexOf(open), end = text.lastIndexOf(close)
  if (start === -1 || end <= start) return null
  let value
  try { value = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  if (!value || typeof value !== 'object') return null
  if (fenceMatch) return { value, before: '', after: '', fence: fenceMatch[0] }
  return { value, before: content.slice(0, content.indexOf(open)), after: content.slice(content.lastIndexOf(close) + 1), fence: null }
}

function jsonToMarkdown(content) {
  if (typeof content !== 'string') return null
  const ext = extractTopJson(content)
  if (!ext) return null
  const { value, before, after, fence } = ext

  let md
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    const allObj = value.every(el => el && typeof el === 'object' && !Array.isArray(el))
    if (allObj) {
      md = value.map((el, i) => {
        const o = el
        const title = o.title || o.name || `Item ${i + 1}`
        const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !OMIT_KEYS.includes(k)))
        return [`### ${i + 1}. ${title}`, ...renderFields(rest, 0)].join('\n')
      }).join('\n\n---\n\n')
    } else {
      md = value.map(v => `- ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n')
    }
  } else {
    const o = value
    const title = o.title || o.name
    const rest = title ? Object.fromEntries(Object.entries(o).filter(([k]) => !OMIT_KEYS.includes(k))) : o
    md = [...(title ? [`## ${title}`] : []), ...renderFields(rest, 0)].join('\n')
  }

  if (fence) return content.replace(fence, md)
  return `${before}${md}${after}`.trim()
}

module.exports = { jsonToMarkdown }
