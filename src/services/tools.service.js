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
  doc_gen_pptx: {
    description: 'Generate and export a PowerPoint presentation deck following the V57 cinematic template structure. Returns a download URL. IMPORTANT: Use the labeled field format from the skill template — each ## slide section must use the exact field labels (Eyebrow:, Title:, Tagline:, GENRE:, PLATFORM:, etc.) so the renderer can apply the correct layout per slide. Do NOT flatten the template fields into plain prose.',
    args: {
      title:   'string — presentation title (format: "Document Type — Project Name")',
      content: 'string — slide content following the v57_cinematic_deck_template field structure: ## Slide N — Name, then labeled fields as bullets (- Eyebrow: ..., - Title: ..., - Tagline: ..., - GENRE: ..., etc.)',
      images:  'array (optional) — image URLs to embed in slides, referenced by index position',
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

// ─── PPTX: parser inteligente de template fields V57 ─────────────────────────

// Campos de metadata que se omiten del output visual
const PPTX_SKIP_LABELS = new Set([
  'Studio', 'File reference', 'Sign-off', 'Footer', 'Image',
  'Badge', 'Section', 'Kicker', 'Slide', 'Credit',
])

// Conjunto completo de labels conocidos (para evitar falsos positivos)
const PPTX_KNOWN_LABELS = new Set([
  ...PPTX_SKIP_LABELS,
  'Eyebrow', 'Title', 'Tagline', 'Line', 'Support line', 'The real claim', 'Kicker line',
  'Subtitle', 'Intro', 'Setup',
])

// Extrae label y valor de "Label: value" (con o sin bullet prefix, con o sin **bold**)
function pptxExtractField(rawLine) {
  const line = rawLine.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim()
  const m = line.match(/^([A-Za-z][A-Za-z\s/&-]{0,28}):\s*(.+)/)
  if (!m) return null
  const label = m[1].trim()
  const isAllCaps = label.length > 1 && label === label.toUpperCase() && /^[A-Z]/.test(label)
  if (!isAllCaps && !PPTX_KNOWN_LABELS.has(label)) return null
  return { label, value: m[2].trim(), isAllCaps }
}

// Analiza el cuerpo de una slide y categoriza cada elemento
function pptxParseSlideBody(lines) {
  const out = { eyebrow: null, title: null, taglines: [], factSheet: [], bullets: [], paragraphs: [] }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || /^#{1,4}\s/.test(line) || /^---+$/.test(line)) continue

    const field = pptxExtractField(line)
    if (field) {
      const { label, value, isAllCaps } = field
      if (PPTX_SKIP_LABELS.has(label))  { continue }
      if (isAllCaps)                     { out.factSheet.push({ label, value }); continue }
      if (label === 'Eyebrow')           { out.eyebrow = value; continue }
      if (label === 'Title')             { out.title   = value; continue }
      if (['Tagline', 'Line', 'Support line', 'The real claim', 'Kicker line', 'Subtitle'].includes(label)) {
        out.taglines.push(value); continue
      }
      continue
    }

    if (/^[-*•]\s+/.test(raw)) {
      const t = raw.replace(/^[-*•]\s+/, '').trim()
      if (t) out.bullets.push(t)
    } else {
      out.paragraphs.push(line)
    }
  }
  return out
}

// ── Layout hero: eyebrow + título grande + tagline (fondo imagen full-bleed) ──
function renderHeroSlide(slide, sectionTitle, body, img, C) {
  const cl = s => (s || '').replace(/\*\*/g, '').replace(/\*/g, '').trim()
  const W  = img ? 6.8 : 12.3

  if (img) {
    slide.addImage({ data: img, x: 0, y: 0, w: 13.33, h: 7.5 })
    slide.addShape('rect', { x: 0,   y: 0, w: 13.33, h: 7.5, fill: { color: '000000', transparency: 30 } })
    slide.addShape('rect', { x: 0,   y: 0, w: 7.8,   h: 7.5, fill: { color: C.BG_DARK, transparency: 40 } })
  }

  const eyebrow   = body.eyebrow   || sectionTitle
  const heroTitle = body.title     || sectionTitle
  const tagline   = body.taglines[0] || ''

  slide.addText(cl(eyebrow).toUpperCase(), {
    x: 0.6, y: 0.88, w: W, h: 0.28,
    fontSize: 8, color: C.AMBER, bold: true, charSpacing: 3.5,
  })
  slide.addShape('rect', { x: 0.6, y: 1.26, w: 0.65, h: 0.035, fill: { color: C.AMBER } })
  slide.addText(cl(heroTitle), {
    x: 0.55, y: 1.38, w: W, h: 3.1,
    fontSize: 38, color: C.WHITE, bold: true, breakLine: true, valign: 'top', fontFace: 'Calibri',
  })
  if (tagline) {
    slide.addText(`"${cl(tagline)}"`, {
      x: 0.6, y: 4.7, w: W, h: 0.55, fontSize: 14, color: C.GRAY, italic: true, breakLine: true,
    })
  }
  let bY = tagline ? 5.38 : 4.75
  for (const b of body.bullets.slice(0, 3)) {
    if (bY > 6.8) break
    slide.addText([
      { text: '▪  ', options: { color: C.AMBER, bold: true } },
      { text: cl(b), options: { color: C.LIGHT } },
    ], { x: 0.7, y: bY, w: W, h: 0.36, fontSize: 10, breakLine: true })
    bY += 0.38
  }
}

// ── Layout fact sheet: grid 2-col de pares clave/valor en MAYÚSCULAS ──────────
function renderFactSheetSlide(slide, sectionTitle, body, img, C) {
  const cl  = s => (s || '').replace(/\*\*/g, '').replace(/\*/g, '').trim()
  const TWX = img ? 8.1 : 12.7
  const TX  = 0.5

  if (img) {
    slide.addImage({ data: img, x: 8.7, y: 0.65, w: 4.35, h: 5.1 })
    slide.addShape('rect', { x: 8.7, y: 0.65, w: 4.35, h: 5.1, fill: { color: '000000', transparency: 55 } })
  }

  if (body.eyebrow) {
    slide.addText(cl(body.eyebrow).toUpperCase(), {
      x: TX, y: 0.18, w: TWX, h: 0.25, fontSize: 8, color: C.AMBER, bold: true, charSpacing: 3,
    })
  }
  const headY = body.eyebrow ? 0.5 : 0.22
  slide.addText(cl(sectionTitle).replace(/_/g, ' '), {
    x: TX, y: headY, w: TWX, h: 0.55, fontSize: 22, color: C.WHITE, bold: true,
  })
  slide.addShape('rect', { x: TX, y: headY + 0.6, w: TWX, h: 0.03, fill: { color: C.AMBER } })

  const colW  = (TWX - 0.2) / 2
  const ROW_H = 0.72
  let fy = headY + 0.72

  for (let i = 0; i < body.factSheet.length; i += 2) {
    const a = body.factSheet[i]
    const b = body.factSheet[i + 1]
    if (fy + ROW_H > 7.0) break

    slide.addShape('rect', {
      x: TX, y: fy, w: TWX, h: ROW_H,
      fill: { color: i % 4 === 0 ? C.BG_CARD : C.BG_SLIDE },
    })

    slide.addText(a.label, {
      x: TX + 0.14, y: fy + 0.07, w: colW - 0.2, h: 0.22,
      fontSize: 7.5, color: C.AMBER, bold: true, charSpacing: 1.5,
    })
    slide.addText(cl(a.value), {
      x: TX + 0.14, y: fy + 0.3, w: colW - 0.2, h: 0.34,
      fontSize: 13, color: C.WHITE, bold: true, breakLine: true,
    })

    if (b) {
      slide.addText(b.label, {
        x: TX + colW + 0.2, y: fy + 0.07, w: colW - 0.2, h: 0.22,
        fontSize: 7.5, color: C.AMBER, bold: true, charSpacing: 1.5,
      })
      slide.addText(cl(b.value), {
        x: TX + colW + 0.2, y: fy + 0.3, w: colW - 0.2, h: 0.34,
        fontSize: 13, color: C.WHITE, bold: true, breakLine: true,
      })
    }

    slide.addShape('rect', { x: TX, y: fy + ROW_H, w: TWX, h: 0.012, fill: { color: C.DIVIDER } })
    fy += ROW_H
  }

  if (body.bullets.length > 0 && fy < 6.8) {
    fy += 0.18
    for (const b of body.bullets.slice(0, 3)) {
      if (fy > 6.9) break
      slide.addText([
        { text: '▪  ', options: { color: C.AMBER, bold: true } },
        { text: cl(b), options: { color: C.LIGHT } },
      ], { x: TX + 0.1, y: fy, w: TWX - 0.1, h: 0.36, fontSize: 10, breakLine: true })
      fy += 0.38
    }
  }
}

// ── Layout contenido: título + bullets + párrafos ─────────────────────────────
function renderContentSlide(slide, sectionTitle, body, img, C) {
  const cl  = s => (s || '').replace(/\*\*/g, '').replace(/\*/g, '').trim()
  const TWX = img ? 8.0 : 12.6
  const TX  = 0.5

  if (img) {
    slide.addImage({ data: img, x: 8.8, y: 0.7, w: 4.25, h: 5.1 })
    slide.addShape('rect', { x: 8.8, y: 0.7, w: 4.25, h: 5.1, fill: { color: '000000', transparency: 60 } })
  }

  let headY = 0.18
  if (body.eyebrow) {
    slide.addText(cl(body.eyebrow).toUpperCase(), {
      x: TX, y: headY, w: TWX, h: 0.25, fontSize: 8, color: C.AMBER, bold: true, charSpacing: 3,
    })
    headY += 0.3
  }
  slide.addText(cl(sectionTitle).replace(/_/g, ' '), {
    x: TX, y: headY, w: TWX, h: 0.55, fontSize: 22, color: C.WHITE, bold: true, breakLine: true,
  })
  const divY = headY + 0.6
  slide.addShape('rect', { x: TX, y: divY, w: TWX, h: 0.025, fill: { color: C.AMBER } })

  let cy = divY + 0.22
  const items = [
    ...body.taglines.map(t  => ({ kind: 'tagline', text: t })),
    ...body.bullets.map(b   => ({ kind: 'bullet',  text: b })),
    ...body.paragraphs.map(p => ({ kind: 'para',    text: p })),
  ]

  for (const item of items) {
    if (cy > 6.8) break
    if (item.kind === 'tagline') {
      slide.addText(cl(item.text), {
        x: TX, y: cy, w: TWX, h: 0.44, fontSize: 14, color: C.LIGHT, italic: true, breakLine: true,
      })
      cy += 0.48
    } else if (item.kind === 'bullet') {
      slide.addText([
        { text: '▪  ', options: { color: C.AMBER, bold: true } },
        { text: cl(item.text), options: { color: C.LIGHT } },
      ], { x: TX + 0.15, y: cy, w: TWX - 0.2, h: 0.38, fontSize: 10.5, breakLine: true })
      cy += 0.41
    } else {
      slide.addText(cl(item.text), {
        x: TX, y: cy, w: TWX, h: 0.38, fontSize: 10.5, color: C.GRAY, breakLine: true,
      })
      cy += 0.42
    }
  }
}

// ─── PPTX generator ──────────────────────────────────────────────────────────

async function docGenPptx(title, content, images, projectId, nodeId) {
  const PptxGenJS = require('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE' // 13.33" × 7.5"

  // Paleta V57 cinematic
  const C = {
    BG_DARK:  '0d0f14',
    BG_SLIDE: '111318',
    BG_CARD:  '1a1e27',
    AMBER:    'F59E0B',
    WHITE:    'FFFFFF',
    LIGHT:    'E5E7EB',
    GRAY:     '9CA3AF',
    GRAY_DIM: '4B5563',
    DIVIDER:  '2D3748',
  }

  // Descargar imágenes como base64 para embeber en la presentación
  const imgData = []
  for (const url of (images || [])) {
    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(12000) })
      const buf  = await res.arrayBuffer()
      const b64  = Buffer.from(buf).toString('base64')
      const mime = res.headers.get('content-type') || 'image/png'
      imgData.push(`data:${mime};base64,${b64}`)
    } catch { imgData.push(null) }
  }
  const validImgs = imgData.filter(Boolean)

  // Secciones de output-format wrapper que no son slides (investor_deck, output, etc.)
  const OUTPUT_WRAPPER = /^(investor_deck|output|result|response|deck)$/i
  const sections      = parseMarkdownSections(content)
  const contentSlides = sections.filter(s => s.level >= 2 && !OUTPUT_WRAPPER.test(s.title.trim()))

  const dashIdx  = title.indexOf(' — ')
  const gameTitle = dashIdx !== -1 ? title.slice(dashIdx + 3) : title
  const docType   = dashIdx !== -1 ? title.slice(0, dashIdx)  : 'INVESTOR DECK'

  // Detectar slide de portada (primera sección si su título contiene "cover" o "slide 01")
  const isCoverTitle = t => /cover|portada|slide\s*0*1\b/i.test(t)
  const coverSec     = contentSlides[0] && isCoverTitle(contentSlides[0].title) ? contentSlides[0] : null
  const coverBody    = coverSec ? pptxParseSlideBody(coverSec.lines) : { eyebrow: null, title: null, taglines: [], factSheet: [], bullets: [], paragraphs: [] }

  const coverTitle   = coverBody.title       || gameTitle
  const coverTagline = coverBody.taglines[0] || ''
  const coverEyebrow = coverBody.eyebrow     || docType.toUpperCase()

  function amberStripe(slide, y) {
    slide.addShape('rect', { x: 0, y, w: 13.33, h: 0.055, fill: { color: C.AMBER } })
  }

  // ── Slide 1: Cover ─────────────────────────────────────────────────────────
  const cover = pptx.addSlide()
  cover.background = { color: C.BG_DARK }

  if (validImgs[0]) {
    cover.addImage({ data: validImgs[0], x: 7.1, y: 0.06, w: 6.23, h: 7.38 })
    cover.addShape('rect', { x: 7.1, y: 0.06, w: 6.23, h: 7.38, fill: { color: '000000', transparency: 30 } })
    cover.addShape('rect', { x: 5.5, y: 0,    w: 2.1,  h: 7.5,  fill: { color: C.BG_DARK, transparency: 40 } })
  }

  cover.addText(coverEyebrow.replace(/\*\*/g, '').toUpperCase(), {
    x: 0.55, y: 1.1, w: 6.3, h: 0.28, fontSize: 8, color: C.AMBER, bold: true, charSpacing: 3.5,
  })
  cover.addShape('rect', { x: 0.55, y: 1.5, w: 0.8, h: 0.04, fill: { color: C.AMBER } })
  cover.addText(coverTitle.replace(/\*\*/g, ''), {
    x: 0.5, y: 1.65, w: 6.3, h: 3.2,
    fontSize: 52, color: C.WHITE, bold: true, breakLine: true, valign: 'top', fontFace: 'Calibri',
  })
  if (coverTagline) {
    cover.addText(`"${coverTagline.replace(/\*\*/g, '')}"`, {
      x: 0.55, y: 5.05, w: 6.3, h: 0.7, fontSize: 14, color: C.GRAY, italic: true, breakLine: true,
    })
  }
  cover.addText('V57 STUDIO', {
    x: 0.55, y: 6.86, w: 3, h: 0.25, fontSize: 8, color: C.AMBER, bold: true, charSpacing: 2,
  })
  cover.addText('CONFIDENTIAL  ·  INTERNAL USE ONLY', {
    x: 0.55, y: 7.13, w: 7, h: 0.22, fontSize: 7, color: C.GRAY_DIM,
  })
  amberStripe(cover, 0)
  amberStripe(cover, 7.44)

  // ── Content slides ─────────────────────────────────────────────────────────
  const loopStart = coverSec ? 1 : 0
  let imgCursor   = validImgs.length > 1 ? 1 : 0

  for (let si = loopStart; si < contentSlides.length; si++) {
    const sec  = contentSlides[si]
    const body = pptxParseSlideBody(sec.lines)

    const hasHero = body.title !== null || body.taglines.length > 0
    const hasFact = body.factSheet.length >= 2
    const slideImg = validImgs.length > 0 ? validImgs[imgCursor % validImgs.length] : null
    imgCursor++

    const slide = pptx.addSlide()
    slide.background = { color: C.BG_SLIDE }

    if (hasHero) {
      renderHeroSlide(slide, sec.title, body, slideImg, C)
    } else if (hasFact) {
      renderFactSheetSlide(slide, sec.title, body, slideImg, C)
    } else {
      renderContentSlide(slide, sec.title, body, slideImg, C)
    }

    // Barras amber encima de todo el contenido
    amberStripe(slide, 0)
    amberStripe(slide, 7.44)

    slide.addText(`${si - loopStart + 2}`, {
      x: 12.88, y: 7.1, w: 0.38, h: 0.25, fontSize: 8, color: C.GRAY_DIM, align: 'right',
    })
  }

  const buffer      = await pptx.write({ outputType: 'nodebuffer' })
  const slug        = Date.now()
  const storagePath = `projects/${projectId}/tools/deck_${slug}.pptx`
  const url         = await uploadToStorage(
    buffer, storagePath,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  )

  return { success: true, url, filename: `${title || 'deck'}.pptx`, format: 'pptx' }
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

    case 'doc_gen_pptx':
      if (!args.content) return { success: false, error: 'content is required' }
      return docGenPptx(args.title || 'Presentation', args.content, args.images || [], context.project_id, context.node_id)

    case 'kb_read':
      return { success: false, error: 'Knowledge base not implemented yet. This tool is reserved for future use.' }

    default:
      return { success: false, error: `Unknown tool: ${name}` }
  }
}

module.exports = { getToolsBlock, parseToolCalls, executeTool }
