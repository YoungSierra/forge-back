const express    = require('express')
const crypto     = require('crypto')
const PDFDocument = require('pdfkit')
const PptxGenJS  = require('pptxgenjs')
const { db }     = require('../services/supabase.service')
const { callLLM }        = require('../services/llm.service')
const { uploadToStorage } = require('../services/storage.service')

// catalogRouter: GET /api/action-nodes
const catalogRouter = express.Router()
// projectRouter: montado en /api/projects — rutas /:id/action-instances
const projectRouter = express.Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSourceOutput(pipeline, sourceStepKey) {
  if (!pipeline || !sourceStepKey) return null
  const node = pipeline[sourceStepKey]
  if (!node) return null
  if (typeof node.output === 'string' && node.output.trim()) return node.output
  const { approved, approved_at, image_url, status, ...rest } = node
  if (Object.keys(rest).length) return JSON.stringify(rest, null, 2)
  return null
}

// Limpia code fences del LLM y extrae el bloque del tipo solicitado
function extractContent(raw, type) {
  if (!raw || typeof raw !== 'string') return ''
  const trimmed = raw.trim()

  if (type === 'html') {
    // Buscar bloque ```html ... ```
    const fenced = trimmed.match(/```html\s*([\s\S]*?)```/i)
    if (fenced) return fenced[1].trim()
    // Si ya empieza con <!DOCTYPE o <html usar directo
    if (/^<!DOCTYPE|^<html/i.test(trimmed)) return trimmed
    // Último recurso: quitar cualquier fence genérico
    const generic = trimmed.match(/```(?:\w+)?\s*([\s\S]*?)```/)
    if (generic) return generic[1].trim()
    return trimmed
  }

  if (type === 'csv') {
    const fenced = trimmed.match(/```(?:csv)?\s*([\s\S]*?)```/i)
    if (fenced) return fenced[1].trim()
    return trimmed
  }

  // Markdown y resto — quitar fences si los hay
  const fenced = trimmed.match(/```(?:\w+)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  return trimmed
}

// ─── PPTX generator ──────────────────────────────────────────────────────────

const FORGE_BG    = '0D0F14'
const FORGE_TEXT  = 'F0F2F5'
const FORGE_DIM   = '8A92A3'
const FORGE_EMBER = 'FF8A3D'
const FORGE_TEAL  = '2DD4BF'

function extractSlidesJson(raw) {
  const trimmed = raw.trim()
  // quitar fences ```json ... ```
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const jsonStr = fenced ? fenced[1].trim() : trimmed
  try {
    const parsed = JSON.parse(jsonStr)
    return Array.isArray(parsed) ? parsed : (parsed.slides ?? [])
  } catch {
    return []
  }
}

async function buildPptx(slides, projectName) {
  const pptx = new PptxGenJS()
  pptx.layout  = 'LAYOUT_WIDE'   // 13.33 x 7.5 pulgadas
  pptx.author  = 'Forge AI'
  pptx.subject = projectName
  pptx.title   = projectName

  // Definir master con fondo oscuro
  pptx.defineSlideMaster({
    title: 'FORGE_MASTER',
    background: { color: FORGE_BG },
    objects: [
      // Franja inferior ember
      { rect: { x: 0, y: 7.1, w: '100%', h: 0.12, fill: { color: FORGE_EMBER } } },
      // Logo text bottom-right
      { text: { text: 'FORGE', options: { x: 11.8, y: 7.2, w: 1.4, h: 0.25, fontSize: 7, color: FORGE_DIM, fontFace: 'Calibri', bold: true } } },
    ],
  })

  slides.forEach((slide, idx) => {
    const s = pptx.addSlide({ masterName: 'FORGE_MASTER' })

    if (slide.type === 'title' || idx === 0) {
      // Slide de portada
      s.addText(slide.title ?? projectName, {
        x: 0.8, y: 2.0, w: 11.7, h: 1.4,
        fontSize: 40, bold: true, color: FORGE_TEXT,
        fontFace: 'Calibri', align: 'left',
      })
      if (slide.subtitle) {
        s.addText(slide.subtitle, {
          x: 0.8, y: 3.55, w: 9, h: 0.7,
          fontSize: 18, color: FORGE_EMBER,
          fontFace: 'Calibri', align: 'left',
        })
      }
      // Número de slide
      s.addText(`${idx + 1} / ${slides.length}`, {
        x: 11.5, y: 0.15, w: 1.6, h: 0.3,
        fontSize: 9, color: FORGE_DIM, fontFace: 'Calibri', align: 'right',
      })
      return
    }

    if (slide.type === 'section') {
      // Separador de sección
      s.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.4, w: 0.06, h: 1.2, fill: { color: FORGE_EMBER } })
      s.addText(slide.heading ?? slide.title ?? '', {
        x: 1.2, y: 3.0, w: 10, h: 1.8,
        fontSize: 32, bold: true, color: FORGE_TEXT,
        fontFace: 'Calibri', align: 'left', valign: 'middle',
      })
      s.addText(`${idx + 1} / ${slides.length}`, {
        x: 11.5, y: 0.15, w: 1.6, h: 0.3,
        fontSize: 9, color: FORGE_DIM, fontFace: 'Calibri', align: 'right',
      })
      return
    }

    // Slide de contenido estándar
    s.addText(slide.title ?? '', {
      x: 0.6, y: 0.35, w: 11.5, h: 0.75,
      fontSize: 22, bold: true, color: FORGE_TEXT,
      fontFace: 'Calibri', align: 'left',
    })
    // Línea bajo el título
    s.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.15, w: 12.1, h: 0.03, fill: { color: FORGE_EMBER } })

    const bullets = (slide.bullets ?? slide.points ?? []).filter(Boolean)
    if (bullets.length) {
      s.addText(bullets.map(b => ({ text: b, options: { bullet: { indent: 15 } } })), {
        x: 0.6, y: 1.35, w: 11.5, h: 5.4,
        fontSize: 15, color: FORGE_TEXT, fontFace: 'Calibri',
        valign: 'top', lineSpacingMultiple: 1.4,
      })
    }

    if (slide.notes) {
      s.addNotes(slide.notes)
    }

    if (slide.highlight) {
      s.addText(slide.highlight, {
        x: 0.6, y: 5.9, w: 11.5, h: 0.6,
        fontSize: 12, italic: true, color: FORGE_TEAL,
        fontFace: 'Calibri', align: 'left',
      })
    }

    s.addText(`${idx + 1} / ${slides.length}`, {
      x: 11.5, y: 0.15, w: 1.6, h: 0.3,
      fontSize: 9, color: FORGE_DIM, fontFace: 'Calibri', align: 'right',
    })
  })

  return pptx.write({ outputType: 'nodebuffer' })
}

// ─── PDF helpers ─────────────────────────────────────────────────────────────

const PDF_BG     = '#0d0f14'
const PDF_EMBER  = '#ff8a3d'
const PDF_TEAL   = '#2dd4bf'
const PDF_TEXT   = '#f0f2f5'
const PDF_DIM    = '#8a92a3'
const PDF_SUBTLE = '#1e2330'

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
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/)
    const h2 = line.match(/^##\s+(.+)/)
    const h3 = line.match(/^###\s+(.+)/)
    if (h1) { current = { level: 1, title: h1[1], lines: [] }; sections.push(current) }
    else if (h2) { current = { level: 2, title: h2[1], lines: [] }; sections.push(current) }
    else if (h3) { current = { level: 3, title: h3[1], lines: [] }; sections.push(current) }
    else if (current) current.lines.push(line)
  }
  return sections
}

// Pinta la cover page del PDF (A4 = 595.28 x 841.89 pts)
function drawCover(doc, title, subtitle, tag) {
  const W = doc.page.width

  // Fondo oscuro
  doc.rect(0, 0, W, doc.page.height).fill(PDF_BG)

  // Franja ember superior
  doc.rect(0, 0, W, 6).fill(PDF_EMBER)

  // Tag (ej. "GAME REPORT" o "ONE-PAGER")
  doc.font('Helvetica-Bold').fontSize(9)
    .fillColor(PDF_EMBER)
    .text(tag, 60, 60, { characterSpacing: 2 })

  // Título
  doc.font('Helvetica-Bold').fontSize(36)
    .fillColor(PDF_TEXT)
    .text(title, 60, 120, { width: W - 120, lineGap: 6 })

  // Separador
  const titleBottom = doc.y + 16
  doc.rect(60, titleBottom, 60, 3).fill(PDF_EMBER)

  // Subtítulo
  if (subtitle) {
    doc.font('Helvetica').fontSize(13)
      .fillColor(PDF_DIM)
      .text(subtitle, 60, titleBottom + 28, { width: W - 120, lineGap: 4 })
  }

  // Forge branding bottom
  doc.font('Helvetica-Bold').fontSize(9)
    .fillColor(PDF_EMBER)
    .text('FORGE AI', 60, doc.page.height - 60)
  doc.font('Helvetica').fontSize(9)
    .fillColor(PDF_DIM)
    .text(`Generated ${new Date().toLocaleDateString()}`, 60, doc.page.height - 45)

  // Franja ember inferior
  doc.rect(0, doc.page.height - 6, W, 6).fill(PDF_EMBER)
}

function drawPageHeader(doc, title) {
  const W = doc.page.width
  doc.rect(0, 0, W, 3).fill(PDF_EMBER)
  doc.font('Helvetica-Bold').fontSize(7)
    .fillColor(PDF_DIM)
    .text(title.toUpperCase(), 60, 14, { characterSpacing: 1 })
  doc.font('Helvetica').fontSize(7)
    .fillColor(PDF_DIM)
    .text(`Page ${doc.bufferedPageRange().start + doc.bufferedPageRange().count}`, W - 100, 14, { align: 'right', width: 40 })
  doc.rect(60, 26, W - 120, 0.5).fill(PDF_SUBTLE)
}

async function buildPdfReport(raw, projectName) {
  const sections = parseMarkdownSections(raw)

  return pdfBuffer(doc => {
    const W = doc.page.width
    const MARGIN = 60
    const CONTENT_W = W - MARGIN * 2

    // Cover
    const title    = sections.find(s => s.level === 1)?.title ?? projectName
    const subtitle = sections.find(s => s.level === 1)?.lines?.find(l => l.trim())?.trim() ?? ''
    drawCover(doc, title, subtitle, 'GAME PROJECT REPORT')

    // Páginas de contenido
    const contentSections = sections.filter(s => s.level >= 2)
    if (contentSections.length) {
      doc.addPage({ margin: 0, size: 'A4' })
      doc.rect(0, 0, W, doc.page.height).fill(PDF_BG)
      drawPageHeader(doc, projectName)
      let y = 46

      for (const section of contentSections) {
        // Salto de página si no hay espacio
        if (y > doc.page.height - 100) {
          doc.addPage({ margin: 0, size: 'A4' })
          doc.rect(0, 0, W, doc.page.height).fill(PDF_BG)
          drawPageHeader(doc, projectName)
          y = 46
        }

        // Título de sección
        const isH2 = section.level === 2
        if (isH2) {
          doc.rect(MARGIN, y + 4, 4, 14).fill(PDF_EMBER)
          doc.font('Helvetica-Bold').fontSize(14)
            .fillColor(PDF_TEXT)
            .text(section.title, MARGIN + 12, y, { width: CONTENT_W - 12 })
          y = doc.y + 10
          doc.rect(MARGIN, y, CONTENT_W, 0.5).fill(PDF_SUBTLE)
          y += 10
        } else {
          doc.font('Helvetica-Bold').fontSize(11)
            .fillColor(PDF_TEAL)
            .text(section.title, MARGIN, y, { width: CONTENT_W })
          y = doc.y + 6
        }

        // Cuerpo
        for (const line of section.lines) {
          if (!line.trim()) { y += 6; continue }
          const bullet = line.match(/^[-*]\s+(.+)/)
          if (bullet) {
            doc.rect(MARGIN + 2, y + 5, 4, 4).fill(PDF_EMBER)
            doc.font('Helvetica').fontSize(10)
              .fillColor(PDF_TEXT)
              .text(bullet[1], MARGIN + 14, y, { width: CONTENT_W - 14, lineGap: 2 })
          } else {
            doc.font('Helvetica').fontSize(10)
              .fillColor(PDF_DIM)
              .text(line, MARGIN, y, { width: CONTENT_W, lineGap: 2 })
          }
          y = doc.y + 4
          if (y > doc.page.height - 80) {
            doc.addPage({ margin: 0, size: 'A4' })
            doc.rect(0, 0, W, doc.page.height).fill(PDF_BG)
            drawPageHeader(doc, projectName)
            y = 46
          }
        }
        y += 14
      }

      // Franja ember al pie de cada página
      const range = doc.bufferedPageRange()
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i)
        doc.rect(0, doc.page.height - 3, W, 3).fill(PDF_EMBER)
        doc.font('Helvetica-Bold').fontSize(7)
          .fillColor(PDF_EMBER)
          .text('FORGE AI', MARGIN, doc.page.height - 18)
      }
    }
  })
}

async function buildOnePager(raw, projectName) {
  const sections = parseMarkdownSections(raw)

  return pdfBuffer(doc => {
    const W = doc.page.width
    const H = doc.page.height
    const MARGIN = 52
    const CONTENT_W = W - MARGIN * 2

    // Fondo
    doc.rect(0, 0, W, H).fill(PDF_BG)

    // Franja ember superior
    doc.rect(0, 0, W, 5).fill(PDF_EMBER)

    // Header — nombre del proyecto
    doc.font('Helvetica-Bold').fontSize(22)
      .fillColor(PDF_TEXT)
      .text(projectName, MARGIN, 28, { width: CONTENT_W - 120 })

    doc.font('Helvetica-Bold').fontSize(8)
      .fillColor(PDF_EMBER)
      .text('ONE-PAGER', W - MARGIN - 70, 34, { characterSpacing: 1.5 })

    doc.rect(MARGIN, 58, CONTENT_W, 0.5).fill(PDF_SUBTLE)

    let y = 68

    for (const section of sections.filter(s => s.level >= 2)) {
      if (y > H - 60) break  // no saltar de página — es un one-pager

      // Título de sección en dos columnas o completo
      doc.font('Helvetica-Bold').fontSize(9)
        .fillColor(PDF_EMBER)
        .text(section.title.toUpperCase(), MARGIN, y, { characterSpacing: 0.8 })
      y = doc.y + 4

      for (const line of section.lines) {
        if (!line.trim() || y > H - 60) continue
        const bullet = line.match(/^[-*]\s+(.+)/)
        if (bullet) {
          doc.rect(MARGIN + 1, y + 4, 3, 3).fill(PDF_EMBER)
          doc.font('Helvetica').fontSize(9)
            .fillColor(PDF_TEXT)
            .text(bullet[1], MARGIN + 10, y, { width: CONTENT_W - 10, lineGap: 1 })
        } else {
          doc.font('Helvetica').fontSize(9)
            .fillColor(PDF_DIM)
            .text(line, MARGIN, y, { width: CONTENT_W, lineGap: 1 })
        }
        y = doc.y + 3
      }
      y += 10
      if (y < H - 60) {
        doc.rect(MARGIN, y - 5, CONTENT_W, 0.5).fill(PDF_SUBTLE)
      }
    }

    // Footer
    doc.rect(0, H - 5, W, 5).fill(PDF_EMBER)
    doc.font('Helvetica-Bold').fontSize(7)
      .fillColor(PDF_EMBER)
      .text('FORGE AI', MARGIN, H - 22)
    doc.font('Helvetica').fontSize(7)
      .fillColor(PDF_DIM)
      .text(new Date().toLocaleDateString(), W - MARGIN - 60, H - 22, { width: 60, align: 'right' })
  })
}

// ─── Prompts por action type ──────────────────────────────────────────────────

// Prompt para cada tipo de action — instrucciones de formato dirigidas al LLM
const ACTION_PROMPTS = {
  'docx': {
    system: 'You are an expert technical writer. Convert the provided content into a well-structured document. Use clear headings, bullet points, and professional language.',
    user:   (src, name) => `Create a complete Word document for the game project "${name}".\n\nSource content:\n${src}\n\nFormat as clean Markdown using # for title, ## for main sections, ### for subsections. Be thorough and professional.`,
  },
  'pptx': {
    system: `You are an expert presentation designer specializing in game industry pitches. You output structured JSON for slide decks.
CRITICAL: Return ONLY valid JSON — no markdown, no code fences, no explanation.`,
    user: (src, name) => `Create a PowerPoint presentation for the game project "${name}".

SOURCE DATA:
${src}

Return a JSON array of slide objects. Each object has these fields:
- "type": "title" | "section" | "content"  (first slide must be type "title")
- "title": string  (all slides)
- "subtitle": string  (only type "title")
- "heading": string  (only type "section")
- "bullets": string[]  (type "content", max 5 bullets, each ≤ 120 chars)
- "highlight": string  (optional — one key takeaway line for content slides)
- "notes": string  (optional speaker notes)

Rules:
- First slide: type "title" with game name + punchy subtitle
- 10-14 slides total
- Use "section" slides to introduce major chapters (Market, Gameplay, Business Model, etc.)
- Keep bullets short and punchy — this is a pitch deck
- Return ONLY the JSON array, starting with [`,
    ext:  'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  'pdf': {
    system: 'You are an expert report writer specializing in the game industry. Create formal, comprehensive reports in structured Markdown.',
    user: (src, name) => `Create a formal report for the game project "${name}".

SOURCE DATA:
${src}

Format as structured Markdown:
# ${name}  ← H1 title with a one-line tagline below it
## Executive Summary  ← 2-3 paragraph overview
## Game Overview  ← genre, platform, mechanics, vision
## Market Analysis  ← target audience, market size, opportunity
## Competitive Landscape  ← 3-5 competitors, our differentiators
## Core Features  ← bullet list of key features with brief descriptions
## Business Model  ← monetization, pricing, distribution
## Development Roadmap  ← milestones as bullet list
## Conclusions  ← key takeaways and recommendation

Use H2 (##) for main sections, H3 (###) for subsections. Use bullet lists (-) for enumerations. Be thorough and professional. No code fences.`,
    ext:  'pdf',
    mime: 'application/pdf',
  },
  'artefact-html': {
    system: `You are an expert front-end developer and game industry analyst. You generate polished, standalone HTML artifacts from game project data.
CRITICAL: Return ONLY raw HTML — no markdown, no code fences, no explanation. Start your response with <!DOCTYPE html>.`,
    user: (src, name) => `Create a stunning, fully self-contained HTML page for the game project "${name}".

SOURCE DATA:
${src}

REQUIREMENTS:
- Start with <!DOCTYPE html> — no preamble, no markdown fences
- Single file: all CSS and JS inline, zero external dependencies
- Dark game-themed design: deep background (#0d0f14), neon accent colors (pick one: cyan #00f5ff, purple #a855f7, or amber #f59e0b based on the game's tone)
- Use CSS custom properties for the color system
- Sections to include (based on available data): Hero header with game name + tagline, Key stats bar (genre, platform, players), Feature highlights grid, Characters or mechanics section if data available, Market position or competitive notes if available, CTA footer
- Typography: system-ui or monospace for code, clean sans-serif for body
- Add subtle CSS animations: fade-in on load, card hover effects
- Responsive: works at 800px+ width
- Make it look like a real game studio artifact — polished, not generic

Return ONLY the complete HTML document starting with <!DOCTYPE html>.`,
    ext:  'html',
    mime: 'text/html',
  },
  'pitch-deck': {
    system: 'You are an expert startup pitch consultant with deep game industry experience.',
    user:   (src, name) => `Create an investor pitch deck for the game "${name}".\n\nSource content:\n${src}\n\nFormat as Markdown, 10-15 slides separated by "---". Cover: hook, problem, solution, market, business model, competitive advantage, team placeholder, financials, ask.`,
  },
  'one-pager': {
    system: 'You are an expert at creating concise, punchy executive summaries for game studios. Everything must fit on a single printed page.',
    user: (src, name) => `Create a one-page executive summary for the game "${name}".

SOURCE DATA:
${src}

Format as structured Markdown — keep each section very short, this must fit on ONE page:
## Concept
2-3 sentences. What is the game, what makes it unique.
## Key Features
5 bullets max. Each ≤ 12 words. The most compelling selling points.
## Target Audience
1-2 sentences. Who plays this and why they'll love it.
## Market Opportunity
1-2 sentences. Market size or comparable hit titles.
## Business Model
1-2 sentences. How it makes money.
## Why Now
1-2 sentences. The timing argument.

Be punchy. No fluff. Every word earns its place.`,
    ext:  'pdf',
    mime: 'application/pdf',
  },
  'social-kit': {
    system: 'You are an expert social media manager specializing in game marketing.',
    user:   (src, name) => `Create a social media content kit for the game "${name}".\n\nSource content:\n${src}\n\nSections: Twitter/X (5 posts ≤280 chars), LinkedIn (2 posts), Instagram (3 captions + hashtags).`,
  },
  'press-release': {
    system: 'You are an expert PR writer for the gaming industry.',
    user:   (src, name) => `Write a press release for the game "${name}".\n\nSource content:\n${src}\n\nInclude: headline, dateline, lead paragraph, 3-4 body paragraphs, quote placeholder, boilerplate, contact placeholder. Wire service tone.`,
  },
  'spreadsheet': {
    system: 'You are an expert data analyst and financial modeler.',
    user:   (src, name) => `Create structured CSV data for the game project "${name}".\n\nSource content:\n${src}\n\nReturn ONLY valid CSV. Create relevant tables (market sizing, competitor comparison, financials). Separate tables with empty line + # comment row.`,
    ext:    'csv',
    mime:   'text/csv',
  },
  'email-draft': {
    system: 'You are an expert at writing compelling outreach emails for game studios.',
    user:   (src, name) => `Write outreach email drafts for the game "${name}".\n\nSource content:\n${src}\n\n3 variants in Markdown: 1) Investor cold outreach, 2) Press/media pitch, 3) Platform holder inquiry. Each: Subject, Body, usage notes.`,
  },
  'wiki-starter': {
    system: 'You are an expert game worldbuilder and technical writer.',
    user:   (src, name) => `Create a game wiki / world bible for "${name}".\n\nSource content:\n${src}\n\nSections: World Overview, Lore & History, Factions & Characters, Locations, Game Systems & Rules, Glossary. Be thorough — this is the team reference document.`,
  },
}

