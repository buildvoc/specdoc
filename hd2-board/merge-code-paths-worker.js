'use strict'

/*
 * SpecDoc Board — ONE standard Refresh specs run over multiple code paths.
 *
 * The selected codebases are staged into one synthetic Git working tree using
 * current tracked + unignored files. The Board's existing POST /refresh-specdoc
 * endpoint is then called exactly once for that combined working tree. There is
 * no reading, selecting, or merging of existing specification Markdown files.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const { execFileSync } = require('child_process')

const JOB_FILE = process.argv[2]
if (!JOB_FILE) throw new Error('Job file argument required')

const ROOT = process.env.SPECDOC_ROOT || '/data/projects/specdoc'
const BOARD_URL = process.env.SPECDOC_BOARD_INTERNAL_URL || 'http://127.0.0.1:8080'
const COMBINED_ROOT = path.join(ROOT, '.combined-codepaths')

function readJob () { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')) }
function writeJob (patch) {
  const j = { ...readJob(), ...patch, updatedAt: new Date().toISOString() }
  const tmp = `${JOB_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n')
  fs.renameSync(tmp, JOB_FILE)
  return j
}
function fail (error) {
  const message = String(error?.stack || error?.message || error)
  console.error(message)
  try { writeJob({ status: 'error', phase: 'error', detail: 'Combined Refresh specs failed', error: message }) } catch {}
  process.exitCode = 1
}
function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function slug (value, max = 96) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'combined-codepaths'
}
function safeSegment (value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '_') || '_'
}
function combinedIdentity (job) {
  const namespaces = job.projects.map(p => String(p.namespace || '')).filter(Boolean)
  const split = namespaces.map(ns => ns.split('/'))
  const owners = [...new Set(split.map(parts => parts.length > 1 ? parts[0] : 'combined'))]
  const owner = owners.length === 1 ? slug(owners[0], 40) : 'combined'
  const repoParts = split.map(parts => parts.length > 1 ? parts.slice(1).join('-') : parts[0]).filter(Boolean)
  const requested = slug(job.alias || '', 80)
  const repo = requested || slug(repoParts.join('-'), 80)
  return { namespace: `${owner}/${repo}`, workspaceName: `${owner}--${repo}` }
}
function shouldSkip (rel) {
  const unix = String(rel).split(path.sep).join('/')
  const base = path.posix.basename(unix).toLowerCase()
  if (base === '.env' || base.startsWith('.env.')) return true
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true
  if (/(?:^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$|\/)/i.test(unix)) return true
  return false
}
function git (cwd, args, options = {}) {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: options.stdio || ['ignore', 'pipe', 'pipe'], ...options })
}
function sourceFiles (sourcePath) {
  try {
    const out = execFileSync('/usr/bin/git', ['-C', sourcePath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'buffer' })
    return out.toString('utf8').split('\0').filter(Boolean)
  } catch (error) {
    throw new Error(`Code path is not a readable Git working tree: ${sourcePath}\n${String(error.stderr || error.message || error)}`)
  }
}
function copyCurrentCode (project, destRoot) {
  const files = sourceFiles(project.sourcePath)
  let copied = 0
  for (const rel of files) {
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..') || shouldSkip(rel)) continue
    const source = path.join(project.sourcePath, rel)
    const dest = path.join(destRoot, rel)
    let st
    try { st = fs.lstatSync(source) } catch { continue }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(source)
      try { fs.symlinkSync(target, dest) } catch {}
      copied++
    } else if (st.isFile()) {
      fs.copyFileSync(source, dest)
      try { fs.chmodSync(dest, st.mode & 0o777) } catch {}
      copied++
    }
  }
  return copied
}
function buildCombinedWorkspace (job) {
  const identity = combinedIdentity(job)
  const workspace = path.join(COMBINED_ROOT, identity.workspaceName)
  fs.mkdirSync(COMBINED_ROOT, { recursive: true })
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })

  let totalFiles = 0
  const sourceSummary = []
  for (let i = 0; i < job.projects.length; i++) {
    const project = job.projects[i]
    const parts = String(project.namespace || `project-${i + 1}`).split('/')
    const folder = safeSegment(parts.length > 1 ? parts.slice(1).join('-') : parts[0])
    const dest = path.join(workspace, folder)
    fs.mkdirSync(dest, { recursive: true })
    const copied = copyCurrentCode(project, dest)
    if (!copied) throw new Error(`No code files found in ${project.sourcePath}`)
    totalFiles += copied
    sourceSummary.push(`${project.namespace}: ${copied} files`)
  }

  execFileSync('/usr/bin/git', ['init', '-q', workspace])
  git(workspace, ['config', 'user.name', 'SpecDoc Combined Refresh'])
  git(workspace, ['config', 'user.email', 'specdoc@localhost'])
  git(workspace, ['add', '-A'])
  git(workspace, ['commit', '-q', '--no-gpg-sign', '-m', 'Combined codebase snapshot'])
  git(workspace, ['remote', 'add', 'origin', `https://github.com/${identity.namespace}.git`])

  return { ...identity, workspace, totalFiles, sourceSummary }
}
function request (url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(u, { method: options.method || 'GET', headers: options.headers || {} }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}
async function startSingleRefresh (combined) {
  const body = new URLSearchParams({ path: combined.workspace }).toString()
  const response = await request(`${BOARD_URL}/refresh-specdoc`, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  })
  let data = {}
  try { data = JSON.parse(response.body || '{}') } catch {}
  if (response.status < 200 || response.status >= 300) throw new Error(data.error || `POST /refresh-specdoc returned HTTP ${response.status}`)
  return data
}
async function waitForRefresh (combined, startData) {
  const deadline = Date.now() + 6 * 60 * 60 * 1000
  for (;;) {
    if (Date.now() > deadline) throw new Error('Standard Refresh specs exceeded 6 hours')
    await sleep(3000)
    const response = await request(`${BOARD_URL}/refresh-status`)
    if (response.status !== 200) throw new Error(`/refresh-status returned HTTP ${response.status}`)
    const state = JSON.parse(response.body || '{}')
    const sameRun = !state.source || path.resolve(String(state.source)) === path.resolve(combined.workspace) || (startData.pid && Number(state.pid) === Number(startData.pid))

    if (state.status === 'running') {
      if (!sameRun) throw new Error(`Another Refresh specs run is active: ${state.source || state.pid || 'unknown'}`)
      writeJob({
        status: 'running',
        phase: 'refresh',
        progress: Number(state.progress || 0),
        detail: `ONE Standard Refresh specs run · ${state.phase || 'running'} · ${state.progress || 0}%\n${combined.sourceSummary.join('\n')}`,
        refreshPid: state.pid || startData.pid || null,
        combinedSourcePath: combined.workspace,
        combinedNamespace: combined.namespace
      })
      continue
    }
    if (state.status === 'complete' && sameRun) return state
    if (state.status === 'failed' && sameRun) throw new Error(`Standard Refresh specs failed with exit ${state.exitCode}`)
  }
}

async function main () {
  try {
    const job = readJob()
    writeJob({ status: 'running', phase: 'staging', progress: 1, detail: `Building one combined codebase from ${job.projects.length} selected paths. Existing specification Markdown is not read or merged.` })
    const combined = buildCombinedWorkspace(job)
    writeJob({
      status: 'running', phase: 'staging', progress: 3,
      combinedSourcePath: combined.workspace,
      combinedNamespace: combined.namespace,
      detail: `Combined ${combined.totalFiles} current code files from ${job.projects.length} paths. Starting ONE standard Refresh specs run.\n${combined.sourceSummary.join('\n')}`
    })
    const started = await startSingleRefresh(combined)
    await waitForRefresh(combined, started)
    writeJob({
      status: 'done', progress: 100, phase: 'done',
      detail: `DONE — 100% ONE Standard Refresh specs run completed for ${job.projects.length} code paths. One combined specification set was generated directly from the combined codebase; existing specification Markdown was not used.`,
      url: `/?ns=${encodeURIComponent(combined.namespace)}`,
      combinedSourcePath: combined.workspace,
      combinedNamespace: combined.namespace,
      completedAt: new Date().toISOString()
    })
    console.log('SINGLE_REFRESH_MULTI_CODEPATHS_COMPLETE')
  } catch (error) {
    fail(error)
  }
}

main()
