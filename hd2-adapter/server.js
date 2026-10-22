#!/usr/bin/env node
'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')

const ENV_FILE = process.env.HD2_ENV_FILE || '/data/projects/hedgedoc/.env'

function loadEnvFile (file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!m) continue
      if (process.env[m[1]] != null) continue
      let value = m[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      process.env[m[1]] = value
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

loadEnvFile(ENV_FILE)

const HD2_URL = String(process.env.HD2_URL || process.env.HD_BASE_URL || '').replace(/\/$/, '')
const HD2_TOKEN = process.env.HD2_TOKEN || ''
const HOST = process.env.SPECDOC_HD2_HOST || '127.0.0.1'
const PORT = Number(process.env.SPECDOC_HD2_PORT || 8081)
const NAMESPACE = process.env.SPECDOC_HD2_NAMESPACE || 'local/specs'
const CACHE_SECONDS = Math.max(1, Number(process.env.SPECDOC_HD2_CACHE_SECONDS || 15))
const STATUSES = ['draft', 'ready-for-review', 'in-review', 'approved', 'implemented']

if (!HD2_URL) throw new Error(`HD2_URL or HD_BASE_URL is required (env file: ${ENV_FILE})`)
if (!HD2_TOKEN) throw new Error(`HD2_TOKEN is required (env file: ${ENV_FILE})`)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('SPECDOC_HD2_PORT must be 1..65535')

let cache = { expires: 0, at: null, notes: [] }

function bearerHeaders () {
  return {
    authorization: `Bearer ${HD2_TOKEN}`,
    accept: 'application/json'
  }
}

async function hdFetchJson (pathname) {
  const res = await fetch(`${HD2_URL}${pathname}`, {
    headers: bearerHeaders(),
    signal: AbortSignal.timeout(10000)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${pathname}: HedgeDoc HTTP ${res.status}${text ? `: ${text.slice(0, 240)}` : ''}`)
  return text ? JSON.parse(text) : null
}

async function hdWriteMarkdown (pathname, content) {
  const res = await fetch(`${HD2_URL}${pathname}`, {
    method: 'PUT',
    headers: {
      ...bearerHeaders(),
      'content-type': 'text/markdown'
    },
    body: content,
    signal: AbortSignal.timeout(10000)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${pathname}: HedgeDoc HTTP ${res.status}${text ? `: ${text.slice(0, 240)}` : ''}`)
}

function replacementSpan (content, oldText) {
  const exact = []
  let from = 0

  while (true) {
    const i = content.indexOf(oldText, from)
    if (i < 0) break
    exact.push({ start: i, end: i + oldText.length })
    from = i + Math.max(1, oldText.length)
  }

  if (exact.length === 1) return exact[0]
  if (exact.length > 1) throw new Error('old_text is ambiguous')

  const parts = oldText.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) throw new Error('old_text is required')

  const escaped = parts.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(escaped.join('\\s+'), 'g')
  const matches = [...content.matchAll(re)]

  if (matches.length === 0) throw new Error('old_text not found')
  if (matches.length > 1) throw new Error('old_text is ambiguous')

  return {
    start: matches[0].index,
    end: matches[0].index + matches[0][0].length
  }
}

async function readJsonBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32768) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function normalizeTags (tags) {
  if (!Array.isArray(tags)) return []
  return tags.map(x => String(x).trim().toLowerCase()).filter(Boolean)
}

function statusFromTags (tags) {
  let best = 'draft'
  let bestIdx = 0
  for (const t of tags) {
    const idx = STATUSES.indexOf(t)
    if (idx > bestIdx) {
      best = t
      bestIdx = idx
    }
  }
  return best
}

function primaryAlias (metadata) {
  return metadata.primaryAlias || (Array.isArray(metadata.aliases) && metadata.aliases[0]) || null
}

function projectForAlias (alias) {
  try {
    const registry = JSON.parse(
      require('fs').readFileSync('/data/projects/specdoc/projects/registry.json', 'utf8')
    )
    const projects = Object.entries(registry.projects || {})
      .sort(([, a], [, b]) =>
        String(b.aliasPrefix || '').length - String(a.aliasPrefix || '').length
      )

    for (const [namespace, project] of projects) {
      const prefix = String(project.aliasPrefix || '')
      if (prefix && alias.startsWith(`${prefix}-`)) {
        return {
          namespace,
          displayName: project.displayName || project.projectName || namespace
        }
      }
    }
  } catch {}
  return { namespace: NAMESPACE, displayName: NAMESPACE }
}