// ─── Catalog routes ───────────────────────────────────────────────────────────

// GET /api/action-nodes
catalogRouter.get('/', async (req, res, next) => {
  try {
    const { data, error } = await db()
      .from('step_configs')
      .select('step_key, label, description, action_type, integration_type, model_name, is_active')
      .eq('step_type', 'action')
      .eq('is_active', true)
      .order('step_key')

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, action_nodes: data })
  } catch (err) { next(err) }
})

// ─── Project-scoped routes (mount at /api/projects) ──────────────────────────

// GET /api/projects/:id/action-instances
projectRouter.get('/:id/action-instances', async (req, res, next) => {
  try {
    const { data: project, error } = await db()
      .from('projects')
      .select('id, action_instances')
      .eq('id', req.params.id)
      .single()

    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })
    res.json({ success: true, action_instances: project.action_instances || [] })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/action-instances — enlaza un action node a un nodo origen
// Body: { action_step_key, source_step_key, container_key }
projectRouter.post('/:id/action-instances', async (req, res, next) => {
  try {
    const { action_step_key, source_step_key, container_key } = req.body
    if (!action_step_key) return res.status(400).json({ success: false, error: 'action_step_key is required' })
    if (!source_step_key) return res.status(400).json({ success: false, error: 'source_step_key is required' })
    if (!container_key)   return res.status(400).json({ success: false, error: 'container_key is required' })

    const { data: config } = await db()
      .from('step_configs')
      .select('step_key, action_type')
      .eq('step_key', action_step_key)
      .eq('step_type', 'action')
      .single()

    if (!config) return res.status(404).json({ success: false, error: `Action node "${action_step_key}" not found` })

    const { data: project, error: pErr } = await db()
      .from('projects')
      .select('id, action_instances')
      .eq('id', req.params.id)
      .single()

    if (pErr || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const newInstance = {
      id:              crypto.randomUUID(),
      action_step_key,
      action_type:     config.action_type,
      source_step_key,
      container_key,
      status:          'pending',
      artifact_url:    null,
      generated_at:    null,
    }

    const instances = [...(project.action_instances || []), newInstance]

    const { error: uErr } = await db()
      .from('projects')
      .update({ action_instances: instances })
      .eq('id', req.params.id)

    if (uErr) return res.status(500).json({ success: false, error: uErr.message })

    res.status(201).json({ success: true, instance: newInstance })
  } catch (err) { next(err) }
})

// DELETE /api/projects/:id/action-instances/:instanceId — desvincula
projectRouter.delete('/:id/action-instances/:instanceId', async (req, res, next) => {
  try {
    const { data: project, error } = await db()
      .from('projects')
      .select('id, action_instances')
      .eq('id', req.params.id)
      .single()

    if (error || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const instances = (project.action_instances || []).filter(i => i.id !== req.params.instanceId)

    const { error: uErr } = await db()
      .from('projects')
      .update({ action_instances: instances })
      .eq('id', req.params.id)

    if (uErr) return res.status(500).json({ success: false, error: uErr.message })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/projects/:id/action-instances/:instanceId/run — ejecuta el action node
projectRouter.post('/:id/action-instances/:instanceId/run', async (req, res, next) => {
  try {
    const { id: projectId, instanceId } = req.params

    const { data: project, error: pErr } = await db()
      .from('projects')
      .select('id, name, concept, action_instances')
      .eq('id', projectId)
      .single()

    if (pErr || !project) return res.status(404).json({ success: false, error: 'Project not found' })

    const instances = project.action_instances || []
    const instance  = instances.find(i => i.id === instanceId)
    if (!instance) return res.status(404).json({ success: false, error: 'Action instance not found' })

    const { data: config } = await db()
      .from('step_configs')
      .select('step_key, action_type, integration_type, model_name')
      .eq('step_key', instance.action_step_key)
      .single()

    if (!config) return res.status(422).json({ success: false, error: `Config for "${instance.action_step_key}" not found` })

    const pipeline    = project.concept?.pipeline || {}
    const sourceOutput = extractSourceOutput(pipeline, instance.source_step_key)
    if (!sourceOutput) {
      return res.status(422).json({
        success: false,
        error:   `Source node "${instance.source_step_key}" has no output yet. Run it first.`,
      })
    }

    const actionDef = ACTION_PROMPTS[instance.action_type]
    if (!actionDef) {
      return res.status(422).json({ success: false, error: `Unknown action_type "${instance.action_type}"` })
    }

    // Marcar como running
    await db().from('projects').update({
      action_instances: instances.map(i => i.id === instanceId ? { ...i, status: 'running' } : i),
    }).eq('id', projectId)

    try {
      const projectName  = project.name || project.concept?.gdd?.project?.name || 'Untitled'
      const systemPrompt = actionDef.system
      const userMessage  = actionDef.user(sourceOutput, projectName)

      const result = await callLLM(systemPrompt, userMessage, {
        step:            instance.action_step_key,  // resuelve modelo desde DB via resolveStepModel
        maxOutputTokens: 8192,
        temperature:     0.7,
        rawText:         true,  // fuerza texto plano — todos los providers usan JSON mode por defecto
      })

      const raw  = typeof result.data === 'string' ? result.data : (result.data?.text ?? '')
      const ext  = actionDef.ext  || 'md'
      const mime = actionDef.mime || 'text/markdown'

      let fileBuffer
      if (instance.action_type === 'pptx') {
        const slides = extractSlidesJson(raw)
        if (!slides.length) throw new Error('LLM returned no valid slides JSON')
        fileBuffer = await buildPptx(slides, projectName)
      } else if (instance.action_type === 'pdf') {
        fileBuffer = await buildPdfReport(raw, projectName)
      } else if (instance.action_type === 'one-pager') {
        fileBuffer = await buildOnePager(raw, projectName)
      } else {
        const content = extractContent(raw, ext)
        if (!content) throw new Error('LLM returned empty content')
        fileBuffer = Buffer.from(content, 'utf-8')
      }

      const storagePath = `projects/${projectId}/actions/${instanceId}.${ext}`
      const artifactUrl = await uploadToStorage(fileBuffer, storagePath, mime)

      await db().from('projects').update({
        action_instances: instances.map(i =>
          i.id === instanceId
            ? { ...i, status: 'done', artifact_url: artifactUrl, generated_at: new Date().toISOString() }
            : i
        ),
      }).eq('id', projectId)

      console.log(`[action-nodes] ${instance.action_type} → ${storagePath}`)
      res.json({ success: true, instance_id: instanceId, artifact_url: artifactUrl, action_type: instance.action_type, ext })
    } catch (runErr) {
      await db().from('projects').update({
        action_instances: instances.map(i => i.id === instanceId ? { ...i, status: 'error' } : i),
      }).eq('id', projectId)
      throw runErr
    }
  } catch (err) { next(err) }
})

module.exports = { catalogRouter, projectRouter }
