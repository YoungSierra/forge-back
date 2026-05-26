const PDFDocument        = require('pdfkit')
const { uploadToStorage } = require('./storage.service')

// ─── Constantes de diseño PDF ─────────────────────────────────────────────────

// Portada: oscura / páginas de contenido: blancas
const PDF_COVER_BG  = '#0d0f14'
const PDF_BG        = '#ffffff'
const PDF_EMBER     = '#F59E0B'
const PDF_TEXT      = '#111827'
const PDF_DIM       = '#6b7280'
const PDF_SUBTLE    = '#f9fafb'
const PDF_LINE      = '#e5e7eb'
const PDF_H3_CLR    = '#374151'

// ─── Descripción de herramientas disponibles ──────────────────────────────────

const TOOL_SCHEMAS = {
  web_search: {
    description: 'Search the web for current information, news, market data, or research.',
    args: { query: 'string — the search query' },
  },
  web_fetch: {
    description: 'Fetch and read the content of a specific URL.',
    args: { url: 'string — the full URL to fetch' },
  },
  doc_gen_docx: {
    description: 'Generate and export a formatted PDF document from structured content. Returns a download URL.',
    args: {
      title:   'string — document title',
      content: 'string — full document content in Markdown format (use # for title, ## for sections)',
    },
  },
  kb_read: {
    description: 'Read an entry from the project knowledge base.',
    args: { key: 'string — the knowledge base entry key' },
  },
}

// Genera el bloque de instrucciones de tools para el system prompt
function getToolsBlock(tools) {
  if (!tools || !tools.length) return ''

  const available = tools.filter(t => TOOL_SCHEMAS[t])
  if (!available.length) return ''

  const lines = [
    '## Available tools\n',
    'When you need to use a tool, output EXACTLY this format — nothing else on that line:',
    '<tool_call>{"tool": "tool_name", "args": {"param": "value"}}</tool_call>',
    '\nWait for the tool result before continuing your response. After receiving results, synthesize them naturally.\n',
    '### Tools available to you:',
  ]

  for (const name of available) {
    const schema = TOOL_SCHEMAS[name]
    lines.push(`\n**${name}** — ${schema.description}`)
    lines.push('Args:')
    for (const [k, v] of Object.entries(schema.args)) {
      lines.push(`  - ${k}: ${v}`)
    }
  }

  return lines.join('\n')
}

// ─── Parser de tool calls ─────────────────────────────────────────────────────

// Busca todos los <tool_call>JSON</tool_call> en la respuesta del LLM
function parseToolCalls(text) {
  if (!text || typeof text !== 'string') return []
  const results = []
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      if (parsed.tool && typeof parsed.tool === 'string') {
        results.push({ tool: parsed.tool, args: parsed.args || {} })
      }
    } catch {
      // Ignorar tool calls malformados
    }
  }
  return results
}

// ─── Implementaciones de herramientas ─────────────────────────────────────────