function noteSummary (metadata) {
  const tags = normalizeTags(metadata.tags)
  const id = primaryAlias(metadata)
  if (!id || !tags.includes('spec')) return null
  const project = projectForAlias(id)
  return {
    id,
    urlId: id,
    alias: id,
    title: String(metadata.title || id),
    url: `${HD2_URL}/n/${encodeURIComponent(id)}`,
    status: statusFromTags(tags),
    area: '',
    kind: 'feature',
    namespace: project.namespace,
    projectName: project.displayName,
    tags,
    author: String(metadata.permissions?.owner || metadata.lastUpdatedBy || ''),
    changed: metadata.updatedAt || null,
    comments: 0,
    suggestions: 0,
    pr: null,
    prState: null,
    specPath: null,
    superseded: false,
    publiclyVisible: metadata.permissions?.publiclyVisible === true,
    abstract: String(metadata.description || ''),
    dependsOn: [],
    supersedes: null
  }
}

async function loadNotes () {
  if (Date.now() < cache.expires) return cache
  const owned = await hdFetchJson('/api/v2/me/notes')
  if (!Array.isArray(owned)) throw new Error('/api/v2/me/notes did not return an array')
  const summaries = owned.map(noteSummary).filter(Boolean)
  const notes = await Promise.all(summaries.map(async summary => {
    const raw = await hdFetchJson(`/api/v2/notes/${encodeURIComponent(summary.id)}`)
    return { ...summary, ...criticCounts(raw && raw.content) }
  }))
  const at = new Date().toISOString()
  cache = { expires: Date.now() + CACHE_SECONDS * 1000, at, notes }
  return cache
}

