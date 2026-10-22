'use strict'

/*
 * SpecDoc Board — GitHub Wiki specification sync.
 *
 * Source and target are deliberately independent:
 *   - source: any registered SpecDoc project with an outputDir, including
 *     combined-codebase projects that have no GitHub repository of their own;
 *   - target: an explicit GitHub owner/repository whose Wiki receives the pages.
 *
 * All Markdown below the source project's outputDir is synced, except CHANGELOG
 * files. Existing unrelated Wiki pages are never deleted.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')

const ROOT = process.env.SPECDOC_ROOT || '/data/projects/specdoc'
const BOARD = process.env.SPECDOC_BOARD_DIR || path.join(ROOT, 'hd2-board')
const REGISTRY_FILE = process.env.SPECDOC_PROJECT_REGISTRY || path.join(ROOT, 'projects', 'registry.json')
const SPECS_ROOT = path.resolve(process.env.SPECDOC_SPECIFICATIONS_ROOT || path.join(ROOT, 'specifications'))
const GH = process.env.SPECDOC_GH_BIN || '/data/projects/github-cli/bin/gh'
const GIT = process.env.SPECDOC_GIT_BIN || '/usr/bin/git'
const GH_ENV = {
  ...process.env,
  HOME: process.env.HOME || '/home/hp',
  GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || '/home/hp/.config/gh'
}
const UI_MARKER = 'SPECDOC_GITHUB_WIKI_SYNC_V14'
const MAX_BODY = 32 * 1024
let syncRunning = false

function writeJson (res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2))
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readJsonBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('Invalid JSON request body'), { statusCode: 400 })
  }
}

function readRegistry () {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
    return parsed.projects || {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

function inside (parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function sourceProject (namespace) {
  const ns = String(namespace || '').trim()
  if (!ns) throw Object.assign(new Error('Source project is required'), { statusCode: 400 })

  const project = readRegistry()[ns]
  if (!project) throw Object.assign(new Error(`Unknown SpecDoc project: ${ns}`), { statusCode: 404 })

  const raw = String(project.outputDir || '').trim()
  if (!raw) throw Object.assign(new Error(`Project ${ns} has no outputDir`), { statusCode: 400 })

  const outputDir = path.resolve(raw)
  if (!inside(SPECS_ROOT, outputDir)) {
    throw Object.assign(new Error(`Unsafe outputDir for ${ns}: ${outputDir}`), { statusCode: 400 })
  }
  if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
    throw Object.assign(new Error(`Specification output directory does not exist: ${outputDir}`), { statusCode: 404 })
  }

  return {
    namespace: ns,
    displayName: String(project.displayName || project.projectName || ns),
    githubRepo: String(project.githubRepo || '').trim(),
    outputDir
  }
}

function isChangelog (name) {
  return /^changelog(?:[._ -].*)?\.md$/i.test(String(name || ''))
}

function markdownFiles (dir) {
  const all = []
  const excluded = []

  function walk (current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const rel = path.relative(dir, full).split(path.sep).join('/')
        if (isChangelog(entry.name)) excluded.push(rel)
        else all.push({ rel, full, bytes: fs.statSync(full).size })
      }
    }
  }

  walk(dir)
  all.sort((a, b) => a.rel.localeCompare(b.rel))
  excluded.sort()
  return { files: all, excluded }
}

function parseRepo (value) {
  const raw = String(value || '').trim()
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(raw)
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw Object.assign(new Error('Target repository must be owner/repository'), { statusCode: 400 })
  }
  return `${match[1]}/${match[2]}`
}

function ghJson (args) {
  const out = execFileSync(GH, args, {
    encoding: 'utf8',
    env: GH_ENV,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return JSON.parse(out || '{}')
}

function ghExec (args, opts = {}) {
  return execFileSync(GH, args, {
    encoding: 'utf8',
    env: GH_ENV,
    timeout: opts.timeout || 60000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function wikiInitSessionCandidates () {
  const home = GH_ENV.HOME || os.homedir()
  const state = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state')
  return [
    path.join(state, 'gh-wiki-init', 'auth', 'github.json'),
    path.join(state, 'gh-social-upload', 'auth', 'github.json')
  ]
}

function wikiBootstrapCapability () {
  let extension = false
  try {
    const list = ghExec(['extension', 'list'], { timeout: 15000 })
    extension = /(^|\s)(gh-wiki-init|ibrews\/gh-wiki-init)(\s|$)/m.test(list)
  } catch {}

  const session = wikiInitSessionCandidates().find(file => {
    try { return fs.statSync(file).isFile() } catch { return false }
  }) || ''

  return {
    extension,
    session: Boolean(session),
    ready: extension && Boolean(session),
    sessionPath: session
  }
}

function tryAutomaticWikiBootstrap (repo) {
  const capability = wikiBootstrapCapability()
  if (!capability.extension) {
    return {
      initialized: false,
      automatic: false,
      reason: 'Automatic first-page bootstrap is not installed on G3.'
    }
  }
  if (!capability.session) {
    return {
      initialized: false,
      automatic: false,
      reason: 'Automatic first-page bootstrap needs a saved GitHub web session (gh wiki-init init-auth).'
    }
  }

  try {
    ghExec(['wiki-init', repo], { timeout: 180000 })
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    return {
      initialized: false,
      automatic: true,
      reason: `Automatic Wiki bootstrap failed: ${detail.slice(0, 600)}`
    }
  }

  const check = validateWikiGit(repo)
  if (!check.initialized) {
    return {
      initialized: false,
      automatic: true,
      reason: check.error || 'Automatic Wiki bootstrap completed but Wiki git is still unavailable.'
    }
  }

  return {
    initialized: true,
    automatic: true,
    createdFirstPage: true,
    cloneUrl: check.cloneUrl
  }
}

function removeAutomaticBootstrapHome (wikiDir) {
  const file = path.join(wikiDir, 'Home.md')
  if (!fs.existsSync(file)) return false
  let text = ''
  try { text = fs.readFileSync(file, 'utf8').trim() } catch { return false }
  if (text !== 'Initializing — full pages pushed next.') return false
  fs.unlinkSync(file)
  return true
}

function runGit (args, opts = {}) {
  return execFileSync(GIT, args, {
    encoding: 'utf8',
    env: opts.env || process.env,
    cwd: opts.cwd,
    timeout: opts.timeout || 120000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function createAskPass (dir) {
  const file = path.join(dir, 'git-askpass.sh')
  const script = `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *Password*) exec ${JSON.stringify(GH)} auth token ;;\n  *) printf '%s\\n' '' ;;\nesac\n`
  fs.writeFileSync(file, script, { mode: 0o700 })
  return file
}

function gitAuthEnv (askPass) {
  return {
    ...GH_ENV,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: askPass
  }
}

function wikiFileName (rel) {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const stem = normalized.replace(/\.md$/i, '')
  const flat = stem.split('/').map(part => part.trim()).filter(Boolean).join('--')
  const safe = flat
    .replace(/[\x00-\x1f<>:"\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!safe) throw new Error(`Cannot derive Wiki page filename from ${rel}`)
  return `${safe}.md`
}

function generatedWikiIndex (project, docs) {
  const pages = []
  let hasSourceIndex = false
  for (const doc of docs.files) {
    const name = wikiFileName(doc.rel)
    if (name.toLowerCase() === 'index.md') {
      hasSourceIndex = true
      continue
    }
    pages.push(name.replace(/\.md$/i, ''))
  }

  if (hasSourceIndex) return { generated: false, body: null }

  const lines = [
    '# Specifications',
    '',
    `Synced from \`${project.namespace}\` by SpecDoc Board.`,
    '',
    ...pages.map(page => `- [[${page}]]`),
    ''
  ]
  return { generated: true, body: Buffer.from(lines.join('\n'), 'utf8') }
}

function targetRepoInfo (repo, options = {}) {
  let metadata = ghJson(['api', `repos/${repo}`])
  if (metadata.has_wiki === false && options.enableIfDisabled) {
    ghExec(['api', '-X', 'PATCH', `repos/${repo}`, '-F', 'has_wiki=true'])
    metadata = ghJson(['api', `repos/${repo}`])
  }
  if (metadata.has_wiki === false) {
    throw Object.assign(new Error(`GitHub Wiki is disabled for ${repo}`), { statusCode: 409, code: 'WIKI_DISABLED' })
  }
  return {
    fullName: String(metadata.full_name || repo),
    htmlUrl: String(metadata.html_url || `https://github.com/${repo}`),
    hasWiki: metadata.has_wiki !== false,
    canPush: Boolean(metadata.permissions && (metadata.permissions.push || metadata.permissions.maintain || metadata.permissions.admin))
  }
}

function validateWikiGit (repo) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-wiki-validate-'))
  try {
    const askPass = createAskPass(tmp)
    const env = gitAuthEnv(askPass)
    const url = `https://github.com/${repo}.wiki.git`
    try {
      runGit(['ls-remote', url, 'HEAD'], { env, timeout: 45000 })
      return { initialized: true, cloneUrl: url }
    } catch (error) {
      const stderr = String(error.stderr || error.message || '').trim()
      return { initialized: false, cloneUrl: url, error: stderr.slice(0, 500) }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function catalog () {
  const projects = []
  for (const [namespace, project] of Object.entries(readRegistry())) {
    const raw = String(project.outputDir || '').trim()
    if (!raw) continue
    const outputDir = path.resolve(raw)
    if (!inside(SPECS_ROOT, outputDir) || !fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) continue
    const docs = markdownFiles(outputDir)
    projects.push({
      namespace,
      displayName: String(project.displayName || project.projectName || namespace),
      githubRepo: String(project.githubRepo || '').trim(),
      outputDir,
      documentCount: docs.files.length,
      excludedChangelogCount: docs.excluded.length
    })
  }
  projects.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return { projects, syncRunning }
}

function validate (namespace, repoValue) {
  const project = sourceProject(namespace)
  const repo = parseRepo(repoValue)
  const docs = markdownFiles(project.outputDir)
  const target = targetRepoInfo(repo)
  const wikiGit = validateWikiGit(repo)
  const bootstrap = wikiBootstrapCapability()

  return {
    ok: true,
    source: {
      namespace: project.namespace,
      displayName: project.displayName,
      outputDir: project.outputDir,
      documents: docs.files.length,
      excludedChangelog: docs.excluded.length
    },
    target: {
      repo: target.fullName,
      wikiUrl: `${target.htmlUrl}/wiki`,
      hasWiki: target.hasWiki,
      canPush: target.canPush,
      initialized: wikiGit.initialized,
      cloneUrl: wikiGit.cloneUrl,
      initializationError: wikiGit.error || '',
      initializeUrl: `${target.htmlUrl}/wiki/_new`,
      automaticBootstrapReady: bootstrap.ready,
      automaticBootstrapInstalled: bootstrap.extension
    }
  }
}

function syncWiki (namespace, repoValue) {
  if (syncRunning) throw Object.assign(new Error('A GitHub Wiki sync is already running'), { statusCode: 409 })
  syncRunning = true

  const project = sourceProject(namespace)
  const repo = parseRepo(repoValue)
  const docs = markdownFiles(project.outputDir)
  if (!docs.files.length) {
    syncRunning = false
    throw Object.assign(new Error(`No specification Markdown found for ${project.namespace}`), { statusCode: 409 })
  }

  const target = targetRepoInfo(repo, { enableIfDisabled: true })
  if (!target.canPush) {
    syncRunning = false
    throw Object.assign(new Error(`GitHub authentication does not report push access to ${repo}`), { statusCode: 403 })
  }

  let wikiGit = validateWikiGit(repo)
  let bootstrap = { initialized: wikiGit.initialized, automatic: false, createdFirstPage: false }
  if (!wikiGit.initialized) {
    bootstrap = tryAutomaticWikiBootstrap(repo)
    if (!bootstrap.initialized) {
      syncRunning = false
      const error = Object.assign(new Error(
        `GitHub Wiki is enabled but its .wiki.git repository has not been initialized. ${bootstrap.reason || ''}`.trim()
      ), {
        statusCode: 409,
        code: 'WIKI_NOT_INITIALIZED',
        initializeUrl: `${target.htmlUrl}/wiki/_new`,
        bootstrapReason: bootstrap.reason || '',
        automaticBootstrap: Boolean(bootstrap.automatic)
      })
      throw error
    }
    wikiGit = validateWikiGit(repo)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-wiki-sync-'))
  try {
    const askPass = createAskPass(tmp)
    const env = gitAuthEnv(askPass)
    const wikiDir = path.join(tmp, 'wiki')
    const cloneUrl = `https://github.com/${repo}.wiki.git`

    try {
      runGit(['clone', '--depth', '1', cloneUrl, wikiDir], { env, timeout: 120000 })
    } catch (error) {
      const detail = String(error.stderr || error.message || '').trim()
      throw Object.assign(new Error(`Unable to clone ${repo} Wiki after initialization. ${detail}`.trim()), { statusCode: 502 })
    }

    const removedBootstrapHome = bootstrap.createdFirstPage ? removeAutomaticBootstrapHome(wikiDir) : false
    const targetNames = new Map()
    const created = []
    const updated = []
    const unchanged = []

    for (const doc of docs.files) {
      const name = wikiFileName(doc.rel)
      const collision = targetNames.get(name.toLowerCase())
      if (collision && collision !== doc.rel) {
        throw Object.assign(new Error(`Wiki page collision: ${collision} and ${doc.rel} both map to ${name}`), { statusCode: 409 })
      }
      targetNames.set(name.toLowerCase(), doc.rel)

      const targetFile = path.join(wikiDir, name)
      const next = fs.readFileSync(doc.full)
      if (!fs.existsSync(targetFile)) {
        fs.writeFileSync(targetFile, next)
        created.push({ source: doc.rel, page: name })
        continue
      }

      const current = fs.readFileSync(targetFile)
      if (Buffer.compare(current, next) === 0) {
        unchanged.push({ source: doc.rel, page: name })
      } else {
        fs.writeFileSync(targetFile, next)
        updated.push({ source: doc.rel, page: name })
      }
    }

    const index = generatedWikiIndex(project, docs)
    if (index.generated) {
      const indexFile = path.join(wikiDir, 'index.md')
      if (!fs.existsSync(indexFile)) {
        fs.writeFileSync(indexFile, index.body)
        created.push({ source: '[generated index]', page: 'index.md' })
      } else {
        const current = fs.readFileSync(indexFile)
        if (Buffer.compare(current, index.body) === 0) {
          unchanged.push({ source: '[generated index]', page: 'index.md' })
        } else {
          fs.writeFileSync(indexFile, index.body)
          updated.push({ source: '[generated index]', page: 'index.md' })
        }
      }
    }

    let committed = false
    let commit = ''
    if (created.length || updated.length || removedBootstrapHome) {
      runGit(['config', 'user.name', 'SpecDoc Board'], { cwd: wikiDir, env })
      runGit(['config', 'user.email', 'specdoc-board@localhost'], { cwd: wikiDir, env })
      runGit(['add', '--all'], { cwd: wikiDir, env })
      runGit(['commit', '-m', `SpecDoc: sync ${project.namespace} specifications`], { cwd: wikiDir, env })
      commit = runGit(['rev-parse', '--short', 'HEAD'], { cwd: wikiDir, env })
      runGit(['push', 'origin', 'HEAD'], { cwd: wikiDir, env, timeout: 120000 })
      committed = true
    }

    return {
      ok: true,
      sourceNamespace: project.namespace,
      sourceOutputDir: project.outputDir,
      targetRepo: target.fullName,
      wikiUrl: `${target.htmlUrl}/wiki`,
      committed,
      commit,
      created,
      updated,
      unchanged,
      excludedChangelog: docs.excluded,
      deleted: [],
      generatedIndex: index.generated,
      removedBootstrapHome,
      initializedWikiGit: Boolean(bootstrap.createdFirstPage),
      note: 'Unrelated existing Wiki pages are preserved.'
    }
  } finally {
    syncRunning = false
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function apiError (error) {
  const payload = { ok: false, error: error.message }
  for (const key of ['code', 'initializeUrl', 'bootstrapReason', 'automaticBootstrap']) {
    if (error[key] !== undefined) payload[key] = error[key]
  }
  return payload
}

async function handleApi (req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/wiki-sync/catalog') {
    return writeJson(res, 200, catalog())
  }

  if (req.method === 'GET' && url.pathname === '/api/wiki-sync/validate') {
    try {
      return writeJson(res, 200, validate(url.searchParams.get('ns'), url.searchParams.get('repo')))
    } catch (error) {
      return writeJson(res, error.statusCode || 502, apiError(error))
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/wiki-sync') {
    try {
      const input = await readJsonBody(req)
      const result = syncWiki(input.namespace, input.targetRepo)
      return writeJson(res, 200, result)
    } catch (error) {
      return writeJson(res, error.statusCode || 502, apiError(error))
    }
  }

  return false
}

const injectedUi = String.raw`
<!-- ${UI_MARKER} -->
<style>
#wiki-sync-panel .wiki-sync-grid{display:grid;grid-template-columns:minmax(220px,1fr) minmax(240px,1fr) auto auto;gap:8px;align-items:end}
#wiki-sync-panel label{display:grid;gap:4px;font-size:12px;color:var(--muted)}
#wiki-sync-panel select,#wiki-sync-panel input{min-height:34px;padding:6px 8px}
#wiki-sync-status{margin-top:10px;white-space:pre-wrap}
#wiki-sync-results{margin-top:8px;font-size:12px;color:var(--muted);white-space:pre-wrap}
@media(max-width:900px){#wiki-sync-panel .wiki-sync-grid{grid-template-columns:1fr}}
</style>
<section class="issues-panel" id="wiki-sync-panel">
  <div class="issues-heading">
    <div>
      <h2>GitHub Wiki Sync</h2>
      <span class="context">Sync all generated specification Markdown except CHANGELOG. index.md is generated when the source has no index. Source project and target Wiki are independent; existing unrelated Wiki pages are preserved.</span>
    </div>
  </div>
  <div class="wiki-sync-grid">
    <label>Source specifications
      <select id="wiki-sync-source"><option value="">Loading projects…</option></select>
    </label>
    <label>Target GitHub repository
      <input id="wiki-sync-target" type="text" placeholder="owner/repository" spellcheck="false">
    </label>
    <button id="wiki-sync-validate" type="button">Validate Wiki</button>
    <button id="wiki-sync-run" type="button">Sync Wiki</button>
  </div>
  <div id="wiki-sync-status" class="context">Loading…</div>
  <div id="wiki-sync-results"></div>
</section>
<script>
(() => {
  const esc = (v) => String(v == null ? '' : v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')
  const source = document.getElementById('wiki-sync-source')
  const target = document.getElementById('wiki-sync-target')
  const status = document.getElementById('wiki-sync-status')
  const results = document.getElementById('wiki-sync-results')
  const validateButton = document.getElementById('wiki-sync-validate')
  const syncButton = document.getElementById('wiki-sync-run')
  let projects = []

  async function readResponse(response) {
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : {} } catch {}
    if (!response.ok) {
      const error = new Error((data && data.error) || text || ('HTTP ' + response.status))
      error.data = data || {}
      throw error
    }
    return data || {}
  }

  function selectedProject() {
    return projects.find(p => p.namespace === source.value) || null
  }

  function updateSourceStatus(fillTarget) {
    const p = selectedProject()
    if (!p) { status.textContent = 'Select a source project.'; return }
    status.textContent = p.documentCount + ' specification document(s) ready · ' + p.excludedChangelogCount + ' CHANGELOG excluded'
    if (fillTarget && !target.value.trim() && p.githubRepo) target.value = p.githubRepo
  }

  async function loadCatalog() {
    try {
      const data = await readResponse(await fetch('/api/wiki-sync/catalog', { cache: 'no-store' }))
      projects = data.projects || []
      const wanted = new URLSearchParams(location.search).get('ns') || ''
      source.innerHTML = '<option value="">Select project…</option>' + projects.map(p => '<option value="' + esc(p.namespace) + '">' + esc(p.displayName) + ' (' + esc(p.namespace) + ')</option>').join('')
      if (projects.some(p => p.namespace === wanted)) source.value = wanted
      updateSourceStatus(true)
    } catch (error) {
      status.textContent = error.message
    }
  }

  source.addEventListener('change', () => {
    const p = selectedProject()
    if (p && p.githubRepo) target.value = p.githubRepo
    updateSourceStatus(false)
    results.textContent = ''
  })

  validateButton.addEventListener('click', async () => {
    if (!source.value || !target.value.trim()) { status.textContent = 'Select a source project and enter target owner/repository.'; return }
    validateButton.disabled = true
    status.textContent = 'Validating GitHub Wiki…'
    results.textContent = ''
    try {
      const q = new URLSearchParams({ ns: source.value, repo: target.value.trim() })
      const data = await readResponse(await fetch('/api/wiki-sync/validate?' + q.toString(), { cache: 'no-store' }))
      const t = data.target || {}
      status.textContent = 'Connected · ' + t.repo + ' · Wiki ' + (t.hasWiki ? 'enabled' : 'disabled') + ' · push ' + (t.canPush ? 'available' : 'not reported') + ' · ' + (t.initialized ? 'Wiki git ready' : 'Wiki git not initialized')
      const initHelp = !t.initialized
        ? ('\nFirst-time setup: ' + (t.automaticBootstrapReady ? 'automatic bootstrap is ready; Sync Wiki will initialize it.' : 'create the first page as index, then Sync Wiki again.') + ' <a target="_blank" rel="noopener" href="' + esc(t.initializeUrl || t.wikiUrl || '#') + '">Initialize Wiki</a>')
        : ''
      results.innerHTML = (data.source.documents || 0) + ' document(s) · ' + (data.source.excludedChangelog || 0) + ' CHANGELOG excluded · <a target="_blank" rel="noopener" href="' + esc(t.wikiUrl || '#') + '">Open Wiki</a>' + initHelp
    } catch (error) {
      status.textContent = error.message
    } finally {
      validateButton.disabled = false
    }
  })

  syncButton.addEventListener('click', async () => {
    if (!source.value || !target.value.trim()) { status.textContent = 'Select a source project and enter target owner/repository.'; return }
    syncButton.disabled = true
    validateButton.disabled = true
    status.textContent = 'Syncing specifications to GitHub Wiki…'
    results.textContent = ''
    try {
      const data = await readResponse(await fetch('/api/wiki-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ namespace: source.value, targetRepo: target.value.trim() })
      }))
      status.textContent = 'Wiki sync complete · ' + data.targetRepo
      const lines = [
        'Created: ' + (data.created || []).length,
        'Updated: ' + (data.updated || []).length,
        'Unchanged: ' + (data.unchanged || []).length,
        'CHANGELOG excluded: ' + (data.excludedChangelog || []).length,
        'Deleted: 0',
        data.generatedIndex ? 'Index: generated index.md' : 'Index: source index.md',
        data.initializedWikiGit ? 'Wiki git: initialized automatically' : 'Wiki git: existing',
        data.removedBootstrapHome ? 'Bootstrap Home.md: removed' : '',
        data.committed ? ('Commit: ' + data.commit) : 'No commit required',
        data.note || ''
      ].filter(Boolean)
      results.innerHTML = esc(lines.join('\n')) + '\n<a target="_blank" rel="noopener" href="' + esc(data.wikiUrl || '#') + '">Open synced Wiki</a>'
    } catch (error) {
      const detail = error.data || {}
      if (detail.code === 'WIKI_NOT_INITIALIZED' && detail.initializeUrl) {
        status.textContent = 'Wiki git is not initialized.'
        results.innerHTML = esc(error.message) + '\n<a target="_blank" rel="noopener" href="' + esc(detail.initializeUrl) + '">Create first page as index</a>\nAfter saving it on GitHub, click Sync Wiki again.'
      } else {
        status.textContent = error.message
      }
    } finally {
      syncButton.disabled = false
      validateButton.disabled = false
    }
  })

  loadCatalog()
})()
</script>
`

function injectUi (html) {
  if (typeof html !== 'string' || html.includes(UI_MARKER)) return html
  const anchor = '<section class="issues-panel" id="llm-tasks-panel">'
  if (html.includes(anchor)) return html.replace(anchor, injectedUi + '\n' + anchor)
  const footer = '<p class="footer-note">'
  if (html.includes(footer)) return html.replace(footer, injectedUi + '\n' + footer)
  const pos = html.lastIndexOf('</body>')
  if (pos >= 0) return html.slice(0, pos) + injectedUi + '\n' + html.slice(pos)
  return html + '\n' + injectedUi
}

function wrapHtmlResponse (req, res) {
  if (req.method !== 'GET') return
  let pathname = ''
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname } catch {}
  if (pathname !== '/') return

  const originalWriteHead = res.writeHead.bind(res)
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  const chunks = []
  let buffering = true

  res.writeHead = function (...args) {
    try {
      if (!res.headersSent && res.hasHeader('content-length')) res.removeHeader('content-length')
      const headerArg = args.find(arg => arg && typeof arg === 'object' && !Array.isArray(arg))
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
    if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
    if (typeof callback === 'function') process.nextTick(callback)
    return true
  }

  res.end = function (chunk, encoding, callback) {
    if (!buffering) return originalEnd(chunk, encoding, callback)
    if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
    buffering = false

    let body = Buffer.concat(chunks)
    const contentEncoding = String(res.getHeader('content-encoding') || '').toLowerCase()
    const contentType = String(res.getHeader('content-type') || '').toLowerCase()
    if (!contentEncoding && (contentType.includes('text/html') || body.toString('utf8', 0, Math.min(body.length, 4096)).includes('<html'))) {
      const text = body.toString('utf8')
      const changed = injectUi(text)
      if (changed !== text) {
        body = Buffer.from(changed)
        if (!res.headersSent) res.removeHeader('content-length')
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
    let url
    try { url = new URL(req.url, 'http://127.0.0.1') } catch { url = { pathname: String(req.url || '/') } }

    if (String(url.pathname).startsWith('/api/wiki-sync')) {
      Promise.resolve(handleApi(req, res, url)).catch(error => {
        if (!res.writableEnded) writeJson(res, error.statusCode || 500, { ok: false, error: error.message })
      })
      return true
    }

    wrapHtmlResponse(req, res)
  }
  return originalEmit.call(this, event, ...args)
}

console.log('[wiki-sync-hook] enabled v14')
