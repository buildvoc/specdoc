'use strict'

/*
 * SpecDoc Board: Add Repository UI/API
 *
 * Loaded with NODE_OPTIONS=--require=.../repo-add-hook.js so the existing
 * Board server.js does not need to be rewritten.
 *
 * POST /api/repo-add
 *   {"url":"https://github.com/owner/repo"}
 *
 * Public/private GitHub HTTPS repositories are supported to the extent that
 * the G3 machine's git credentials allow cloning them.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const PROJECTS_ROOT = process.env.SPECDOC_REPO_ROOT || '/data/projects'
const BOARD_DIR = process.env.SPECDOC_BOARD_DIR || '/data/projects/specdoc/hd2-board'
const REGISTRY_PATH = process.env.SPECDOC_REPO_REGISTRY || path.join(BOARD_DIR, 'data', 'repositories.json')
const API_PATH = '/api/repo-add'
const REGISTRY_API_PATH = '/api/repositories'
const UI_MARKER = 'SPECDOC_ADD_REPOSITORY_UI'
const MAX_BODY = 16 * 1024
const CLONE_TIMEOUT_MS = Number(process.env.SPECDOC_REPO_CLONE_TIMEOUT_MS || 180000)

function writeJson (res, status, data) {
  const body = Buffer.from(JSON.stringify(data))
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

function isPrivateAddress (value) {
  let a = String(value || '').trim()
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (a === '::1' || a === '127.0.0.1') return true
  if (/^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a)) return true
  const m = /^172\.(\d+)\./.exec(a)
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31)
}

function parseGithubUrl (value) {
  let u
  try {
    u = new URL(String(value || '').trim())
  } catch {
    throw new Error('Enter a valid GitHub repository URL')
  }

  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only https://github.com/owner/repository URLs are allowed')
  }

  const bits = u.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (bits.length !== 2 || !bits[0] || !bits[1]) {
    throw new Error('Expected https://github.com/owner/repository')
  }

  const owner = bits[0]
  const repo = bits[1].replace(/\.git$/i, '')
  const safe = /^[A-Za-z0-9._-]+$/

  if (!safe.test(owner) || !safe.test(repo) || repo === '.' || repo === '..') {
    throw new Error('Repository owner/name contains unsupported characters')
  }

  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`
  }
}


function normalizeRemote (value) {
  let s = String(value || '').trim().replace(/\.git$/i, '').replace(/\/+$/g, '')
  s = s.replace(/^git@github\.com:/i, 'https://github.com/')
  s = s.replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
  return s.toLowerCase()
}

function existingRepoFor (owner, repo, cloneUrl) {
  let entries = []
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
  } catch {
    return null
  }

  const wantedName = repo.toLowerCase()
  const wantedRemote = normalizeRemote(cloneUrl)
  let sameNameConflict = null

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const candidate = path.join(PROJECTS_ROOT, entry.name)
    if (!fs.existsSync(path.join(candidate, '.git'))) {
      if (entry.name.toLowerCase() === wantedName) {
        sameNameConflict = {
          path: candidate,
          match: false,
          error: `Existing path differs only by case and is not a Git repository: ${candidate}`
        }
      }
      continue
    }

    const probe = spawnSync('git', ['-C', candidate, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 10000
    })

    const remote = String(probe.stdout || '').trim()
    if (probe.status === 0 && normalizeRemote(remote) === wantedRemote) {
      return { path: candidate, match: true, remote }
    }

    if (entry.name.toLowerCase() === wantedName) {
      sameNameConflict = {
        path: candidate,
        match: false,
        remote,
        error: `Existing repository ${candidate} uses a different origin`
      }
    }
  }

  return sameNameConflict
}

function verifyRemoteExists (cloneUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['ls-remote', '--exit-code', '--', cloneUrl, 'HEAD'],
      {
        cwd: PROJECTS_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    let output = ''
    const append = (chunk) => {
      output += chunk.toString()
      if (output.length > 8000) output = output.slice(-8000)
    }

    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('GitHub repository validation timed out'))
    }, 30000)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(true)
      reject(new Error(
        output.trim() ||
        'GitHub repository was not found, or G3 does not have permission to access it'
      ))
    })
  })
}

function chooseDestination (owner, repo) {
  const primary = path.join(PROJECTS_ROOT, repo)
  if (!fs.existsSync(primary)) return primary

  const fallback = path.join(PROJECTS_ROOT, `${owner}-${repo}`)
  if (!fs.existsSync(fallback)) return fallback

  throw new Error(
    `Both ${primary} and ${fallback} already exist; remove/rename one or use an existing matching checkout`
  )
}

function readRegistry () {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.repositories)) {
      return { version: 1, repositories: [] }
    }
    return {
      version: 1,
      repositories: parsed.repositories.filter(Boolean)
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('SpecDoc repository registry read failed:', err.message)
    }
    return { version: 1, repositories: [] }
  }
}

function writeRegistry (registry) {
  const dir = path.dirname(REGISTRY_PATH)
  fs.mkdirSync(dir, { recursive: true })

  const tmp = `${REGISTRY_PATH}.tmp-${process.pid}`
  const data = JSON.stringify({
    version: 1,
    repositories: registry.repositories
  }, null, 2) + '\n'

  fs.writeFileSync(tmp, data, { mode: 0o644 })
  fs.renameSync(tmp, REGISTRY_PATH)
}

function registerRepository (parsed, repoPath) {
  const registry = readRegistry()
  const now = new Date().toISOString()
  const id = `${parsed.owner}/${parsed.repo}`
  const key = id.toLowerCase()
  const canonicalUrl = `https://github.com/${parsed.owner}/${parsed.repo}`

  let record = registry.repositories.find(
    (item) => String(item.id || '').toLowerCase() === key
  )

  if (!record) {
    record = {
      id,
      owner: parsed.owner,
      repo: parsed.repo,
      url: canonicalUrl,
      cloneUrl: parsed.cloneUrl,
      path: repoPath,
      registeredAt: now,
      updatedAt: now
    }
    registry.repositories.push(record)
  } else {
    record.id = id
    record.owner = parsed.owner
    record.repo = parsed.repo
    record.url = canonicalUrl
    record.cloneUrl = parsed.cloneUrl
    record.path = repoPath
    record.updatedAt = now
    if (!record.registeredAt) record.registeredAt = now
  }

  registry.repositories.sort((a, b) =>
    String(a.id || '').localeCompare(String(b.id || ''), undefined, { sensitivity: 'base' })
  )
  writeRegistry(registry)
  return record
}


function discoverRepositories () {
  const found = []
  let entries = []

  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
  } catch (err) {
    console.error('SpecDoc repository discovery failed:', err.message)
    return found
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const repoPath = path.join(PROJECTS_ROOT, entry.name)
    if (!fs.existsSync(path.join(repoPath, '.git'))) continue

    const originProbe = spawnSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 10000
    })
    const branchProbe = spawnSync('git', ['-C', repoPath, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: 10000
    })

    const origin = originProbe.status === 0 ? String(originProbe.stdout || '').trim() : ''
    const branch = branchProbe.status === 0 ? String(branchProbe.stdout || '').trim() : ''

    let owner = ''
    let repo = entry.name
    let id = entry.name
    let url = origin

    const normalized = normalizeRemote(origin)
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(normalized)
    if (match) {
      owner = match[1]
      repo = match[2]
      id = `${owner}/${repo}`
      url = `https://github.com/${owner}/${repo}`
    }

    found.push({
      id,
      owner,
      repo,
      url,
      cloneUrl: origin,
      path: repoPath,
      branch,
      discovered: true
    })
  }

  found.sort((a, b) =>
    String(a.id || '').localeCompare(String(b.id || ''), undefined, { sensitivity: 'base' })
  )
  return found
}

function syncRegistryWithDiscovered () {
  const registry = readRegistry()
  const discovered = discoverRepositories()
  const byPath = new Map(
    registry.repositories.map((item) => [String(item.path || ''), item])
  )
  const now = new Date().toISOString()

  for (const item of discovered) {
    const existing = byPath.get(item.path)
    if (existing) {
      Object.assign(existing, item, { updatedAt: now })
      if (!existing.registeredAt) existing.registeredAt = now
    } else {
      registry.repositories.push({
        ...item,
        registeredAt: now,
        updatedAt: now
      })
    }
  }

  // Keep only repositories that still exist as Git repositories.
  registry.repositories = registry.repositories.filter((item) =>
    item.path &&
    fs.existsSync(item.path) &&
    fs.existsSync(path.join(item.path, '.git'))
  )

  registry.repositories.sort((a, b) =>
    String(a.id || '').localeCompare(String(b.id || ''), undefined, { sensitivity: 'base' })
  )

  writeRegistry(registry)
  return registry
}

function handleRegistryList (req, res) {
  if (req.method !== 'GET') {
    return writeJson(res, 405, { ok: false, error: 'GET required' })
  }
  const registry = syncRegistryWithDiscovered()
  return writeJson(res, 200, {
    ok: true,
    registry: REGISTRY_PATH,
    projectRoot: PROJECTS_ROOT,
    count: registry.repositories.length,
    repositories: registry.repositories
  })
}

function runGitClone (cloneUrl, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['clone', '--depth', '1', '--', cloneUrl, destination],
      {
        cwd: PROJECTS_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    let output = ''
    const append = (chunk) => {
      output += chunk.toString()
      if (output.length > 12000) output = output.slice(-12000)
    }

    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`git clone timed out after ${CLONE_TIMEOUT_MS}ms`))
    }, CLONE_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(output.trim())
      reject(new Error(output.trim() || `git clone exited with status ${code}`))
    })
  })
}

async function readJsonBody (req) {
  const chunks = []
  let total = 0

  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY) throw new Error('Request body too large')
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function handleRepoAdd (req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  if (req.method !== 'POST') {
    return writeJson(res, 405, { ok: false, error: 'POST required' })
  }

  if (process.env.SPECDOC_REPO_ADD_ALLOW_ANY !== '1' &&
      !isPrivateAddress(req.socket && req.socket.remoteAddress)) {
    return writeJson(res, 403, { ok: false, error: 'Repository administration is limited to the private LAN' })
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch (err) {
    return writeJson(res, 400, { ok: false, error: err.message })
  }

  let parsed
  try {
    parsed = parseGithubUrl(body.url)
  } catch (err) {
    return writeJson(res, 400, { ok: false, error: err.message })
  }

  fs.mkdirSync(PROJECTS_ROOT, { recursive: true })

  const existing = existingRepoFor(parsed.owner, parsed.repo, parsed.cloneUrl)
  if (existing && existing.match) {
    const registration = registerRepository(parsed, existing.path)
    return writeJson(res, 200, {
      ok: true,
      existing: true,
      registered: true,
      repository: `${parsed.owner}/${parsed.repo}`,
      path: existing.path,
      registration,
      message: `Using and registering existing repository at ${existing.path}`
    })
  }

  let destination
  try {
    await verifyRemoteExists(parsed.cloneUrl)
    destination = chooseDestination(parsed.owner, parsed.repo)
  } catch (err) {
    return writeJson(res, 400, {
      ok: false,
      error: err.message,
      requested: `https://github.com/${parsed.owner}/${parsed.repo}`
    })
  }

  if (path.dirname(destination) !== path.resolve(PROJECTS_ROOT)) {
    return writeJson(res, 400, { ok: false, error: 'Invalid destination path' })
  }

  try {
    await runGitClone(parsed.cloneUrl, destination)
    const registration = registerRepository(parsed, destination)
    return writeJson(res, 201, {
      ok: true,
      existing: false,
      registered: true,
      repository: `${parsed.owner}/${parsed.repo}`,
      path: destination,
      registration,
      message: `Added and registered ${parsed.owner}/${parsed.repo}`
    })
  } catch (err) {
    try {
      if (fs.existsSync(destination) && !fs.existsSync(path.join(destination, '.git'))) {
        fs.rmSync(destination, { recursive: true, force: true })
      }
    } catch {}

    return writeJson(res, 502, { ok: false, error: err.message })
  }
}

const injectedUi = String.raw`
<!-- SPECDOC_ADD_REPOSITORY_UI -->
<style>
.header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
#specdoc-add-repository-button {
  position: static;
  border: 1px solid rgba(127,127,127,.45);
  border-radius: 7px;
  padding: 7px 11px;
  background: Canvas;
  color: CanvasText;
  font: 600 13px/1.2 system-ui, sans-serif;
  cursor: pointer;
}
#specdoc-add-repository-button[disabled] {
  opacity: .65;
  cursor: wait;
}
#specdoc-repositories-button {
  position: static;
  border: 1px solid rgba(127,127,127,.45);
  border-radius: 7px;
  padding: 7px 11px;
  background: Canvas;
  color: CanvasText;
  font: 600 13px/1.2 system-ui, sans-serif;
  cursor: pointer;
}
</style>
<button id="specdoc-add-repository-button" type="button" title="Clone/reuse and register a GitHub repository">+ Repository</button>
<button id="specdoc-repositories-button" type="button" title="Show all Git repositories discovered under /data/projects">Repositories</button>
<script>
(() => {
  const button = document.getElementById('specdoc-add-repository-button')
  const listButton = document.getElementById('specdoc-repositories-button')
  if (!button) return

  function placeHeaderButtons () {
    const host = document.querySelector('.header-actions')
    if (!host) return

    const mergeButtons = [...document.querySelectorAll('button')].filter((candidate) => {
      return candidate.textContent.trim() === 'Merge' && !candidate.closest('dialog')
    })
    let mergeButton = document.getElementById('merge-open')
    if (!mergeButton || mergeButton.closest('dialog')) mergeButton = mergeButtons[0] || null

    for (const candidate of mergeButtons) {
      if (candidate !== mergeButton) candidate.remove()
    }
    if (mergeButton) {
      mergeButton.id = 'merge-open'
      host.appendChild(mergeButton)
    }

    host.appendChild(button)
    if (listButton) host.appendChild(listButton)
  }

  placeHeaderButtons()
  setTimeout(placeHeaderButtons, 0)
  setTimeout(placeHeaderButtons, 250)
  setTimeout(placeHeaderButtons, 1000)

  button.addEventListener('click', async () => {
    const url = window.prompt(
      'GitHub repository URL (https://github.com/owner/repo)',
      'https://github.com/buildvoc/'
    )
    if (!url) return

    const oldText = button.textContent
    button.disabled = true
    button.textContent = 'Adding…'

    try {
      const response = await fetch('/api/repo-add', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({url})
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) {
        throw new Error(data.error || ('HTTP ' + response.status))
      }

      window.alert((data.existing ? 'Existing repository registered: ' : 'Repository added and registered: ') + data.path)
      window.location.reload()
    } catch (err) {
      window.alert('Add Repository failed:\n' + err.message)
    } finally {
      button.disabled = false
      button.textContent = oldText
    }
  })

  if (listButton) {
    listButton.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/repositories')
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(data.error || ('HTTP ' + response.status))
        const rows = (data.repositories || []).map((r) => String(r.id) + '  →  ' + String(r.path))
        window.alert(rows.length ? rows.join('\n') : 'No repositories registered yet.')
      } catch (err) {
        window.alert('Repository list failed: ' + err.message)
      }
    })
  }
})()
</script>
`

function wrapHtmlResponse (req, res) {
  if (req.method !== 'GET') return
  const accept = String(req.headers.accept || '')
  if (!accept.includes('text/html') && req.url !== '/') return

  const originalWriteHead = res.writeHead.bind(res)
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  const chunks = []
  let buffering = true

  // The Board emits Content-Length explicitly. Because this hook may inject UI
  // after writeHead(), strip that header before it is sent so the appended
  // button is not truncated by the client.
  res.writeHead = function (...args) {
    try {
      if (!res.headersSent && res.hasHeader('content-length')) {
        res.removeHeader('content-length')
      }

      const headerArg = args.find(
        (arg) => arg && typeof arg === 'object' && !Array.isArray(arg)
      )
      if (headerArg) {
        for (const key of Object.keys(headerArg)) {
          if (key.toLowerCase() === 'content-length') delete headerArg[key]
        }
      }
    } catch {}
    return originalWriteHead(...args)
  }

  res.write = function (chunk, encoding, callback) {
    if (!buffering) return originalWrite(chunk, encoding, callback)
    if (chunk != null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
    }
    if (typeof callback === 'function') process.nextTick(callback)
    return true
  }

  res.end = function (chunk, encoding, callback) {
    if (!buffering) return originalEnd(chunk, encoding, callback)
    if (chunk != null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
    }

    buffering = false
    let body = Buffer.concat(chunks)
    const contentEncoding = String(res.getHeader('content-encoding') || '').toLowerCase()
    const contentType = String(res.getHeader('content-type') || '').toLowerCase()

    if (!contentEncoding &&
        (contentType.includes('text/html') || body.toString('utf8', 0, Math.min(body.length, 4096)).includes('<html'))) {
      let text = body.toString('utf8')
      if (!text.includes(UI_MARKER)) {
        if (text.includes('</body>')) {
          text = text.replace('</body>', injectedUi + '\n</body>')
        } else if (text.includes('</html>')) {
          text = text.replace('</html>', injectedUi + '\n</html>')
        } else {
          text += '\n' + injectedUi
        }

        body = Buffer.from(text)
        if (!res.headersSent) {
          // Let Node choose chunked transfer after UI injection.
          res.removeHeader('content-length')
        }
      }
    }

    return originalEnd(body, undefined, callback)
  }
}

const originalEmit = http.Server.prototype.emit

http.Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && args.length >= 2) {
    const req = args[0]
    const res = args[1]
    let pathname = ''

    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname
    } catch {}

    if (pathname === API_PATH) {
      handleRepoAdd(req, res).catch((err) => {
        if (!res.headersSent) {
          writeJson(res, 500, { ok: false, error: err.message })
        } else {
          res.destroy(err)
        }
      })
      return true
    }

    if (pathname === REGISTRY_API_PATH) {
      handleRegistryList(req, res)
      return true
    }

    wrapHtmlResponse(req, res)
  }

  return originalEmit.call(this, event, ...args)
}

/* specdoc-merge-specifications:v3 */
try {
  require('./merge-specs-hook.js')
} catch (error) {
  console.error('[repo-add-hook] merge-specifications preload failed:', error)
}

/* specdoc-merge-code-paths:v2 */
try {
  require('./merge-code-paths-hook.js')
} catch (error) {
  console.error('[repo-add-hook] merge-code-paths preload failed:', error)
}
