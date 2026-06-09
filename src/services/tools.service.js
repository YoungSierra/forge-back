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
    description: 'Generate and export a PowerPoint presentation deck from a JSON deck object following the v57_cinematic_deck_template schema. Returns a download URL. The renderer applies layout automatically based on each slide\'s "type" field.',
    args: {
      title:   'string — the game title (used as filename)',
      content: 'object — the complete deck as a JSON object (NOT a string). Must have "meta" and "slides" keys following v57_cinematic_deck_template schema. Pass the object directly, do not serialize it to a string.',
      images:  'array — image URLs from Art Direction node in exact order: [image_wide_url, image_interior_url, image_object_url]. Extract these from the ## Input references section.',
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
  const { jsonrepair } = require('jsonrepair')
  const results = []
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const src = match[1].trim()
    let parsed = null
    try {
      parsed = JSON.parse(src)
    } catch {
      // JSON malformado — intentar reparar antes de descartar
      try { parsed = JSON.parse(jsonrepair(src)) } catch {}
    }
    if (parsed?.tool && typeof parsed.tool === 'string') {
      results.push({ tool: parsed.tool, args: parsed.args || {} })
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
  'Badge', 'Section', 'Kicker', 'Slide', 'Credit', 'Footnote',
  'Footer notes', 'Optional document ID', 'Optional badge',
])

const PPTX_KNOWN_LABELS = new Set([
  ...PPTX_SKIP_LABELS,
  'Eyebrow', 'Title', 'Tagline', 'Line', 'Support line', 'The real claim', 'Kicker line',
  'Subtitle', 'Intro', 'Setup', 'Thesis', 'Closing note',
])

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
  const out = {
    eyebrow: null, title: null, taglines: [], factSheet: [], dirItems: [],
    bullets: [], paragraphs: [], strikethrough: null, imageHint: null, compItems: [],
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || /^#{1,4}\s/.test(line) || /^---+$/.test(line)) continue

    const stripped = line.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim()

    // Image: image_wide/interior/object — capturar hint
    const imgMatch = stripped.match(/^Image\s*:\s*(image_\w+)/i)
    if (imgMatch) { out.imageHint = imgMatch[1].toLowerCase(); continue }

    // Paragraph N: — extraer solo el valor
    const paraMatch = stripped.match(/^Paragraph\s+\d+\s*:\s*(.+)/i)
    if (paraMatch) { out.paragraphs.push(paraMatch[1].trim()); continue }

    // Line N: — tagline sin prefijo numérico
    const lineNMatch = stripped.match(/^Line\s+\d+\s*:\s*(.+)/i)
    if (lineNMatch) { out.taglines.push(lineNMatch[1].trim()); continue }

    // What it is NOT: — tachado
    const strikeMatch = stripped.match(/^What(?:\s+it\s+is|\s+the\s+game\s+is)\s+NOT[^:]*:\s*(.+)/i)
    if (strikeMatch) {
      out.strikethrough = strikeMatch[1].replace(/~~(.+?)~~/g, '$1').trim()
      continue
    }

    // VISUAL — style: value / AUDIO — style: value → direction items (full-width, no stats bar)
    const dirMatch = stripped.match(/^(VISUAL|AUDIO)\s*[—–-]+\s*([^:]{1,50}):\s*(.+)/i)
    if (dirMatch) {
      out.dirItems.push({ label: dirMatch[1].toUpperCase() + ' — ' + dirMatch[2].trim(), value: dirMatch[3].trim() })
      continue
    }

    const field = pptxExtractField(line)
    if (field) {
      const { label, value, isAllCaps } = field
      if (PPTX_SKIP_LABELS.has(label)) { continue }
      // Items de comparación: all-caps label CON → en el valor → comparison table, no stats bar
      if (isAllCaps && value.includes('→')) { out.compItems.push(value); continue }
      if (isAllCaps)                    { out.factSheet.push({ label, value }); continue }
      if (label === 'Eyebrow')          { out.eyebrow = value; continue }
      if (label === 'Title')            { out.title   = value; continue }
      // Subtitle → párrafo (sin comillas — distinto de Line/Tagline)
      if (label === 'Subtitle')         { out.paragraphs.push(value); continue }
      if (['Tagline', 'Line', 'Support line', 'The real claim', 'Kicker line'].includes(label)) {
        out.taglines.push(value); continue
      }
      if (label === 'Thesis' || label === 'Closing note') {
        out.paragraphs.push(value); continue
      }
      continue
    }

    if (/^[-*•]\s+/.test(raw)) {
      const t = raw.replace(/^[-*•]\s+/, '').trim()
      // Bullet con → es item de tabla de comparación
      if (t && t.includes('→')) out.compItems.push(t)
      else if (t)                out.bullets.push(t)
    } else {
      out.paragraphs.push(line)
    }
  }
  return out
}

