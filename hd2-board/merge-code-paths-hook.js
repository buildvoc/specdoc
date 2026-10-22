'use strict'

/*
 * SpecDoc Board — Refresh + merge code paths.
 *
 * Select 2+ registered sourcePath projects under /data/projects. A detached
 * worker invokes the Board's existing standard "Refresh specs" form for each
 * selected project, sequentially, then merges only specification outputs written by those refresh runs.
 * Pre-refresh specification files are never accepted as input by the worker.
 * Standard Refresh specs remains the only code->spec generation path.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const crypto = require('crypto')

const ROOT = process.env.SPECDOC_ROOT || '/data/projects/specdoc'
const BOARD = path.join(ROOT, 'hd2-board')
const REGISTRY_FILE = process.env.SPECDOC_PROJECT_REGISTRY || path.join(ROOT, 'projects', 'registry.json')
const SOURCE_ROOT = path.resolve(process.env.SPECDOC_SOURCE_ROOT || '/data/projects')
const SPECS_ROOT = path.resolve(process.env.SPECDOC_SPECIFICATIONS_ROOT || path.join(ROOT, 'specifications'))
const DATA_DIR = path.join(BOARD, 'data', 'merge-code-paths')
const WORKER = path.join(BOARD, 'merge-code-paths-worker.js')
const DEFAULT_MODEL = process.env.SPECDOC_MERGE_MODEL || 'gemma4:26b'

fs.mkdirSync(DATA_DIR, { recursive: true })

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson (res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function inside (parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function registryProjects () {
  return readJson(REGISTRY_FILE, { projects: {} }).projects || {}
}

function catalog () {
  const projects = []
  for (const [namespace, project] of Object.entries(registryProjects())) {
    const sourceRaw = String(project.sourcePath || '').trim()
    const outputRaw = String(project.outputDir || '').trim()
    if (!sourceRaw || !outputRaw) continue

    const sourcePath = path.resolve(sourceRaw)
    const outputDir = path.resolve(outputRaw)
    const sourceSafe = inside(SOURCE_ROOT, sourcePath)
    const outputSafe = inside(SPECS_ROOT, outputDir)
    if (!sourceSafe || !outputSafe) continue

    projects.push({
      namespace,
      displayName: project.displayName || project.projectName || namespace,
      sourcePath,
      outputDir,
      sourceAvailable: fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()
    })
  }
  projects.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return { projects, defaultModel: DEFAULT_MODEL }
}

function jobFile (id) { return path.join(DATA_DIR, `${id}.json`) }

function activeJobs () {
  const out = []
  let names = []
  try { names = fs.readdirSync(DATA_DIR) } catch {}
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const j = readJson(path.join(DATA_DIR, name), null)
    if (j && j.status === 'running') out.push(j)
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

function recentJobs () {
  const out = []
  let names = []
  try { names = fs.readdirSync(DATA_DIR) } catch {}
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const j = readJson(path.join(DATA_DIR, name), null)
    if (j) out.push(j)
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20)
}

async function bodyJson (req, max = 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', chunk => {
      total += chunk.length
      if (total > max) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })) }
    })
    req.on('error', reject)
  })
}

function validateSelection (namespaces) {
  if (!Array.isArray(namespaces)) throw Object.assign(new Error('projects must be an array'), { statusCode: 400 })
  const unique = [...new Set(namespaces.map(x => String(x || '').trim()).filter(Boolean))]
  if (unique.length < 2) throw Object.assign(new Error('Select at least two code paths/projects'), { statusCode: 400 })

  const registry = registryProjects()
  const selected = []
  for (const namespace of unique) {
    const project = registry[namespace]
    if (!project) throw Object.assign(new Error(`Unknown project: ${namespace}`), { statusCode: 400 })
    const sourcePath = path.resolve(String(project.sourcePath || ''))
    const outputDir = path.resolve(String(project.outputDir || ''))
    if (!inside(SOURCE_ROOT, sourcePath)) throw Object.assign(new Error(`Unsafe sourcePath: ${sourcePath}`), { statusCode: 400 })
    if (!inside(SPECS_ROOT, outputDir)) throw Object.assign(new Error(`Unsafe outputDir: ${outputDir}`), { statusCode: 400 })
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) throw Object.assign(new Error(`Missing sourcePath: ${sourcePath}`), { statusCode: 400 })
    selected.push({ namespace, sourcePath, outputDir })
  }
  return selected
}

function createJob (request, selected) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
  const job = {
    id,
    status: 'running',
    progress: 0,
    phase: 'queued',
    detail: 'Queued standard Refresh specs workflow',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: String(request.title || '').trim() || `Merged Specification — ${selected.length} Code Paths`,
    alias: String(request.alias || '').trim(),
    model: String(request.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    projectCount: selected.length,
    projects: selected.map(x => ({ namespace: x.namespace, sourcePath: x.sourcePath, outputDir: x.outputDir }))
  }
  fs.writeFileSync(jobFile(id), JSON.stringify(job, null, 2) + '\n')
  return job
}

function startWorker (job) {
  const log = path.join(DATA_DIR, `${job.id}.log`)
  const fd = fs.openSync(log, 'a')
  const child = spawn(process.execPath, [WORKER, jobFile(job.id)], {
    cwd: BOARD,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, SPECDOC_ROOT: ROOT }
  })
  child.unref()
  fs.closeSync(fd)
}

async function handleApi (req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/merge-code-paths/catalog') {
    return writeJson(res, 200, catalog())
  }

  if (req.method === 'GET' && url.pathname === '/api/merge-code-paths/jobs') {
    const active = activeJobs()[0] || null
    return writeJson(res, 200, { active, history: recentJobs() })
  }

  const m = url.pathname.match(/^\/api\/merge-code-paths\/jobs\/([^/]+)$/)
  if (req.method === 'GET' && m) {
    const id = decodeURIComponent(m[1])
    const j = readJson(jobFile(id), null)
    if (!j) return writeJson(res, 404, { error: 'Job not found' })
    return writeJson(res, 200, j)
  }

  if (req.method === 'POST' && url.pathname === '/api/merge-code-paths') {
    const running = activeJobs()
    if (running.length) return writeJson(res, 409, { error: `A Refresh + merge job is already running: ${running[0].id}` })

    const request = await bodyJson(req)
    const selected = validateSelection(request.projects)
    const job = createJob(request, selected)
    startWorker(job)
    return writeJson(res, 202, job)
  }

  return false
}

const UI_FILE = path.join(BOARD, 'merge-code-paths-ui.html')
function uiHtml () {
  try { return fs.readFileSync(UI_FILE, 'utf8') } catch { return '' }
}
function injectUi (html) {
  if (typeof html !== 'string' || html.includes('id="specdoc-merge-code-paths-dialog"')) return html
  const pos = html.lastIndexOf('</body>')
  if (pos < 0) return html
  return html.slice(0, pos) + uiHtml() + html.slice(pos)
}

const originalCreateServer = http.createServer
http.createServer = function patchedCreateServer (...args) {
  let index = -1
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') { index = i; break }
  }
  if (index < 0) return originalCreateServer.apply(this, args)

  const originalListener = args[index]
  args[index] = function mergeCodePathsAwareListener (req, res) {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { url = { pathname: req.url || '/' } }

    if (String(url.pathname).startsWith('/api/merge-code-paths')) {
      Promise.resolve(handleApi(req, res, url)).then(handled => {
        if (handled === false && !res.writableEnded) originalListener(req, res)
      }).catch(error => {
        if (!res.writableEnded) writeJson(res, error.statusCode || 500, { error: String(error?.message || error) })
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const originalEnd = res.end
      res.end = function patchedEnd (chunk, encoding, callback) {
        try {
          if (chunk != null) {
            const isBuffer = Buffer.isBuffer(chunk)
            const text = isBuffer ? chunk.toString(encoding || 'utf8') : String(chunk)
            const changed = injectUi(text)
            if (changed !== text) {
              chunk = isBuffer ? Buffer.from(changed, encoding || 'utf8') : changed
              if (!res.headersSent) res.removeHeader('Content-Length')
            }
          }
        } catch (error) {
          console.error('[merge-code-paths-hook] UI injection failed:', error)
        }
        return originalEnd.call(this, chunk, encoding, callback)
      }
    }

    return originalListener(req, res)
  }
  return originalCreateServer.apply(this, args)
}

console.log(`[merge-code-paths-hook] enabled; standard Refresh specs orchestration; default model=${DEFAULT_MODEL}`)