function parseFrontmatter (text) {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const m = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const kv = /^([^:]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].trim()
    let value = kv[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else {
      value = value.replace(/^['"]|['"]$/g, '')
    }
    meta[key] = value
  }
  return { meta, body: m[2].replace(/^\s+/, '') }
}

function criticCounts (text) {
  text = String(text || '')
  const reviewComments = [...text.matchAll(/\{>>([\s\S]*?)<<\}/g)]
    .map((match, index) => ({
      id: index + 1,
      text: String(match[1] || '').trim()
    }))
    .filter(comment => comment.text)

  return {
    comments: reviewComments.length,
    reviewComments,
    suggestions: (text.match(/\{~~[\s\S]*?~>[\s\S]*?~~\}/g) || []).length
  }
}

function specRefs (value) {
  if (value == null || value === '') return []
  const items = Array.isArray(value) ? value : String(value).split(',')
  return items.map(v => String(v).trim()).filter(Boolean)
}

async function loadOne (id) {
  const raw = await hdFetchJson(`/api/v2/notes/${encodeURIComponent(id)}`)
  if (!raw || typeof raw.content !== 'string' || !raw.metadata) throw new Error(`note ${id}: malformed HedgeDoc response`)
  const summary = noteSummary(raw.metadata)
  if (!summary) return null
  const { meta, body } = parseFrontmatter(raw.content)
  Object.assign(summary, criticCounts(raw.content))
  summary.area = String(meta.area || '').trim().toLowerCase()
  summary.kind = String(meta.kind || '').trim().toLowerCase() === 'top-level' ? 'top-level' : 'feature'
  summary.dependsOn = specRefs(meta['depends-on'] || meta.dependsOn)
  summary.supersedes = specRefs(meta.supersedes)[0] || null
  summary.abstract = summary.abstract || body.split(/\n\s*\n/).map(x => x.trim()).find(Boolean)?.replace(/^#+\s*/, '') || ''
  return { ...summary, body }
}

function sendJson (res, status, body, extra = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `private, max-age=${CACHE_SECONDS}`,
    'content-length': Buffer.byteLength(text),
    ...extra
  })
  res.end(text)
}

function sendText (res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`)
    const updateRoute = /^\/api\/specs\/([^/]+)\/update$/.exec(u.pathname)

    if (req.method === 'POST' && updateRoute) {
      const id = decodeURIComponent(updateRoute[1])
      const input = await readJsonBody(req)
      const oldText = String(input.old_text || '')
      const newText = String(input.new_text || '')

      if (!oldText) return sendJson(res, 400, { error: 'old_text is required' })
      if (oldText === newText) return sendJson(res, 400, { error: 'old_text and new_text are identical' })
      if (oldText.length > 20000 || newText.length > 20000) {
        return sendJson(res, 400, { error: 'replacement too large' })
      }

      const raw = await hdFetchJson(`/api/v2/notes/${encodeURIComponent(id)}`)
      if (!raw || typeof raw.content !== 'string' || !raw.metadata) {
        return sendJson(res, 404, { error: 'spec not found' })
      }
      if (!noteSummary(raw.metadata)) {
        return sendJson(res, 404, { error: 'note is not a spec' })
      }

      let span
      try {
        span = replacementSpan(raw.content, oldText)
      } catch (e) {
        return sendJson(res, 409, { error: e.message })
      }

      const content =
        raw.content.slice(0, span.start) +
        newText +
        raw.content.slice(span.end)

      await hdWriteMarkdown(`/api/v2/notes/${encodeURIComponent(id)}`, content)
      cache.expires = 0

      return sendJson(res, 200, { ok: true, id })
    }

    const replaceRoute = /^\/api\/specs\/([^/]+)\/replace$/.exec(u.pathname)

    if (req.method === 'POST' && replaceRoute) {
      const id = decodeURIComponent(replaceRoute[1])
      const input = await readJsonBody(req)
      const body = String(input.content ?? '').trim()

      if (!body) return sendJson(res, 400, { error: 'content is required' })
      if (body.length > 100000) {
        return sendJson(res, 400, { error: 'content too large' })
      }

      const raw = await hdFetchJson(`/api/v2/notes/${encodeURIComponent(id)}`)
      if (!raw || typeof raw.content !== 'string' || !raw.metadata) {
        return sendJson(res, 404, { error: 'spec not found' })
      }
      if (!noteSummary(raw.metadata)) {
        return sendJson(res, 404, { error: 'note is not a spec' })
      }

      // Preserve the existing YAML frontmatter so tags, lifecycle metadata,
      // dependencies, etc. are not lost during a full specification rewrite.
      const fm = /^(---\s*\n[\s\S]*?\n---\s*(?:\n|$))/.exec(raw.content)

      const content = fm
        ? `${fm[1].replace(/\s+$/, '')}\n\n${body}\n`
        : `${body}\n`

      await hdWriteMarkdown(`/api/v2/notes/${encodeURIComponent(id)}`, content)
      cache.expires = 0

      return sendJson(res, 200, { ok: true, id })
    }

    const commentRoute = /^\/api\/specs\/([^/]+)\/comments$/.exec(u.pathname)

    if (req.method === 'POST' && commentRoute) {
      const id = decodeURIComponent(commentRoute[1])
      const input = await readJsonBody(req)
      const comment = String(input.comment || '').trim().replace(/\s+/g, ' ')
      const anchor = String(input.anchor || '')

      if (!comment) return sendJson(res, 400, { error: 'comment is required' })
      if (comment.length > 4000) return sendJson(res, 400, { error: 'comment too long' })
      if (comment.includes('{>>') || comment.includes('<<}')) {
        return sendJson(res, 400, { error: 'comment contains CriticMarkup delimiters' })
      }

      const raw = await hdFetchJson(`/api/v2/notes/${encodeURIComponent(id)}`)
      if (!raw || typeof raw.content !== 'string' || !raw.metadata) {
        return sendJson(res, 404, { error: 'spec not found' })
      }
      if (!noteSummary(raw.metadata)) {
        return sendJson(res, 404, { error: 'note is not a spec' })
      }

      const marker = `{>>@hermes: ${comment}<<}`
      let content = raw.content

      if (anchor) {
        const first = content.indexOf(anchor)
        if (first < 0) return sendJson(res, 409, { error: 'anchor not found' })
        if (content.indexOf(anchor, first + anchor.length) >= 0) {
          return sendJson(res, 409, { error: 'anchor is ambiguous' })
        }
        const pos = first + anchor.length
        content = `${content.slice(0, pos)}\n${marker}${content.slice(pos)}`
      } else {
        content = `${content.replace(/\s+$/, '')}\n\n${marker}\n`
      }

      await hdWriteMarkdown(`/api/v2/notes/${encodeURIComponent(id)}`, content)
      cache.expires = 0
      return sendJson(res, 201, { ok: true, id, marker })
    }

    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })
    }

    if (u.pathname === '/statusz') {
      const c = await loadNotes()
      return sendJson(res, 200, { ok: true, source: HD2_URL, specs: c.notes.length, at: c.at })
    }

    const specRoute = /^\/api\/specs\/([^/]+)$/.exec(u.pathname)
    if (specRoute) {
      const id = decodeURIComponent(specRoute[1])
      const spec = await loadOne(id)
      if (!spec) return sendJson(res, 404, { error: 'spec not found' })
      return sendJson(res, 200, spec)
    }

    if (u.pathname === '/api/specs') {
      const c = await loadNotes()
      const ns = u.searchParams.get('ns')
      const status = u.searchParams.get('status')
      let specs = c.notes
      if (ns) specs = specs.filter(s => s.namespace === ns)
      if (status) specs = specs.filter(s => s.status === status)
      if (u.searchParams.get('public') === 'true') specs = specs.filter(s => s.publiclyVisible === true)
      return sendJson(res, 200, { specs, next: null, at: c.at, stale: false })
    }

    const m = /^\/api\/specs\/([^/]+)$/.exec(u.pathname)
    if (m) {
      const id = decodeURIComponent(m[1])
      const spec = await loadOne(id)
      if (!spec) return sendJson(res, 404, { error: 'spec not found' })
      if ((req.headers.accept || '').includes('text/markdown')) return sendText(res, 200, spec.body)
      return sendJson(res, 200, spec)
    }

    return sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    console.error(e)
    return sendJson(res, 502, { error: e.message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`SpecDoc HedgeDoc 2 adapter listening on http://${HOST}:${PORT}`)
  console.log(`HedgeDoc source: ${HD2_URL}`)
  console.log(`Environment: ${ENV_FILE}`)
})