// ── Layout hero ──────────────────────────────────────────────────────────────
function renderHeroSlide(slide, sectionTitle, body, img, C) {
  const cl = s => (s || '').replace(/\*\*/g, '').replace(/\*/g, '').trim()
  const W  = img ? 6.8 : 12.3

  if (img) {
    slide.addImage({ data: img, x: 0, y: 0, w: 13.33, h: 7.5 })
    slide.addShape('rect', { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: '000000', transparency: 30 } })
    slide.addShape('rect', { x: 0, y: 0, w: 7.8,   h: 7.5, fill: { color: C.BG_DARK, transparency: 40 } })
  }

  const eyebrow = body.eyebrow || null

  // Si no hay Title: explícito, usar el primer tagline como claim principal (slides tipo statement/twist)
  const hasExplicitTitle = body.title !== null
  const heroTitle        = body.title || (body.taglines.length > 0 ? body.taglines[0] : null)
  const subTaglines      = hasExplicitTitle ? body.taglines : body.taglines.slice(1)

  const hasStats   = body.factSheet.length >= 2 && body.factSheet.length <= 6
  const hasDirItems = body.dirItems.length > 0
  const hasContent = body.bullets.length + body.paragraphs.length > 0 || body.strikethrough || hasDirItems

  // Font del título según densidad de contenido
  const titleFontSize = hasContent ? (heroTitle && heroTitle.length > 60 ? 26 : 30) : 38
  const titleH        = hasContent ? 2.2 : 3.1

  if (eyebrow) {
    slide.addText(cl(eyebrow).toUpperCase(), {
      x: 0.6, y: 0.88, w: W, h: 0.28, fontSize: 8, color: C.AMBER, bold: true, charSpacing: 3.5,
    })
    slide.addShape('rect', { x: 0.6, y: 1.26, w: 0.65, h: 0.035, fill: { color: C.AMBER } })
  }

  if (heroTitle) {
    slide.addText(cl(heroTitle), {
      x: 0.55, y: 1.38, w: W, h: titleH,
      fontSize: titleFontSize, color: C.WHITE, bold: true, breakLine: true, valign: 'top', fontFace: 'Calibri',
    })
  }

  let cy = 1.38 + titleH + 0.08

  // Sub-taglines con comillas — máx 2
  for (const tl of subTaglines.slice(0, 2)) {
    if (cy > 5.8) break
    slide.addText(`"${cl(tl)}"`, {
      x: 0.6, y: cy, w: W, h: 0.5, fontSize: 12, color: C.GRAY, italic: true, breakLine: true,
    })
    cy += 0.54
  }

  // Línea tachada (What it is NOT)
  if (body.strikethrough && cy <= 6.0) {
    slide.addText(cl(body.strikethrough), {
      x: 0.6, y: cy, w: W, h: 0.34,
      fontSize: 11, color: C.GRAY_DIM, italic: true, strike: true, breakLine: true,
    })
    cy += 0.38
  }

  // Direction items (VISUAL/AUDIO) — full-width, label en amber + valor en LIGHT
  for (const di of body.dirItems.slice(0, 2)) {
    if (cy > 6.4) break
    slide.addShape('rect', { x: 0.55, y: cy - 0.02, w: W, h: 0.76, fill: { color: C.BG_CARD } })
    slide.addShape('rect', { x: 0.55, y: cy - 0.02, w: 0.03, h: 0.76, fill: { color: C.AMBER } })
    slide.addText(cl(di.label), {
      x: 0.7, y: cy, w: W - 0.2, h: 0.2, fontSize: 8, color: C.AMBER, bold: true, charSpacing: 1.5,
    })
    slide.addText(cl(di.value), {
      x: 0.7, y: cy + 0.22, w: W - 0.2, h: 0.5, fontSize: 9.5, color: C.LIGHT, breakLine: true,
    })
    cy += 0.8
  }

  // Bullets y párrafos
  const bodyItems = [
    ...body.bullets.map(b   => ({ kind: 'bullet', text: b })),
    ...body.paragraphs.map(p => ({ kind: 'para',   text: p })),
  ]
  for (const item of bodyItems.slice(0, 4)) {
    if (cy > 6.2) break
    if (item.kind === 'bullet') {
      slide.addText([
        { text: '▪  ', options: { color: C.AMBER, bold: true } },
        { text: cl(item.text), options: { color: C.LIGHT } },
      ], { x: 0.6, y: cy, w: W, h: 0.38, fontSize: 10, breakLine: true })
    } else {
      slide.addText(cl(item.text), {
        x: 0.6, y: cy, w: W, h: 0.38, fontSize: 10, color: C.GRAY, breakLine: true,
      })
    }
    cy += 0.41
  }

  // Stats bar — solo para facts cortos (SCOPE/TEAM/PLATFORM/WINDOW), no para direction
  if (hasStats && !hasDirItems) {
    const stats = body.factSheet.slice(0, 4)
    const statW = W / stats.length
    const statY = 6.28
    stats.forEach((f, i) => {
      const sx = 0.55 + i * statW
      slide.addShape('rect', { x: sx, y: statY - 0.08, w: statW - 0.12, h: 0.95, fill: { color: C.BG_CARD } })
      slide.addShape('rect', { x: sx, y: statY - 0.08, w: 0.03, h: 0.95, fill: { color: C.AMBER } })
      slide.addText(cl(f.label), {
        x: sx + 0.1, y: statY, w: statW - 0.22, h: 0.2,
        fontSize: 7, color: C.AMBER, bold: true, charSpacing: 1.5,
      })
      slide.addText(cl(f.value), {
        x: sx + 0.1, y: statY + 0.22, w: statW - 0.22, h: 0.56,
        fontSize: 10, color: C.WHITE, bold: true, breakLine: true,
      })
    })
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
  const headY    = body.eyebrow ? 0.5 : 0.22
  const headText = body.title ? cl(body.title) : cl(sectionTitle).replace(/_/g, ' ')
  slide.addText(headText, {
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

// ── Layout comparison table: izquierda tachada / derecha numerada ─────────────
function renderComparisonSlide(slide, sectionTitle, body, img, C) {
  const cl  = s => (s || '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/~~(.+?)~~/g, '$1').trim()
  const TWX = img ? 8.2 : 12.8
  const TX  = 0.5

  if (img) {
    slide.addImage({ data: img, x: 9.0, y: 0.6, w: 4.1, h: 5.2 })
    slide.addShape('rect', { x: 9.0, y: 0.6, w: 4.1, h: 5.2, fill: { color: '000000', transparency: 60 } })
  }

  // Eyebrow + título
  let headY = 0.18
  if (body.eyebrow) {
    slide.addText(body.eyebrow.toUpperCase(), {
      x: TX, y: headY, w: TWX, h: 0.25, fontSize: 8, color: C.AMBER, bold: true, charSpacing: 3,
    })
    headY += 0.3
  }
  const headText = body.title ? cl(body.title) : cl(sectionTitle)
  slide.addText(headText, {
    x: TX, y: headY, w: TWX, h: 0.5, fontSize: 20, color: C.WHITE, bold: true, breakLine: true,
  })
  slide.addShape('rect', { x: TX, y: headY + 0.55, w: TWX, h: 0.025, fill: { color: C.AMBER } })

  // Cabeceras de columna
  const colY  = headY + 0.65
  const LW    = TWX * 0.48
  const RW    = TWX * 0.48
  const RX    = TX + TWX * 0.52
  slide.addText('THE CATEGORY TODAY', {
    x: TX, y: colY, w: LW, h: 0.22, fontSize: 7.5, color: C.GRAY_DIM, bold: true, charSpacing: 1.5,
  })
  slide.addText('THIS PROJECT', {
    x: RX, y: colY, w: RW, h: 0.22, fontSize: 7.5, color: C.AMBER, bold: true, charSpacing: 1.5,
  })
  slide.addShape('rect', { x: TX, y: colY + 0.25, w: TWX, h: 0.012, fill: { color: C.DIVIDER } })

  // Filas de comparación
  const ROW_H = 0.72
  let ry = colY + 0.28
  for (const item of body.compItems.slice(0, 5)) {
    if (ry + ROW_H > 7.1) break

    // Separar "old part → 01 new part"
    const arrowIdx = item.indexOf('→')
    const leftRaw  = arrowIdx >= 0 ? item.slice(0, arrowIdx).trim() : item
    const rightRaw = arrowIdx >= 0 ? item.slice(arrowIdx + 1).trim() : ''

    // Limpiar strikethrough markdown del lado izquierdo
    const leftText  = leftRaw.replace(/~~(.+?)~~/g, '$1').replace(/\*\*/g,'').replace(/\*/g,'').trim()
    const rightText = rightRaw.replace(/\*\*/g,'').replace(/\*/g,'').trim()

    slide.addShape('rect', { x: TX, y: ry, w: TWX, h: ROW_H, fill: { color: C.BG_CARD } })
    slide.addShape('rect', { x: TX + LW + 0.04, y: ry, w: 0.012, h: ROW_H, fill: { color: C.DIVIDER } })

    slide.addText(leftText, {
      x: TX + 0.1, y: ry + 0.1, w: LW - 0.2, h: ROW_H - 0.2,
      fontSize: 9.5, color: C.GRAY_DIM, italic: true, strike: true, breakLine: true, valign: 'top',
    })
    slide.addText(rightText, {
      x: RX + 0.1, y: ry + 0.1, w: RW - 0.2, h: ROW_H - 0.2,
      fontSize: 10, color: C.LIGHT, bold: false, breakLine: true, valign: 'top',
    })
    slide.addShape('rect', { x: TX, y: ry + ROW_H, w: TWX, h: 0.01, fill: { color: C.DIVIDER } })
    ry += ROW_H
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

// ─── PPTX Cinematic Renderer (JSON schema v2) ────────────────────────────────

async function docGenPptxCinematic(deck, imageUrls, projectId) {
  const PptxGenJS = require('pptxgenjs')
  const https     = require('https')
  const http      = require('http')
  const fs        = require('fs')
  const pathMod   = require('path')
  const os        = require('os')

  const P = deck.meta?.palette || {}
  const C = {
    BG:      (P.bg      || '0A0D0A').replace('#', ''),
    SURFACE: (P.surface || '141814').replace('#', ''),
    CARD:    (P.card    || '1E241E').replace('#', ''),
    ACCENT:  (P.accent  || 'F5A623').replace('#', ''),
    WHITE:   'FFFFFF',
    LIGHT:   'D1D5DB',
    MUTED:   '6B7280',
    DIM:     '2D3530',
  }

  const W = 13.33, H = 7.5, M = 0.65
  const TITLE = 'Arial', MONO = 'Consolas', BODY = 'Calibri'
  const gameTitle = (deck.meta?.game_title || 'UNTITLED').toUpperCase()

  // Descarga una URL a un archivo temporal, siguiendo redirects hasta 5 saltos
  function downloadToFile(srcUrl, destPath, hops) {
    if (hops > 5) return Promise.reject(new Error('too many redirects'))
    return new Promise((resolve, reject) => {
      const lib = srcUrl.startsWith('https') ? https : http
      const req = lib.get(srcUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return resolve(downloadToFile(res.headers.location, destPath, hops + 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        const file = fs.createWriteStream(destPath)
        res.pipe(file)
        file.on('error', err => { fs.unlink(destPath, () => {}); reject(err) })
        file.on('close', resolve)
      })
      req.on('error', e => { fs.unlink(destPath, () => {}); reject(e) })
    })
  }

  // Descargar imágenes a archivos temporales
  const images = {}
  const imgKeys = ['image_wide', 'image_interior', 'image_object']
  for (let i = 0; i < imgKeys.length; i++) {
    const url = (imageUrls || [])[i]
    if (!url) continue
    const key = imgKeys[i]
    const tmpPath = pathMod.join(os.tmpdir(), `forge_deck_${Date.now()}_${key}.png`)
    try {
      await downloadToFile(url, tmpPath, 0)
      images[key] = tmpPath
    } catch (e) {
      console.warn(`[deck] ${key} no descargada:`, e.message)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function txt(sl, text, x, y, w, h, opts = {}) {
    const { size = 18, color = C.LIGHT, bold = false, italic = false,
            align = 'left', font = BODY } = opts
    const lines = String(text).split('\n')
    const arr   = lines.map((line, i) => ({
      text:    line,
      options: i < lines.length - 1 ? { breakLine: true } : {},
    }))
    sl.addText(arr, { x, y, w, h, fontSize: size, color, bold, italic,
                      fontFace: font, align, valign: 'top', wrap: true, isTextBox: true })
  }

  function rct(sl, prs, x, y, w, h, opts = {}) {
    const { fill, line, lineW = 0.5, alpha } = opts
    const o = { x, y, w, h }
    o.fill = fill
      ? (alpha !== undefined
          ? { type: 'solid', color: fill, transparency: 100 - alpha }
          : { type: 'solid', color: fill })
      : { type: 'none' }
    o.line = line ? { color: line, width: lineW } : { type: 'none' }
    sl.addShape(prs.ShapeType.rect, o)
  }

  function imgEl(sl, localPath, x, y, w, h) {
    sl.addImage({ path: localPath, x, y, w, h })
  }

  function overlay(sl, prs, x, y, w, h, alpha = 55) {
    rct(sl, prs, x, y, w, h, { fill: C.BG, alpha })
  }

  function brackets(sl, prs) {
    const s = 0.28, t = 0.022, p = 0.20
    ;[
      [[p, p, s, t], [p, p, t, s]],
      [[W-p-s, p, s, t], [W-p-t, p, t, s]],
      [[p, H-p-t, s, t], [p, H-p-s, t, s]],
      [[W-p-s, H-p-t, s, t], [W-p-t, H-p-s, t, s]],
    ].forEach(c => c.forEach(([x, y, w, h]) => rct(sl, prs, x, y, w, h, { fill: C.ACCENT })))
  }

  function chrome(sl, prs, section, page) {
    txt(sl, `${gameTitle}  //  ${section}`, M, 0.12, 10, 0.28,  { size: 9, color: C.MUTED, font: MONO })
    // right edge en 12.65 para no solaparse con el bracket vertical (x=13.11)
    txt(sl, `${String(page).padStart(2, '0')} / 12`, 11.5, 0.12, 1.15, 0.28, { size: 9, color: C.MUTED, font: MONO, align: 'right' })
    txt(sl, `${deck.meta?.studio || ''}  ·  CONFIDENTIAL`, M, H-0.38, 7, 0.26, { size: 8, color: C.MUTED, font: MONO })
    txt(sl, gameTitle, 10.3, H-0.38, 2.35, 0.26, { size: 8, color: C.MUTED, font: MONO, align: 'right' })
  }

  function eb(sl, text, x, y, w = 11) {
    txt(sl, `// ${text}`, x, y, w, 0.35, { size: 11, color: C.ACCENT, font: MONO })
  }

  function rule(sl, prs, x, y, w) {
    rct(sl, prs, x, y, w, 0.012, { fill: C.DIM })
  }

  // ── Slide renderers ───────────────────────────────────────────────────────────

  function renderCover(prs, sl, s) {
    sl.background = { color: C.BG }
    if (images.image_wide) imgEl(sl, images.image_wide, 0, 0, W, H)
    overlay(sl, prs, 0, 0, W, H, 55)
    brackets(sl, prs)

    eb(sl, s.eyebrow || 'PITCH OVERVIEW', M, 0.18)
    txt(sl, s.title || gameTitle, M, 0.62, W-2*M, 1.55,
        { size: 76, color: C.WHITE, bold: true, font: TITLE })
    if (s.tagline) {
      txt(sl, s.tagline, M, 2.28, W-2*M, 0.88, { size: 20, color: C.LIGHT, font: BODY })
    }
    if (s.tags?.length) {
      txt(sl, s.tags.join('  ◆  '), M, 3.28, W-2*M, 0.35, { size: 10, color: C.ACCENT, font: MONO })
    }
    if (s.footer) {
      txt(sl, s.footer, M, H-0.62, W-2*M, 0.28, { size: 9, color: C.MUTED, font: MONO })
    }
    txt(sl, '01 / 12', 11.5, H-0.38, 1.15, 0.28, { size: 9, color: C.MUTED, font: MONO, align: 'right' })
  }

  function renderOneLiner(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'THE CONCEPT', page)
    eb(sl, s.eyebrow || 'ONE-LINER', M, 0.95)
    txt(sl, `"${s.quote}"`, M, 1.52, W-2*M, 3.45,
        { size: 44, color: C.WHITE, bold: true, font: TITLE })
    if (s.subtitle) {
      txt(sl, s.subtitle, M, 5.15, W-2*M, 0.82, { size: 18, color: C.MUTED, font: BODY })
    }
  }

  function renderFactSheet(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'FACT SHEET', page)
    eb(sl, s.eyebrow || 'FACT SHEET', M, 0.95)
    txt(sl, s.title || 'Fact Sheet.', M, 1.32, W-2*M, 0.6,
        { size: 26, color: C.WHITE, bold: true, font: TITLE })
    rule(sl, prs, M, 2.0, W-2*M)

    const rowH = 0.52
    const lw   = 3.2
    const rw   = W - 2*M - lw - 0.3
    ;(s.rows || []).forEach((row, i) => {
      const y = 2.1 + i * rowH
      rct(sl, prs, M, y, W-2*M, rowH, { fill: i % 2 === 0 ? C.SURFACE : C.BG })
      txt(sl, row.label, M+0.14, y+0.1, lw, 0.3,
          { size: 9, color: C.ACCENT, font: MONO, bold: true })
      txt(sl, row.value, M+lw+0.3, y+0.1, rw, 0.3,
          { size: 13, color: C.LIGHT, font: BODY })
      rct(sl, prs, M, y+rowH, W-2*M, 0.01, { fill: C.DIM })
    })
  }

  function renderSetting(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'SETTING', page)
    eb(sl, s.eyebrow || 'SETTING', M, 0.95)
    txt(sl, s.title || '', M, 1.35, W-2*M, 0.85,
        { size: 32, color: C.WHITE, bold: true, font: TITLE })
    rule(sl, prs, M, 2.28, W-2*M)

    let y = 2.42
    ;(s.paragraphs || []).forEach(para => {
      txt(sl, para, M, y, W-2*M, 1.1, { size: 15, color: C.LIGHT, font: BODY })
      y += 1.05
    })
    if (s.kicker) {
      txt(sl, s.kicker, M, H-0.72, W-2*M, 0.32, { size: 10, color: C.ACCENT, font: MONO, bold: true })
    }
  }

  function renderStatement(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'CORE FANTASY', page)
    eb(sl, s.eyebrow || 'CORE FANTASY', M, 0.95)
    if (s.not_this) {
      txt(sl, s.not_this, M, 1.55, W-2*M, 0.72,
          { size: 24, color: C.MUTED, font: TITLE, bold: true })
    }
    rule(sl, prs, M, 2.45, W-2*M)
    txt(sl, s.claim || '', M, 2.6, W-2*M, 2.0,
        { size: 40, color: C.WHITE, bold: true, font: TITLE })
    if (s.support) {
      txt(sl, s.support, M, 4.75, W-2*M, 0.65, { size: 18, color: C.MUTED, font: BODY })
    }
  }

  function renderLoop(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'CORE LOOP', page)
    eb(sl, s.eyebrow || 'CORE LOOP', M, 0.95)
    txt(sl, s.title || '', M, 1.35, W-2*M, 0.82,
        { size: 28, color: C.WHITE, bold: true, font: TITLE })

    const beats  = s.beats || []
    const n      = beats.length
    const arrW   = 0.18
    const cw     = (W - 2*M - (n-1)*arrW) / n
    const ch     = 3.05, cy = 2.52

    beats.forEach((beat, i) => {
      const x    = M + i*(cw + arrW)
      const bNum = beat.num ?? String(i+1).padStart(2, '0')
      rct(sl, prs, x, cy, cw, ch, { fill: C.CARD, line: C.DIM })
      txt(sl, `${bNum} · ${beat.label}`, x+0.14, cy+0.14, cw-0.28, 0.32,
          { size: 9, color: C.ACCENT, font: MONO, bold: true })
      rule(sl, prs, x+0.14, cy+0.54, cw-0.28)
      txt(sl, beat.title, x+0.14, cy+0.62, cw-0.28, 0.6,
          { size: 13, color: C.WHITE, bold: true, font: BODY })
      txt(sl, beat.body,  x+0.14, cy+1.32, cw-0.28, 1.55,
          { size: 12, color: C.LIGHT, font: BODY })
      if (i < n-1) {
        txt(sl, '→', x+cw+0.02, cy+1.2, arrW, 0.45, { size: 12, color: C.ACCENT, align: 'center' })
      }
    })
    if (s.closing) {
      txt(sl, s.closing, M, H-0.55, W-2*M, 0.28, { size: 8, color: C.MUTED, font: MONO })
    }
  }

  function renderPillars(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'DESIGN PILLARS', page)
    eb(sl, s.eyebrow || 'THREE SIGNATURE MECHANICS', M, 0.95)
    txt(sl, s.title || '', M, 1.35, W-2*M, 0.82,
        { size: 28, color: C.WHITE, bold: true, font: TITLE })

    const pillars = s.pillars || []
    const colW    = (W - 2*M) / 3 - 0.06
    const ch      = 3.65, cy = 2.5
    pillars.forEach((p, i) => {
      const x    = M + i * ((W - 2*M) / 3)
      const pNum = p.num ?? String(i+1).padStart(2, '0')
      rct(sl, prs, x, cy, colW, ch, { fill: C.CARD, line: C.DIM })
      txt(sl, pNum, x+0.22, cy+0.22, 0.45, 0.4,
          { size: 13, color: C.ACCENT, font: MONO, bold: true })
      txt(sl, p.name, x+0.22, cy+0.7,  colW-0.44, 0.95,
          { size: 18, color: C.WHITE, bold: true, font: BODY })
      txt(sl, p.body, x+0.22, cy+1.75, colW-0.44, 1.9,
          { size: 13, color: C.LIGHT, font: BODY })
    })
  }

  function renderCatalog(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'CONTENT CATALOG', page)
    eb(sl, s.eyebrow || 'CONTENT', M, 0.95)
    txt(sl, s.title || '', M, 1.35, W-2*M, 0.90,
        { size: 26, color: C.WHITE, bold: true, font: TITLE })
    if (s.subtitle) {
      txt(sl, s.subtitle, M, 2.38, W-2*M, 0.36, { size: 13, color: C.MUTED, font: BODY })
    }

    const items = s.items || []
    const cols  = 3
    const colW  = (W - 2*M) / cols - 0.06
    const rowH  = items.length > 3 ? 1.82 : 3.2
    const startY = 2.82

    items.forEach((item, i) => {
      const row = Math.floor(i / cols)
      const col = i % cols
      const x   = M + col * ((W - 2*M) / cols)
      const y   = startY + row * (rowH + 0.12)
      rct(sl, prs, x, y, colW, rowH, { fill: C.CARD, line: C.DIM })
      txt(sl, item.tag,  x+0.16, y+0.14, colW-0.32, 0.28,
          { size: 9, color: C.ACCENT, font: MONO, bold: true })
      txt(sl, item.name, x+0.16, y+0.46, colW-0.32, 0.5,
          { size: 15, color: C.WHITE, bold: true, font: BODY })
      txt(sl, item.sub,  x+0.16, y+1.02, colW-0.32, rowH-1.15,
          { size: 12, color: C.LIGHT, font: BODY })
    })
    if (s.footnote) {
      txt(sl, s.footnote, M, H-0.55, W-2*M, 0.28, { size: 8, color: C.MUTED, font: MONO })
    }
  }

  function renderDirection(prs, sl, s, page) {
    sl.background = { color: C.BG }
    if (images.image_interior) {
      imgEl(sl, images.image_interior, 0, 0.52, 6.2, H-0.52)
    } else {
      rct(sl, prs, 0, 0.52, 6.2, H-0.52, { fill: C.SURFACE, line: C.DIM })
    }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'DIRECTION', page)

    const rx = 6.55, rw = W - rx - M
    eb(sl, s.eyebrow || 'ART & AUDIO DIRECTION', rx, 0.95)

    txt(sl, '// VISUAL', rx, 1.55, rw, 0.28, { size: 9, color: C.ACCENT, font: MONO, bold: true })
    txt(sl, s.visual?.headline || '', rx, 1.85, rw, 0.48,
        { size: 16, color: C.WHITE, bold: true, font: BODY })
    txt(sl, s.visual?.body || '', rx, 2.38, rw, 1.08, { size: 13, color: C.LIGHT, font: BODY })
    rule(sl, prs, rx, 3.52, rw)

    txt(sl, '// AUDIO', rx, 3.65, rw, 0.28, { size: 9, color: C.ACCENT, font: MONO, bold: true })
    txt(sl, s.audio?.headline || '', rx, 3.95, rw, 0.48,
        { size: 16, color: C.WHITE, bold: true, font: BODY })
    txt(sl, s.audio?.body || '', rx, 4.48, rw, 1.5, { size: 13, color: C.LIGHT, font: BODY })
  }

  function renderWowMoment(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'NARRATIVE HOOK', page)
    eb(sl, s.eyebrow || 'THE WOW MOMENT', M, 0.95)

    const lineColors   = [C.MUTED, C.LIGHT, C.WHITE]
    const lineSizes    = [24, 30, 38]
    const lineHeights  = [0.82, 1.08, 1.40]
    const lineAdvances = [0.92, 1.20, 1.55]
    let y = 1.72
    ;(s.lines || []).forEach((line, i) => {
      const sz = lineSizes[i] || 24
      txt(sl, line, M, y, W-2*M, lineHeights[i] ?? 0.82,
          { size: sz, color: lineColors[i] || C.WHITE, bold: i === 2, font: TITLE })
      y += lineAdvances[i] ?? 0.92
    })
    if (s.support) {
      txt(sl, s.support, M, y + 0.35, W-2*M, 0.55, { size: 16, color: C.MUTED, font: BODY })
    }
  }

  function renderComparison(prs, sl, s, page) {
    sl.background = { color: C.BG }
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'DIFFERENTIATORS', page)
    eb(sl, s.eyebrow || 'WHY THIS, WHY NOW', M, 0.95)
    txt(sl, s.title || '', M, 1.35, W-2*M, 0.65,
        { size: 26, color: C.WHITE, bold: true, font: TITLE })

    const lw = 5.9, rw = 5.9, rx = 7.1
    txt(sl, 'THE CATEGORY TODAY', M,  3.2, lw, 0.3, { size: 10, color: C.MUTED, font: MONO })
    txt(sl, gameTitle,             rx, 3.2, rw, 0.3, { size: 10, color: C.ACCENT, font: MONO, bold: true })
    rule(sl, prs, M, 3.52, W-2*M)

    const rowH = 0.72
    ;(s.rows || []).forEach((row, i) => {
      const y   = 3.6 + i * rowH
      const bgL = i % 2 === 0 ? C.SURFACE : C.BG
      const bgR = i % 2 === 0 ? C.CARD    : C.SURFACE
      rct(sl, prs, M,  y, lw, rowH-0.02, { fill: bgL, line: C.DIM })
      rct(sl, prs, rx, y, rw, rowH-0.02, { fill: bgR, line: C.DIM })
      txt(sl, row.left,                        M+0.14, y+0.1, lw-0.28, rowH-0.2, { size: 13, color: C.MUTED, font: BODY })
      txt(sl, row.right, rx+0.14, y+0.1, rw-0.28, rowH-0.2, { size: 13, color: C.WHITE, font: BODY })
    })
  }

  function renderClosing(prs, sl, s, page) {
    sl.background = { color: C.BG }
    if (images.image_wide) imgEl(sl, images.image_wide, 0, 0, W, H)
    overlay(sl, prs, 0, 0, W, H, 60)
    brackets(sl, prs)
    chrome(sl, prs, s.section || 'THE OPPORTUNITY', page)
    eb(sl, s.eyebrow || 'THE OPPORTUNITY', M, 0.95)

    txt(sl, s.title || '', M, 1.48, W-2*M, 1.8, { size: 52, color: C.WHITE, bold: true, font: TITLE })
    if (s.thesis) {
      txt(sl, s.thesis, M, 3.42, W-2*M, 0.9, { size: 15, color: C.LIGHT, font: BODY })
    }
    rule(sl, prs, M, 4.42, W-2*M)

    const stats = s.stats || []
    const sw    = (W - 2*M) / (stats.length || 4)
    stats.forEach((stat, i) => {
      const sx = M + i * sw
      txt(sl, stat.value, sx, 4.58, sw, 0.65, { size: 22, color: C.ACCENT, bold: true, font: TITLE, align: 'center' })
      txt(sl, stat.label, sx, 5.28, sw, 0.3,  { size: 9,  color: C.MUTED,  font: MONO,  align: 'center' })
    })
    rule(sl, prs, M, 5.68, W-2*M)

    const bw = 5.6, bh = 0.62, by = 5.82
    rct(sl, prs, M,   by, bw, bh, { line: C.ACCENT, lineW: 1.2 })
    if (s.next_step) {
      txt(sl, `NEXT STEP  —  ${s.next_step.toUpperCase()}`, M+0.22, by+0.14, bw-0.44, 0.38,
          { size: 12, color: C.ACCENT, font: MONO, bold: true })
    }
    rct(sl, prs, 7.4, by, bw, bh, { line: C.MUTED, lineW: 1.2 })
    if (s.contact) {
      txt(sl, `CONTACT  —  ${s.contact}`, 7.62, by+0.14, bw-0.44, 0.38,
          { size: 12, color: C.MUTED, font: MONO })
    }
    txt(sl, 'THANK YOU  ◆  QUESTIONS WELCOME', M, H-0.42, W-2*M, 0.28,
        { size: 9, color: C.MUTED, font: MONO, align: 'center' })
  }

  // ── Dispatch y render ─────────────────────────────────────────────────────────

  const renderers = {
    cover:      (prs, sl, s)     => renderCover(prs, sl, s),
    one_liner:  (prs, sl, s, pg) => renderOneLiner(prs, sl, s, pg),
    fact_sheet: (prs, sl, s, pg) => renderFactSheet(prs, sl, s, pg),
    setting:    (prs, sl, s, pg) => renderSetting(prs, sl, s, pg),
    statement:  (prs, sl, s, pg) => renderStatement(prs, sl, s, pg),
    loop:       (prs, sl, s, pg) => renderLoop(prs, sl, s, pg),
    pillars:    (prs, sl, s, pg) => renderPillars(prs, sl, s, pg),
    catalog:    (prs, sl, s, pg) => renderCatalog(prs, sl, s, pg),
    direction:  (prs, sl, s, pg) => renderDirection(prs, sl, s, pg),
    wow_moment: (prs, sl, s, pg) => renderWowMoment(prs, sl, s, pg),
    comparison: (prs, sl, s, pg) => renderComparison(prs, sl, s, pg),
    closing:    (prs, sl, s, pg) => renderClosing(prs, sl, s, pg),
  }

  const prs = new PptxGenJS()
  prs.layout = 'LAYOUT_WIDE'

  ;(deck.slides || []).forEach((s, i) => {
    const fn = renderers[s.type]
    if (!fn) return
    fn(prs, prs.addSlide(), s, i + 1)
  })

  const buffer      = await prs.write({ outputType: 'nodebuffer' })

  for (const p of Object.values(images)) {
    try { fs.unlinkSync(p) } catch {}
  }
  const slug        = Date.now()
  const storagePath = `projects/${projectId}/tools/deck_${slug}.pptx`
  const url         = await uploadToStorage(
    buffer, storagePath,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  )
  return { success: true, url, filename: `${deck.meta?.game_title || 'deck'}.pptx`, format: 'pptx' }
}

