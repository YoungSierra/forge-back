const crypto = require('crypto')

const ALGO      = 'aes-256-gcm'
const KEY_HEX   = process.env.REPO_ENCRYPTION_KEY || ''
const KEY_BUF   = KEY_HEX ? Buffer.from(KEY_HEX, 'hex') : null

// ─── Encriptación ─────────────────────────────────────────────────────────────

function encrypt(text) {
  if (!KEY_BUF) throw new Error('REPO_ENCRYPTION_KEY is not configured')
  const iv         = crypto.randomBytes(12)
  const cipher     = crypto.createCipheriv(ALGO, KEY_BUF, iv)
  const encrypted  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag    = cipher.getAuthTag()
  return [iv, authTag, encrypted].map(b => b.toString('hex')).join(':')
}

function decrypt(stored) {
  if (!KEY_BUF) throw new Error('REPO_ENCRYPTION_KEY is not configured')
  const [ivHex, tagHex, encHex] = stored.split(':')
  const decipher = crypto.createDecipheriv(ALGO, KEY_BUF, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8')
}

// ─── Detección de proveedor ───────────────────────────────────────────────────

function detectProvider(url) {
  if (/gitlab/i.test(url))    return 'gitlab'
  if (/github/i.test(url))    return 'github'
  if (/bitbucket/i.test(url)) return 'bitbucket'
  return 'unknown'
}

// ─── GitLab API ───────────────────────────────────────────────────────────────

async function gitlabRequest(path, token, options = {}) {
  const res = await fetch(`https://gitlab.com/api/v4${path}`, {
    ...options,
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const body = await res.json()
  return { ok: res.ok, status: res.status, body }
}

// Crea el repo en GitLab y devuelve la URL
async function createGitlabRepo(token, repoName) {
  const slug = repoName
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'forge-project'

  const { ok, body } = await gitlabRequest('/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: slug, path: slug, visibility: 'private', initialize_with_readme: true }),
  })

  if (!ok) {
    const msg = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? body.error ?? body)
    throw new Error(msg)
  }
  return body.http_url_to_repo
}

// Valida que el token tenga acceso de escritura al repo
async function validateGitlabAccess(token, repoUrl) {
  // Extrae namespace/project de la URL
  const match = repoUrl.match(/gitlab\.com\/(.+?)(?:\.git)?$/)
  if (!match) throw new Error('Invalid GitLab URL')
  const projectPath = encodeURIComponent(match[1])
  const { ok, body } = await gitlabRequest(`/projects/${projectPath}`, token)
  if (!ok) return { ok: false, message: body.message || 'No access to repository' }
  const canPush = body.permissions?.project_access?.access_level >= 30
    || body.permissions?.group_access?.access_level >= 30
    || body.namespace?.kind === 'user'
  return { ok: canPush, message: canPush ? 'Write access confirmed' : 'Token does not have write permissions' }
}

// Sube un archivo al repo vía GitLab API
async function pushFileToGitlab(token, repoUrl, filePath, content, commitMessage = 'forge: export asset') {
  const match = repoUrl.match(/gitlab\.com\/(.+?)(?:\.git)?$/)
  if (!match) throw new Error('Invalid GitLab URL')
  const projectPath = encodeURIComponent(match[1])
  const encodedFile = encodeURIComponent(filePath)

  // Intentar crear; si existe, actualizar
  const payload = {
    branch: 'main',
    content: Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content).toString('base64'),
    encoding: 'base64',
    commit_message: commitMessage,
  }

  let { ok, body } = await gitlabRequest(`/projects/${projectPath}/repository/files/${encodedFile}`, token, {
    method: 'POST', body: JSON.stringify(payload),
  })

  if (!ok && body.message?.includes('already exists')) {
    ;({ ok, body } = await gitlabRequest(`/projects/${projectPath}/repository/files/${encodedFile}`, token, {
      method: 'PUT', body: JSON.stringify(payload),
    }))
  }

  if (!ok) {
    const msg = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? body.error ?? body)
    throw new Error(msg || 'Failed to push file')
  }
  return true
}

module.exports = { encrypt, decrypt, detectProvider, createGitlabRepo, validateGitlabAccess, pushFileToGitlab }