async function webSearch(query) {
  // Brave Search si hay API key configurada
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      const url    = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`
      const res    = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY },
      })
      const data   = await res.json()
      const results = (data.web?.results || []).slice(0, 5).map(r => `**${r.title}**\n${r.url}\n${r.description ?? ''}`).join('\n\n')
      return { success: true, results: results || 'No results found.' }
    } catch (err) {
      return { success: false, error: `Brave Search failed: ${err.message}` }
    }
  }

  // Tavily si hay API key configurada
  if (process.env.TAVILY_API_KEY) {
    try {
      const res  = await fetch('https://api.tavily.com/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5 }),
      })
      const data = await res.json()
      const results = (data.results || []).map(r => `**${r.title}**\n${r.url}\n${r.content?.slice(0, 300) ?? ''}`).join('\n\n')
      return { success: true, results: results || 'No results found.' }
    } catch (err) {
      return { success: false, error: `Tavily Search failed: ${err.message}` }
    }
  }

  // Sin API configurada — stub informativo
  return {
    success: false,
    error:   `web_search is not configured. No search API key found (BRAVE_SEARCH_API_KEY or TAVILY_API_KEY). Query was: "${query}". Please configure a search API key in the backend .env to enable web search.`,
  }
}

async function webFetch(url) {
  try {
    const res  = await fetch(url, { headers: { 'User-Agent': 'Forge-AI/1.0' }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { success: false, error: `HTTP ${res.status}: ${res.statusText}` }

    const contentType = res.headers.get('content-type') || ''
    const text        = await res.text()

    // Extraer texto plano del HTML eliminando tags
    const clean = contentType.includes('html')
      ? text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 8000)
      : text.slice(0, 8000)

    return { success: true, content: clean, url }
  } catch (err) {
    return { success: false, error: `Fetch failed: ${err.message}` }
  }
}

// ─── PDF helpers para doc_gen ─────────────────────────────────────────────────

function pdfBuffer(builderFn) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 0, size: 'A4', bufferPages: true })
    const chunks = []
    doc.on('data',  c => chunks.push(c))
    doc.on('end',   () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    builderFn(doc)
    doc.end()
  })
}

function parseMarkdownSections(raw) {
  const lines    = raw.trim().split('\n')
  const sections = []
  let current    = null
  let titleFound = false

  for (const line of lines) {
    // ## heading (no ###) — boundary de sección de contenido
    if (/^## /.test(line) && !/^### /.test(line)) {
      const title = line.slice(3).trim()
      current     = { level: 2, title, lines: [] }
      sections.push(current)
      titleFound = true
      continue
    }
    // # heading (no ##) — solo el primero es título del documento; los demás van como contenido
    if (!titleFound && /^# /.test(line) && !/^## /.test(line)) {
      const title = line.slice(2).trim()
      current     = { level: 1, title, lines: [] }
      sections.push(current)
      titleFound = true
      continue
    }
    // Todo lo demás (incluyendo # stray headings y ### subsections) → línea de contenido
    if (current) current.lines.push(line)
  }
  return sections
}

// Parsea un texto con **bold** y *italic* en runs tipados
function parseInline(text) {
  const runs = []
  const re   = /\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last   = 0, m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false, italic: false })
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true,  italic: false })
    else                    runs.push({ text: m[2], bold: false, italic: true  })
    last = m.index + m[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false, italic: false })
  return runs.length ? runs : [{ text, bold: false, italic: false }]
}

// Renderiza texto con inline bold/italic desde posición x,y
function renderInline(doc, text, x, y, opts, fontSize, color) {
  const runs  = parseInline(text)
  const plain = runs.length === 1 && !runs[0].bold && !runs[0].italic
  if (plain) {
    doc.font('Helvetica').fontSize(fontSize).fillColor(color).text(text, x, y, opts)
    return
  }
  for (let i = 0; i < runs.length; i++) {
    const run    = runs[i]
    const isLast = i === runs.length - 1
    const font   = run.bold ? 'Helvetica-Bold' : run.italic ? 'Helvetica-Oblique' : 'Helvetica'
    doc.font(font).fontSize(fontSize).fillColor(color)
    if (i === 0) doc.text(run.text, x, y, { ...opts, continued: !isLast })
    else         doc.text(run.text, { ...opts, continued: !isLast })
  }
}

// Agrupa líneas consecutivas en bloques tipados: heading, paragraph, bullet, numbered, table
function groupLines(lines) {
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    // Heading inline (cualquier # stray dentro del contenido de una sección)
    const hm = line.match(/^(#{1,4}) (.+)/)
    if (hm) { blocks.push({ type: 'heading', level: hm[1].length, text: hm[2] }); i++; continue }

    // Tabla
    if (line.trimStart().startsWith('|')) {
      const tableLines = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) { tableLines.push(lines[i]); i++ }
      const rows = tableLines
        .filter(l => !/^\s*\|[-\s|:]+\|\s*$/.test(l))
        .map(l => l.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim()))
      if (rows.length > 0) blocks.push({ type: 'table', header: rows[0], rows: rows.slice(1) })
      continue
    }

    // Separador horizontal
    if (/^[-*_]{3,}\s*$/.test(line.trim())) { blocks.push({ type: 'hr' }); i++; continue }

    // Bullet (- o *)
    const bullet = line.match(/^[-*]\s+(.+)/)
    if (bullet) { blocks.push({ type: 'bullet', text: bullet[1] }); i++; continue }

    // Lista numerada
    const numbered = line.match(/^(\d+)\.\s+(.+)/)
    if (numbered) { blocks.push({ type: 'numbered', num: numbered[1], text: numbered[2] }); i++; continue }

    // Párrafo
    blocks.push({ type: 'paragraph', text: line })
    i++
  }
  return blocks
}

// docType = "Pitch Document", gameTitle = "NOCLIP III"
function drawCover(doc, docType, gameTitle, subtitle) {
  const W  = doc.page.width
  const H  = doc.page.height
  const MX = 64

  doc.rect(0, 0, W, H).fill(PDF_COVER_BG)
  doc.rect(0, 0, W, 8).fill(PDF_EMBER)

  // Label tipo de documento (pequeño, ember)
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PDF_EMBER)
    .text(docType.toUpperCase(), MX, 40, { characterSpacing: 1.5, lineBreak: false })

  // CONFIDENTIAL a la derecha
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
    .text('CONFIDENTIAL', W - MX - 80, 42, { width: 80, align: 'right', lineBreak: false })

  // Barra vertical decorativa
  doc.rect(MX - 16, 80, 4, 200).fillOpacity(0.2).fill(PDF_EMBER)
  doc.fillOpacity(1)

  // Nombre del juego — protagonista
  const mainTitle = gameTitle || docType
  doc.font('Helvetica-Bold').fontSize(48).fillColor('#ffffff')
    .text(mainTitle, MX, 90, { width: W - MX * 2, lineGap: 4 })

  const afterTitle = doc.y + 16
  doc.rect(MX, afterTitle, 80, 3).fill(PDF_EMBER)

  if (subtitle) {
    doc.font('Helvetica').fontSize(13).fillColor('#9ca3af')
      .text(subtitle, MX, afterTitle + 22, { width: W - MX * 2, lineGap: 4 })
  }

  // Footer
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PDF_EMBER)
    .text('FORGE AI', MX, H - 48, { lineBreak: false })
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
    .text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), MX, H - 34, { lineBreak: false })
  doc.rect(0, H - 8, W, 8).fill(PDF_EMBER)
}

function drawContentPageBg(doc) {
  const W = doc.page.width
  doc.rect(0, 0, W, doc.page.height).fill(PDF_BG)
  // Franja ember superior delgada
  doc.rect(0, 0, W, 4).fill(PDF_EMBER)
}

function drawPageHeader(doc, title) {
  const W = doc.page.width
  doc.font('Helvetica').fontSize(7).fillColor(PDF_DIM)
    .text(title.toUpperCase(), 60, 16, { characterSpacing: 1, lineBreak: false })
  doc.rect(60, 28, W - 120, 0.5).fill(PDF_LINE)
}

async function docGenDocx(title, content, projectId, nodeId) {
  // Limpiar trailing signoffs del LLM (texto después del último --- cerca del final)
  let cleanContent = content || title
  const lastHr = cleanContent.lastIndexOf('\n---\n')
  if (lastHr !== -1 && cleanContent.length - lastHr < 800) {
    cleanContent = cleanContent.slice(0, lastHr)
  }

  const sections = parseMarkdownSections(cleanContent)

  // Separar "Pitch Document" de "NOCLIP III" para la portada
  const dashIdx  = title.indexOf(' — ')
  const docType  = dashIdx !== -1 ? title.slice(0, dashIdx)  : title
  const gameTitle = dashIdx !== -1 ? title.slice(dashIdx + 3) : ''

  const buffer = await pdfBuffer(doc => {
    const W         = doc.page.width
    const MARGIN    = 60
    const CONTENT_W = W - MARGIN * 2

    // ── Portada ───────────────────────────────────────────────────────────────
    const h1 = sections.find(s => s.level === 1)
    // Subtitle: primera línea de metadata corta (con · o <100 chars), no párrafos de contenido
    const firstSection = sections.find(s => s.level >= 2)
    const isSubLine = l => {
      const t = l.trim()
      return t
        && !/^#{1,4} /.test(t)         // no heading
        && !/^[-*_]{3,}\s*$/.test(t)   // no HR
        && !t.startsWith('**')         // no párrafo bold
        && t.length < 100              // corto — es metadata, no cuerpo
    }
    const subtitle = h1?.lines?.find(isSubLine)?.trim()
      ?? firstSection?.lines?.find(isSubLine)?.trim()
      ?? ''
    drawCover(doc, docType, gameTitle || h1?.title || title, subtitle)

    const contentSections = sections.filter(s => s.level >= 2)
    if (!contentSections.length) return

    // ── Primera página de contenido ───────────────────────────────────────────
    doc.addPage({ margin: 0, size: 'A4' })
    drawContentPageBg(doc)
    drawPageHeader(doc, title)
    let y = 44

    function checkPageBreak(needed = 80) {
      if (y > doc.page.height - needed) {
        doc.addPage({ margin: 0, size: 'A4' })
        drawContentPageBg(doc)
        drawPageHeader(doc, title)
        y = 44
      }
    }

    for (const section of contentSections) {
      checkPageBreak(100)

      const sectionLabel = section.title
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())

      if (section.level === 2) {
        // H2 — barra ember + título grande + línea separadora
        doc.rect(MARGIN, y + 3, 4, 16).fill(PDF_EMBER)
        doc.font('Helvetica-Bold').fontSize(15).fillColor(PDF_TEXT)
          .text(sectionLabel, MARGIN + 12, y, { width: CONTENT_W - 12 })
        y = doc.y + 8
        doc.rect(MARGIN, y, CONTENT_W, 0.5).fill(PDF_LINE)
        y += 12
      } else {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(PDF_H3_CLR)
          .text(sectionLabel, MARGIN, y, { width: CONTENT_W })
        y = doc.y + 8
      }

      const blocks = groupLines(section.lines)

      for (const block of blocks) {
        checkPageBreak(40)

        if (block.type === 'hr') {
          doc.rect(MARGIN, y + 5, CONTENT_W, 0.5).fill(PDF_LINE)
          y += 16

        } else if (block.type === 'heading') {
          // Heading dentro de una sección (###, ####, o # stray)
          const lvl      = block.level
          const fontSize = lvl <= 1 ? 16 : lvl === 2 ? 13 : lvl === 3 ? 11 : 10
          const color    = lvl <= 1 ? PDF_TEXT : PDF_H3_CLR
          checkPageBreak(fontSize + 20)
          doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(color)
            .text(block.text, MARGIN, y, { width: CONTENT_W })
          y = doc.y + (lvl <= 2 ? 10 : 6)

        } else if (block.type === 'bullet') {
          // Bullet cuadrado ember
          doc.rect(MARGIN + 2, y + 5, 4, 4).fill(PDF_EMBER)
          renderInline(doc, block.text, MARGIN + 14, y, { width: CONTENT_W - 14, lineGap: 3 }, 10, PDF_TEXT)
          y = doc.y + 5

        } else if (block.type === 'numbered') {
          doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF_EMBER)
            .text(`${block.num}.`, MARGIN, y, { width: 16, lineBreak: false })
          renderInline(doc, block.text, MARGIN + 20, y, { width: CONTENT_W - 20, lineGap: 3 }, 10, PDF_TEXT)
          y = doc.y + 5

        } else if (block.type === 'paragraph') {
          renderInline(doc, block.text, MARGIN, y, { width: CONTENT_W, lineGap: 3 }, 10, PDF_TEXT)
          y = doc.y + 5

        } else if (block.type === 'table') {
          const { header, rows } = block
          const allRows  = [header, ...rows]
          const colCount = Math.max(...allRows.map(r => r.length))
          const colW     = CONTENT_W / colCount
          const rowH     = 20
          const cellPad  = 5

          checkPageBreak(rowH * (allRows.length + 1) + 10)

          for (let ri = 0; ri < allRows.length; ri++) {
            const row      = allRows[ri]
            const isHeader = ri === 0
            checkPageBreak(rowH + 8)

            doc.rect(MARGIN, y, CONTENT_W, rowH)
              .fill(isHeader ? PDF_EMBER : ri % 2 === 0 ? PDF_SUBTLE : PDF_BG)
            doc.rect(MARGIN, y + rowH, CONTENT_W, 0.5).fill(PDF_LINE)

            for (let ci = 0; ci < colCount; ci++) {
              const cellText = row[ci] ?? ''
              const cx       = MARGIN + ci * colW
              doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
                .fontSize(9)
                .fillColor(isHeader ? '#ffffff' : PDF_TEXT)
                .text(cellText, cx + cellPad, y + cellPad, {
                  width:     colW - cellPad * 2,
                  height:    rowH - cellPad,
                  ellipsis:  true,
                  lineBreak: false,
                })
            }
            y += rowH
          }
          y += 12
        }

        checkPageBreak(40)
      }
      y += 18
    }

    // ── Número de página en cada página de contenido + franja ember inferior ──
    const range = doc.bufferedPageRange()
    const total = range.count - 1  // sin contar portada
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i)
      const isContent = i > range.start
      if (isContent) {
        const pageNum = i - range.start
        doc.font('Helvetica').fontSize(8).fillColor(PDF_DIM)
          .text(`${pageNum} / ${total}`, W - MARGIN - 30, doc.page.height - 22, { width: 30, align: 'right', lineBreak: false })
      }
      doc.rect(0, doc.page.height - 4, W, 4).fill(PDF_EMBER)
    }
  })

  const slug        = `${Date.now()}`
  const storagePath = `projects/${projectId}/tools/doc_${slug}.pdf`
  const url         = await uploadToStorage(buffer, storagePath, 'application/pdf')

  return { success: true, url, filename: `${title || 'document'}.pdf`, format: 'pdf' }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function executeTool(name, args, context = {}) {
  console.log(`[tools] executing ${name}`, args)

  switch (name) {
    case 'web_search':
      return webSearch(args.query || '')

    case 'web_fetch':
      if (!args.url) return { success: false, error: 'url is required' }
      return webFetch(args.url)

    case 'doc_gen_docx':
      if (!args.content) return { success: false, error: 'content is required' }
      return docGenDocx(args.title || 'Document', args.content, context.project_id, context.node_id)

    case 'kb_read':
      return { success: false, error: 'Knowledge base not implemented yet. This tool is reserved for future use.' }

    default:
      return { success: false, error: `Unknown tool: ${name}` }
  }
}

module.exports = { getToolsBlock, parseToolCalls, executeTool }