// ─── PPTX generator ──────────────────────────────────────────────────────────

async function docGenPptx(title, content, images, projectId, nodeId) {
  // Detectar JSON cinematic v2 — también maneja el caso en que el auto-trigger
  // pasa replyText completo con <tool_call> adentro (parseToolCalls falló)
  try {
    const { jsonrepair } = require('jsonrepair')
    let src  = typeof content === 'string' ? content : JSON.stringify(content)
    let imgs = images || []

    // Si el contenido es la respuesta cruda del LLM, extraer args del tool_call
    const tcMatch = src.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
    if (tcMatch) {
      try {
        const tc = JSON.parse(jsonrepair(tcMatch[1].trim()))
        if (tc?.args?.content) src = tc.args.content
        if (!imgs.length && Array.isArray(tc?.args?.images)) imgs = tc.args.images
      } catch {}
    }

    const deck = JSON.parse(src)
    if (deck?.slides && Array.isArray(deck.slides) && deck.slides.length > 0) {
      return docGenPptxCinematic(deck, imgs, projectId)
    }
  } catch {}

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

  // Mapa de nombre canónico → base64 (image_wide = [0], image_interior = [1], image_object = [2])
  const IMG_NAMES = ['image_wide', 'image_interior', 'image_object']
  const imgByName = {}
  IMG_NAMES.forEach((name, i) => { if (imgData[i]) imgByName[name] = imgData[i] })

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
  const cover     = pptx.addSlide()
  cover.background = { color: C.BG_DARK }

  // Cover siempre usa image_wide si está disponible
  const coverImg = imgByName['image_wide'] || validImgs[0] || null
  if (coverImg) {
    cover.addImage({ data: coverImg, x: 7.1, y: 0.06, w: 6.23, h: 7.38 })
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

    // Limpiar prefijo "Slide N — " para evitar que aparezca en el título visible
    const cleanTitle = sec.title.replace(/^Slide\s+\d+\s*[—\-–]\s*/i, '').trim()

    const hasComp   = body.compItems.length > 0
    const hasHero   = body.title !== null || body.taglines.length > 0 || body.strikethrough || body.dirItems.length > 0
    const hasFact   = body.factSheet.length >= 2
    const isPureFact = hasFact && body.factSheet.length >= 5 && body.dirItems.length === 0 && !hasComp

    // Imagen: preferir el hint del LLM (image_wide/interior/object) sobre el índice cíclico
    const hintImg  = body.imageHint ? (imgByName[body.imageHint] ?? null) : null
    const slideImg = hintImg || (validImgs.length > 0 ? validImgs[imgCursor % validImgs.length] : null)
    if (!hintImg) imgCursor++

    const slide = pptx.addSlide()
    slide.background = { color: C.BG_SLIDE }

    if (hasComp) {
      renderComparisonSlide(slide, cleanTitle, body, slideImg, C)
    } else if (isPureFact) {
      renderFactSheetSlide(slide, cleanTitle, body, slideImg, C)
    } else if (hasHero) {
      renderHeroSlide(slide, cleanTitle, body, slideImg, C)
    } else if (hasFact) {
      renderFactSheetSlide(slide, cleanTitle, body, slideImg, C)
    } else {
      renderContentSlide(slide, cleanTitle, body, slideImg, C)
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
