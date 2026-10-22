'use strict'

/*
 * SpecDoc Board — local Git repository -> GitHub branch sync.
 *
 * Safety properties:
 *   - History sync pushes committed Git history only and requires a clean tree;
 *   - Snapshot sync publishes only the selected branch tree as one new target commit;
 *   - Snapshot sync never transfers the selected branch's old commit history;
 *   - Snapshot sync may run with a dirty worktree because uncommitted changes are excluded;
 *   - refuses unsafe history rewrites and never force-pushes;
 *   - source repository/branch and target repository/branch are explicit.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { execFileSync, spawnSync } = require('child_process')

const ROOT = path.resolve(process.env.SPECDOC_ROOT || '/data/projects/specdoc')
const BOARD = path.resolve(process.env.SPECDOC_BOARD_DIR || path.join(ROOT, 'hd2-board'))
const PROJECTS_ROOT = path.resolve(process.env.SPECDOC_PROJECTS_ROOT || '/data/projects')
const REPOSITORIES_FILE = path.resolve(process.env.SPECDOC_REPOSITORIES_FILE || path.join(BOARD, 'data', 'repositories.json'))
const GH = process.env.SPECDOC_GH_BIN || '/data/projects/github-cli/bin/gh'
const GIT = process.env.SPECDOC_GIT_BIN || '/usr/bin/git'
const GH_ENV = {
  ...process.env,
  HOME: process.env.HOME || '/home/hp',
  GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || '/home/hp/.config/gh'
}
const UI_MARKER = 'SPECDOC_GITHUB_SOURCE_SYNC_V16'
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

function inside (parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function readRepositoryRegistry () {
  try {
    const parsed = JSON.parse(fs.readFileSync(REPOSITORIES_FILE, 'utf8'))
    return Array.isArray(parsed.repositories) ? parsed.repositories.filter(Boolean) : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function runGit (repoPath, args, opts = {}) {
  return execFileSync(GIT, args, {
    cwd: repoPath,
    encoding: 'utf8',
    env: opts.env || process.env,
    timeout: opts.timeout || 30000,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function gitStatus (repoPath, args, opts = {}) {
  return spawnSync(GIT, args, {
    cwd: repoPath,
    encoding: 'utf8',
    env: opts.env || process.env,
    timeout: opts.timeout || 30000,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function ghExec (args, opts = {}) {
  return execFileSync(GH, args, {
    encoding: 'utf8',
    env: GH_ENV,
    timeout: opts.timeout || 30000,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function ghJson (args, opts = {}) {
  return JSON.parse(ghExec(args, opts) || '{}')
}

function currentBranch (repoPath) {
  try { return runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']) } catch { return '' }
}

function localBranches (repoPath) {
  const out = runGit(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return out ? out.split(/\r?\n/).map(x => x.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)) : []
}

function originRepo (repoPath) {
  let remote = ''
  try { remote = runGit(repoPath, ['remote', 'get-url', 'origin']) } catch { return '' }
  const text = String(remote || '').trim().replace(/\.git$/i, '')
  let m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(text)
  if (!m) m = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(text)
  if (!m) m = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i.exec(text)
  return m ? `${m[1]}/${m[2]}` : ''
}

function repositoryCatalog () {
  const rows = []
  for (const item of readRepositoryRegistry()) {
    const id = String(item.id || item.repo || '').trim()
    const rawPath = String(item.path || '').trim()
    if (!id || !rawPath) continue

    const repoPath = path.resolve(rawPath)
    if (!inside(PROJECTS_ROOT, repoPath)) continue
    try {
      if (!fs.statSync(repoPath).isDirectory() || !fs.existsSync(path.join(repoPath, '.git'))) continue
    } catch { continue }

    const branches = localBranches(repoPath)
    const branch = currentBranch(repoPath)
    const githubRepo = parseRepoLoose(item.id) || originRepo(repoPath)
    rows.push({
      id,
      path: repoPath,
      currentBranch: branch,
      branchCount: branches.length,
      githubRepo
    })
  }

  rows.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }))
  const targets = Array.from(new Set(rows.map(row => row.githubRepo).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  return { ok: true, repositories: rows, targets }
}

function parseRepoLoose (value) {
  const raw = String(value || '').trim()
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(raw)
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return ''
  return `${m[1]}/${m[2]}`
}

function parseRepo (value) {
  const repo = parseRepoLoose(value)
  if (!repo) throw Object.assign(new Error('Target repository must be owner/repository'), { statusCode: 400 })
  return repo
}

function sourceRepository (id) {
  const wanted = String(id || '').trim()
  if (!wanted) throw Object.assign(new Error('Source repository is required'), { statusCode: 400 })

  const item = readRepositoryRegistry().find(row => String(row.id || row.repo || '').trim() === wanted)
  if (!item) throw Object.assign(new Error(`Unknown registered repository: ${wanted}`), { statusCode: 404 })

  const repoPath = path.resolve(String(item.path || ''))
  if (!inside(PROJECTS_ROOT, repoPath)) {
    throw Object.assign(new Error(`Unsafe source repository path: ${repoPath}`), { statusCode: 400 })
  }
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory() || !fs.existsSync(path.join(repoPath, '.git'))) {
    throw Object.assign(new Error(`Source path is not a Git repository: ${repoPath}`), { statusCode: 404 })
  }

  return {
    id: wanted,
    path: repoPath,
    githubRepo: parseRepoLoose(item.id) || originRepo(repoPath),
    currentBranch: currentBranch(repoPath)
  }
}

function validateBranchName (branch, label) {
  const value = String(branch || '').trim()
  if (!value) throw Object.assign(new Error(`${label} is required`), { statusCode: 400 })
  const result = gitStatus(PROJECTS_ROOT, ['check-ref-format', '--branch', value])
  if (result.status !== 0 || value === 'HEAD') {
    throw Object.assign(new Error(`Invalid ${label.toLowerCase()}: ${value}`), { statusCode: 400 })
  }
  return value
}

function targetRepoInfo (repo) {
  const metadata = ghJson(['api', `repos/${repo}`])
  const permissions = metadata.permissions || {}
  return {
    fullName: String(metadata.full_name || repo),
    htmlUrl: String(metadata.html_url || `https://github.com/${repo}`),
    defaultBranch: String(metadata.default_branch || ''),
    canPush: Boolean(permissions.push || permissions.admin || permissions.maintain),
    private: Boolean(metadata.private)
  }
}

function remoteBranches (repo) {
  const out = ghExec(['api', '--paginate', `repos/${repo}/branches?per_page=100`, '--jq', '.[].name'], { timeout: 60000 })
  return out ? Array.from(new Set(out.split(/\r?\n/).map(x => x.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)) : []
}

function workingTree (repoPath) {
  const out = runGit(repoPath, ['status', '--porcelain=v1', '--untracked-files=all'])
  const entries = out ? out.split(/\r?\n/).filter(Boolean) : []
  return {
    clean: entries.length === 0,
    count: entries.length,
    sample: entries.slice(0, 8)
  }
}

function sourceSha (repoPath, branch) {
  try {
    return runGit(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
  } catch {
    throw Object.assign(new Error(`Local branch not found: ${branch}`), { statusCode: 404 })
  }
}

function sourceTreeSha (repoPath, branch) {
  try {
    return runGit(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}^{tree}`])
  } catch {
    throw Object.assign(new Error(`Local branch tree not found: ${branch}`), { statusCode: 404 })
  }
}

function treeShaForCommit (repoPath, commitSha) {
  return runGit(repoPath, ['rev-parse', '--verify', `${commitSha}^{tree}`])
}

function largeTrackedBlobs (repoPath, branch, limitBytes = 100 * 1024 * 1024) {
  const result = gitStatus(repoPath, ['ls-tree', '-r', '-l', `refs/heads/${branch}`], { maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) return []
  const rows = String(result.stdout || '').split(/\r?\n/).filter(Boolean)
  const hits = []
  for (const row of rows) {
    const m = /^\d+\s+blob\s+[0-9a-f]+\s+(\d+)\t(.+)$/.exec(row)
    if (!m) continue
    const size = Number(m[1])
    if (Number.isFinite(size) && size >= limitBytes) hits.push({ path: m[2], size })
  }
  return hits.sort((a, b) => b.size - a.size)
}

function syncMode (value) {
  return String(value || '').trim().toLowerCase() === 'snapshot' ? 'snapshot' : 'history'
}

function ghToken () {
  try { return ghExec(['auth', 'token'], { timeout: 15000 }) } catch {
    throw Object.assign(new Error('GitHub CLI is not authenticated on G3'), { statusCode: 401 })
  }
}

function createAskPass (tmp) {
  const file = path.join(tmp, 'git-askpass.sh')
  fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *Password*) printf '%s\\n' "$SPECDOC_GH_TOKEN" ;;\n  *) printf '%s\\n' '' ;;\nesac\n`, { mode: 0o700 })
  return file
}

function authenticatedGitEnv (tmp) {
  const token = ghToken()
  const askPass = createAskPass(tmp)
  return {
    ...process.env,
    GIT_ASKPASS: askPass,
    GIT_TERMINAL_PROMPT: '0',
    SPECDOC_GH_TOKEN: token
  }
}

function fetchRemoteHead (source, targetRepo, targetBranch, env) {
  const url = `https://github.com/${targetRepo}.git`
  runGit(source.path, ['fetch', '--quiet', '--no-tags', '--', url, `refs/heads/${targetBranch}`], { env, timeout: 120000 })
  return runGit(source.path, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { env })
}

function isAncestor (repoPath, older, newer) {
  const result = gitStatus(repoPath, ['merge-base', '--is-ancestor', older, newer])
  return result.status === 0
}

function aheadBehind (repoPath, remoteSha, localSha) {
  const out = runGit(repoPath, ['rev-list', '--left-right', '--count', `${remoteSha}...${localSha}`])
  const [behindRaw, aheadRaw] = out.trim().split(/\s+/)
  return { behind: Number(behindRaw || 0), ahead: Number(aheadRaw || 0) }
}

function branchRelation (source, sourceBranch, targetRepo, targetBranch, remoteNames, env) {
  const localSha = sourceSha(source.path, sourceBranch)
  if (!remoteNames.includes(targetBranch)) {
    return {
      kind: 'new',
      allowed: true,
      sourceSha: localSha,
      remoteSha: '',
      ahead: null,
      behind: null,
      message: `Target branch ${targetBranch} does not exist and will be created.`
    }
  }

  const remoteSha = fetchRemoteHead(source, targetRepo, targetBranch, env)
  if (remoteSha === localSha) {
    return {
      kind: 'synchronized',
      allowed: true,
      sourceSha: localSha,
      remoteSha,
      ahead: 0,
      behind: 0,
      message: 'Already synchronized.'
    }
  }

  const counts = aheadBehind(source.path, remoteSha, localSha)
  if (isAncestor(source.path, remoteSha, localSha)) {
    return {
      kind: 'fast-forward',
      allowed: true,
      sourceSha: localSha,
      remoteSha,
      ...counts,
      message: `Safe fast-forward available (${counts.ahead} local commit(s) ahead).`
    }
  }
  if (isAncestor(source.path, localSha, remoteSha)) {
    return {
      kind: 'remote-ahead',
      allowed: false,
      sourceSha: localSha,
      remoteSha,
      ...counts,
      message: `Blocked: target branch is ahead by ${counts.behind} commit(s). Pull/merge locally first.`
    }
  }

  return {
    kind: 'diverged',
    allowed: false,
    sourceSha: localSha,
    remoteSha,
    ...counts,
    message: `Blocked: branches diverged (${counts.ahead} local-only, ${counts.behind} remote-only). Force push is disabled.`
  }
}

function snapshotRelation (source, sourceBranch, targetRepo, targetBranch, remoteNames, env) {
  const localSha = sourceSha(source.path, sourceBranch)
  const localTreeSha = sourceTreeSha(source.path, sourceBranch)

  if (!remoteNames.includes(targetBranch)) {
    return {
      kind: 'snapshot-new',
      allowed: true,
      sourceSha: localSha,
      sourceTreeSha: localTreeSha,
      remoteSha: '',
      remoteTreeSha: '',
      ahead: null,
      behind: null,
      message: `Snapshot ready. Target branch ${targetBranch} will be created with one root commit; source history will not be transferred.`
    }
  }

  const remoteSha = fetchRemoteHead(source, targetRepo, targetBranch, env)
  const remoteTreeSha = treeShaForCommit(source.path, remoteSha)
  if (remoteTreeSha === localTreeSha) {
    return {
      kind: 'snapshot-synchronized',
      allowed: true,
      sourceSha: localSha,
      sourceTreeSha: localTreeSha,
      remoteSha,
      remoteTreeSha,
      ahead: 0,
      behind: 0,
      message: 'Snapshot tree is already synchronized. No source history will be transferred.'
    }
  }

  return {
    kind: 'snapshot-update',
    allowed: true,
    sourceSha: localSha,
    sourceTreeSha: localTreeSha,
    remoteSha,
    remoteTreeSha,
    ahead: null,
    behind: null,
    message: 'Snapshot ready. A single commit containing the selected branch tree will be appended to the target branch; source history will not be transferred.'
  }
}

function branchesPayload (sourceId, targetValue) {
  const source = sourceRepository(sourceId)
  const local = localBranches(source.path)
  let target = null
  let remote = []

  const targetValueTrimmed = String(targetValue || '').trim()
  if (targetValueTrimmed) {
    const repo = parseRepo(targetValueTrimmed)
    target = targetRepoInfo(repo)
    remote = remoteBranches(repo)
  }

  return {
    ok: true,
    source: {
      id: source.id,
      path: source.path,
      currentBranch: source.currentBranch,
      githubRepo: source.githubRepo,
      branches: local
    },
    target: target ? { ...target, branches: remote } : null
  }
}

function preflight (input) {
  const mode = syncMode(input.mode)
  const source = sourceRepository(input.sourceId)
  const sourceBranch = validateBranchName(input.sourceBranch || source.currentBranch, 'Source branch')
  const targetRepo = parseRepo(input.targetRepo || source.githubRepo)
  const targetBranch = validateBranchName(input.targetBranch || sourceBranch, 'Target branch')

  if (!localBranches(source.path).includes(sourceBranch)) {
    throw Object.assign(new Error(`Local branch not found: ${sourceBranch}`), { statusCode: 404 })
  }

  const target = targetRepoInfo(targetRepo)
  if (!target.canPush) {
    throw Object.assign(new Error(`GitHub authentication does not report push access to ${targetRepo}`), { statusCode: 403 })
  }

  const tree = workingTree(source.path)
  const names = remoteBranches(targetRepo)
  const largeFiles = largeTrackedBlobs(source.path, sourceBranch)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-repo-sync-validate-'))
  try {
    const env = authenticatedGitEnv(tmp)
    const relation = mode === 'snapshot'
      ? snapshotRelation(source, sourceBranch, targetRepo, targetBranch, names, env)
      : branchRelation(source, sourceBranch, targetRepo, targetBranch, names, env)

    let allowed = relation.allowed
    let blockReason = ''
    if (largeFiles.length) {
      allowed = false
      blockReason = `Selected branch contains ${largeFiles.length} tracked file(s) at or above GitHub's 100 MiB file limit.`
    } else if (mode === 'history' && !tree.clean) {
      allowed = false
      blockReason = `Working tree has ${tree.count} uncommitted/untracked change(s). Commit or clean them before history sync.`
    } else if (!relation.allowed) {
      allowed = false
      blockReason = relation.message
    }

    return {
      ok: true,
      mode,
      allowed,
      blockReason,
      source: {
        id: source.id,
        path: source.path,
        branch: sourceBranch,
        sha: relation.sourceSha,
        treeSha: relation.sourceTreeSha || sourceTreeSha(source.path, sourceBranch),
        workingTree: tree,
        largeFiles: largeFiles.slice(0, 8)
      },
      target: {
        repo: target.fullName,
        htmlUrl: target.htmlUrl,
        branch: targetBranch,
        defaultBranch: target.defaultBranch,
        canPush: target.canPush,
        branchExists: names.includes(targetBranch),
        sha: relation.remoteSha
      },
      relation,
      warning: mode === 'snapshot' && !tree.clean
        ? `Working tree has ${tree.count} local change(s). Snapshot sync uses committed branch ${sourceBranch} only; uncommitted changes are not included.`
        : ''
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function createSnapshotCommit (repoPath, sourceBranch, parentSha) {
  const treeSha = sourceTreeSha(repoPath, sourceBranch)
  const sourceCommit = sourceSha(repoPath, sourceBranch)
  const message = `SpecDoc snapshot sync from ${sourceBranch}\n\nSource commit: ${sourceCommit}\n`
  const args = ['commit-tree', treeSha]
  if (parentSha) args.push('-p', parentSha)
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'SpecDoc Board',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'specdoc-board@local',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'SpecDoc Board',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'specdoc-board@local'
  }
  const result = spawnSync(GIT, args, {
    cwd: repoPath,
    input: message,
    encoding: 'utf8',
    env,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw Object.assign(new Error(`Unable to create snapshot commit${detail ? `: ${detail}` : ''}`), { statusCode: 500 })
  }
  return String(result.stdout || '').trim()
}

function syncSnapshot (check) {
  if (check.relation.kind === 'snapshot-synchronized') {
    return {
      ok: true,
      changed: false,
      result: 'Snapshot already synchronized',
      mode: 'snapshot',
      source: check.source,
      target: check.target,
      relation: check.relation
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-repo-sync-snapshot-'))
  try {
    const env = authenticatedGitEnv(tmp)
    const url = `https://github.com/${check.target.repo}.git`
    let parentSha = ''

    // Re-read the target immediately before creating the snapshot commit. This
    // prevents a stale validation result from becoming an unsafe update.
    if (check.target.branchExists) {
      parentSha = fetchRemoteHead({ path: check.source.path }, check.target.repo, check.target.branch, env)
      const currentRemoteTree = treeShaForCommit(check.source.path, parentSha)
      if (currentRemoteTree === check.source.treeSha) {
        return {
          ok: true,
          changed: false,
          result: 'Snapshot already synchronized',
          mode: 'snapshot',
          source: check.source,
          target: { ...check.target, sha: parentSha },
          relation: { ...check.relation, remoteSha: parentSha, remoteTreeSha: currentRemoteTree }
        }
      }
    }

    const snapshotSha = createSnapshotCommit(check.source.path, check.source.branch, parentSha)
    const refspec = `${snapshotSha}:refs/heads/${check.target.branch}`
    const output = runGit(check.source.path, ['push', '--porcelain', '--', url, refspec], { env, timeout: 180000 })
    return {
      ok: true,
      changed: true,
      result: check.target.branchExists ? 'Snapshot updated branch' : 'Snapshot created branch',
      mode: 'snapshot',
      snapshotSha,
      source: check.source,
      target: { ...check.target, previousSha: parentSha, sha: snapshotSha },
      relation: check.relation,
      output: output.split(/\r?\n/).filter(Boolean).slice(-8)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function syncRepository (input) {
  if (syncRunning) throw Object.assign(new Error('Another repository sync is already running'), { statusCode: 409 })
  syncRunning = true
  try {
    const check = preflight(input)
    if (!check.allowed) {
      throw Object.assign(new Error(check.blockReason || 'Repository sync is blocked by validation'), {
        statusCode: 409,
        preflight: check
      })
    }

    if (check.mode === 'snapshot') return syncSnapshot(check)

    if (check.relation.kind === 'synchronized') {
      return {
        ok: true,
        changed: false,
        result: 'Already synchronized',
        mode: 'history',
        source: check.source,
        target: check.target,
        relation: check.relation
      }
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-repo-sync-push-'))
    try {
      const env = authenticatedGitEnv(tmp)
      const url = `https://github.com/${check.target.repo}.git`
      const refspec = `refs/heads/${check.source.branch}:refs/heads/${check.target.branch}`
      const output = runGit(check.source.path, ['push', '--porcelain', '--', url, refspec], { env, timeout: 180000 })
      return {
        ok: true,
        changed: true,
        result: check.target.branchExists ? 'Updated branch' : 'Created branch',
        mode: 'history',
        source: check.source,
        target: check.target,
        relation: check.relation,
        output: output.split(/\r?\n/).filter(Boolean).slice(-8)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  } finally {
    syncRunning = false
  }
}

function apiError (error) {
  const payload = { ok: false, error: error.message }
  if (error.preflight) payload.preflight = error.preflight
  return payload
}

async function handleApi (req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/repo-sync/catalog') {
    try { return writeJson(res, 200, repositoryCatalog()) } catch (error) { return writeJson(res, error.statusCode || 500, apiError(error)) }
  }

  if (req.method === 'GET' && url.pathname === '/api/repo-sync/branches') {
    try {
      return writeJson(res, 200, branchesPayload(url.searchParams.get('source'), url.searchParams.get('repo')))
    } catch (error) {
      return writeJson(res, error.statusCode || 502, apiError(error))
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/repo-sync/validate') {
    try {
      const input = await readJsonBody(req)
      return writeJson(res, 200, preflight(input))
    } catch (error) {
      return writeJson(res, error.statusCode || 502, apiError(error))
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/repo-sync') {
    try {
      const input = await readJsonBody(req)
      return writeJson(res, 200, syncRepository(input))
    } catch (error) {
      return writeJson(res, error.statusCode || 502, apiError(error))
    }
  }

  return false
}

const injectedUi = String.raw`
<!-- ${UI_MARKER} -->
<style>
#repo-sync-panel .repo-sync-grid{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(200px,1fr) minmax(180px,.8fr) minmax(220px,1fr) minmax(180px,.8fr) auto auto;gap:8px;align-items:end}
#repo-sync-panel label{display:grid;gap:4px;font-size:12px;color:var(--muted)}
#repo-sync-panel select,#repo-sync-panel input{min-height:34px;padding:6px 8px}
#repo-sync-status{margin-top:10px;white-space:pre-wrap}
#repo-sync-results{margin-top:8px;font-size:12px;color:var(--muted);white-space:pre-wrap}
@media(max-width:1050px){#repo-sync-panel .repo-sync-grid{grid-template-columns:1fr 1fr}}
@media(max-width:700px){#repo-sync-panel .repo-sync-grid{grid-template-columns:1fr}}
</style>
<section class="issues-panel" id="repo-sync-panel">
  <div class="issues-heading">
    <div>
      <h2>GitHub Source Sync</h2>
      <span class="context">History sync preserves Git history. Snapshot sync appends one clean commit containing the selected branch tree, without transferring old source history. Force push is never used.</span>
    </div>
  </div>
  <div class="repo-sync-grid">
    <label>Sync mode
      <select id="repo-sync-mode">
        <option value="history">History sync</option>
        <option value="snapshot">Snapshot sync</option>
      </select>
    </label>
    <label>Source repository
      <select id="repo-sync-source"><option value="">Loading repositories…</option></select>
    </label>
    <label>Source branch
      <select id="repo-sync-source-branch"><option value="">Select repository…</option></select>
    </label>
    <label>Target GitHub repository
      <input id="repo-sync-target" type="text" list="repo-sync-targets" placeholder="owner/repository" spellcheck="false">
      <datalist id="repo-sync-targets"></datalist>
    </label>
    <label>Target branch
      <input id="repo-sync-target-branch" type="text" list="repo-sync-target-branches" placeholder="branch name" spellcheck="false">
      <datalist id="repo-sync-target-branches"></datalist>
    </label>
    <button id="repo-sync-validate" type="button">Validate GitHub</button>
    <button id="repo-sync-run" type="button">Sync Repo</button>
  </div>
  <div id="repo-sync-status" class="context">Loading…</div>
  <div id="repo-sync-results"></div>
</section>
<script>
(() => {
  const mode = document.getElementById('repo-sync-mode')
  const source = document.getElementById('repo-sync-source')
  const sourceBranch = document.getElementById('repo-sync-source-branch')
  const target = document.getElementById('repo-sync-target')
  const targetBranch = document.getElementById('repo-sync-target-branch')
  const targetList = document.getElementById('repo-sync-targets')
  const branchList = document.getElementById('repo-sync-target-branches')
  const status = document.getElementById('repo-sync-status')
  const results = document.getElementById('repo-sync-results')
  const validateButton = document.getElementById('repo-sync-validate')
  const syncButton = document.getElementById('repo-sync-run')
  let repositories = []
  let lastLoadedTarget = ''

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

  function selectedRepository() {
    return repositories.find(r => r.id === source.value) || null
  }

  function payload() {
    return {
      mode: mode.value,
      sourceId: source.value,
      sourceBranch: sourceBranch.value,
      targetRepo: target.value.trim(),
      targetBranch: targetBranch.value.trim()
    }
  }

  function shortSha(value) { return value ? String(value).slice(0, 12) : '—' }

  function markChanged() {
    results.textContent = ''
    syncButton.disabled = true
  }

  async function loadCatalog() {
    try {
      const data = await readResponse(await fetch('/api/repo-sync/catalog', { cache: 'no-store' }))
      repositories = data.repositories || []
      source.innerHTML = '<option value="">Select repository…</option>' + repositories.map(r =>
        '<option value="' + r.id.replaceAll('&','&amp;').replaceAll('"','&quot;') + '">' +
        (r.id + ' · ' + r.path).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;') + '</option>'
      ).join('')
      targetList.innerHTML = (data.targets || []).map(r => '<option value="' + r.replaceAll('&','&amp;').replaceAll('"','&quot;') + '"></option>').join('')
      status.textContent = repositories.length ? 'Select a source repository.' : 'No registered local Git repositories found.'
    } catch (error) {
      status.textContent = error.message
    }
  }

  async function loadBranches(fillTarget) {
    const p = selectedRepository()
    if (!p) {
      sourceBranch.innerHTML = '<option value="">Select repository…</option>'
      status.textContent = 'Select a source repository.'
      return
    }

    if (fillTarget && !target.value.trim() && p.githubRepo) target.value = p.githubRepo
    const q = new URLSearchParams({ source: p.id })
    if (target.value.trim()) q.set('repo', target.value.trim())
    status.textContent = 'Loading branches…'
    validateButton.disabled = true
    syncButton.disabled = true

    try {
      const data = await readResponse(await fetch('/api/repo-sync/branches?' + q.toString(), { cache: 'no-store' }))
      const locals = (data.source && data.source.branches) || []
      sourceBranch.innerHTML = locals.map(b => '<option value="' + b.replaceAll('&','&amp;').replaceAll('"','&quot;') + '">' + b.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;') + '</option>').join('')
      sourceBranch.value = (data.source && data.source.currentBranch && locals.includes(data.source.currentBranch)) ? data.source.currentBranch : (locals[0] || '')

      const remote = (data.target && data.target.branches) || []
      branchList.innerHTML = remote.map(b => '<option value="' + b.replaceAll('&','&amp;').replaceAll('"','&quot;') + '"></option>').join('')
      if (!targetBranch.value.trim() || lastLoadedTarget !== target.value.trim()) {
        const preferred = remote.includes(sourceBranch.value) ? sourceBranch.value : ((data.target && data.target.defaultBranch) || sourceBranch.value)
        targetBranch.value = preferred || ''
      }
      lastLoadedTarget = target.value.trim()
      status.textContent = data.target
        ? ('Connected · ' + data.target.fullName + ' · ' + (data.target.canPush ? 'push available' : 'push unavailable') + ' · ' + remote.length + ' remote branch(es)')
        : (data.source.path + ' · ' + locals.length + ' local branch(es)')
      validateButton.disabled = false
    } catch (error) {
      status.textContent = error.message
      validateButton.disabled = false
    }
  }

  async function validate() {
    results.textContent = ''
    status.textContent = 'Validating source and GitHub branch…'
    validateButton.disabled = true
    syncButton.disabled = true
    try {
      const data = await readResponse(await fetch('/api/repo-sync/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload())
      }))
      const tree = data.source.workingTree
      status.textContent = [
        data.allowed ? (data.mode === 'snapshot' ? 'Snapshot ready' : 'Ready to sync') : 'Sync blocked',
        data.source.id + ':' + data.source.branch,
        shortSha(data.source.sha),
        '→ ' + data.target.repo + ':' + data.target.branch,
        data.target.branchExists ? shortSha(data.target.sha) : 'new branch',
        tree.clean ? 'working tree clean' : (tree.count + ' local change(s)'),
        data.relation.message
      ].join(' · ')
      const detail = []
      if (data.warning) detail.push('WARNING: ' + data.warning)
      if (data.source.largeFiles && data.source.largeFiles.length) {
        detail.push('BLOCKED large tracked files:')
        data.source.largeFiles.forEach(f => detail.push((f.size / 1048576).toFixed(1) + ' MiB  ' + f.path))
      }
      if (!tree.clean && tree.sample && tree.sample.length) {
        detail.push(data.mode === 'snapshot' ? 'Uncommitted changes not included:' : 'Local changes:')
        detail.push(...tree.sample)
      }
      results.textContent = detail.join('\n')
      syncButton.disabled = !data.allowed
    } catch (error) {
      status.textContent = error.message
      if (error.data && error.data.preflight && error.data.preflight.blockReason) results.textContent = error.data.preflight.blockReason
    } finally {
      validateButton.disabled = false
    }
  }

  async function sync() {
    const p = payload()
    const action = p.mode === 'snapshot'
      ? ('Publish a clean snapshot of ' + p.sourceId + ':' + p.sourceBranch + ' to ' + p.targetRepo + ':' + p.targetBranch + '?\n\nOnly the committed branch tree is included. Old source history and uncommitted changes are not transferred. No force push will be used.')
      : ('Push Git history from ' + p.sourceId + ':' + p.sourceBranch + ' to ' + p.targetRepo + ':' + p.targetBranch + '?\n\nNo force push will be used.')
    if (!confirm(action)) return
    status.textContent = 'Syncing repository…'
    results.textContent = ''
    validateButton.disabled = true
    syncButton.disabled = true
    try {
      const data = await readResponse(await fetch('/api/repo-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p)
      }))
      status.textContent = data.result + ' · ' + data.source.id + ':' + data.source.branch + ' → ' + data.target.repo + ':' + data.target.branch + ' · ' + shortSha(data.snapshotSha || data.target.sha || data.source.sha)
      results.textContent = (data.output || []).join('\n')
      await loadBranches(false)
    } catch (error) {
      status.textContent = error.message
      if (error.data && error.data.preflight) results.textContent = error.data.preflight.blockReason || ''
    } finally {
      validateButton.disabled = false
    }
  }

  mode.addEventListener('change', markChanged)
  source.addEventListener('change', () => { targetBranch.value = ''; markChanged(); loadBranches(true) })
  sourceBranch.addEventListener('change', () => { if (!targetBranch.value.trim()) targetBranch.value = sourceBranch.value; markChanged() })
  target.addEventListener('change', () => { targetBranch.value = ''; markChanged(); loadBranches(false) })
  target.addEventListener('blur', () => { if (target.value.trim() && target.value.trim() !== lastLoadedTarget) loadBranches(false) })
  targetBranch.addEventListener('input', markChanged)
  validateButton.addEventListener('click', validate)
  syncButton.addEventListener('click', sync)
  syncButton.disabled = true
  loadCatalog()
})()
</script>
`

function injectUi (html) {
  if (typeof html !== 'string' || html.includes(UI_MARKER)) return html
  const footer = '</main>'
  if (html.includes(footer)) return html.replace(footer, injectedUi + '\n' + footer)
  const pos = html.lastIndexOf('</body>')
  if (pos >= 0) return html.slice(0, pos) + injectedUi + '\n' + html.slice(pos)
  return html + '\n' + injectedUi
}

function wrapHtmlResponse (req, res) {
  const accept = String(req.headers && req.headers.accept || '')
  if (!accept.includes('text/html') && req.url !== '/') return

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
        for (const key of Object.keys(headerArg)) if (key.toLowerCase() === 'content-length') delete headerArg[key]
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
      body = Buffer.from(injectUi(body.toString('utf8')))
      if (!res.headersSent) res.removeHeader('content-length')
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
    try { url = new URL(req.url, 'http://127.0.0.1') } catch { url = null }

    if (url && String(url.pathname).startsWith('/api/repo-sync')) {
      handleApi(req, res, url).catch(error => {
        if (!res.headersSent) writeJson(res, error.statusCode || 500, apiError(error))
        else res.destroy(error)
      })
      return true
    }

    wrapHtmlResponse(req, res)
  }
  return originalEmit.call(this, event, ...args)
}

console.log('[repo-sync-hook] enabled v16 snapshot sync')
