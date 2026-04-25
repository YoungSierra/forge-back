const fs = require('fs')
const path = require('path')
const { generatePlaceholderPNG } = require('./storage.service')

const TIMEOUT_MS = 35000
const RETRY_DELAY_MS = 3000

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithRetry(url, attempt = 1) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ForgeStudio/1.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (response.status === 429 && attempt < 3) {
    console.warn(`[IMAGE] Pollinations 429 — retrying in ${RETRY_DELAY_MS * attempt}ms (attempt ${attempt}/3)`)
    await sleep(RETRY_DELAY_MS * attempt)
    return fetchWithRetry(url, attempt + 1)
  }

  return response
}

async function generateImage(prompt, width, height, outputPath) {
  const encoded = encodeURIComponent(prompt)
  const seed = Math.abs(hashStr(prompt)) % 999983
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux-schnell&enhance=false`

  try {
    const response = await fetchWithRetry(url)

    if (!response.ok) {
      throw new Error(`Pollinations returned ${response.status}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1000) {
      throw new Error('Response too small — likely an error page')
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, buffer)

    console.log(`[IMAGE] Generated ${path.basename(outputPath)} (${Math.round(buffer.length / 1024)}kb)`)
    return { path: outputPath, url: null, size_bytes: buffer.length, source: 'pollinations' }
  } catch (err) {
    console.warn(`[IMAGE] Pollinations failed (${err.message}), using placeholder`)
    const result = generatePlaceholderPNG(prompt, null, width, height, outputPath)
    return { ...result, source: 'placeholder' }
  }
}

// Sequential image generation to avoid rate limiting on parallel requests
async function generateImagesSequential(tasks) {
  const results = []
  for (const task of tasks) {
    const result = await generateImage(task.prompt, task.width, task.height, task.outputPath)
    results.push(result)
    // Small delay between requests to respect rate limits
    if (tasks.indexOf(task) < tasks.length - 1) await sleep(800)
  }
  return results
}

function hashStr(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return h
}

module.exports = { generateImage, generateImagesSequential }
