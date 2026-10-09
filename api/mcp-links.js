import crypto from 'node:crypto'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 26
const clean = value => String(value || '').toUpperCase().replace(/[-\s]/g, '')
export const hashMcpLinkCode = value => crypto.createHash('sha256').update('opengym-mcp-link:' + clean(value)).digest('hex')

export function makeMcpLinkCode() {
  const chars = Array.from(crypto.randomBytes(CODE_LENGTH), b => ALPHABET[b % ALPHABET.length]).join('')
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}-${chars.slice(15, 20)}-${chars.slice(20)}`
}

function prune(db, now) { db.mcpLinks = (db.mcpLinks || []).filter(x => x && typeof x.h === 'string' && x.exp > now) }
function create(db, userId, now = Date.now()) {
  prune(db, now)
  db.mcpLinks = db.mcpLinks.filter(x => x.userId !== userId)
  const code = makeMcpLinkCode()
  const link = { h: hashMcpLinkCode(code), userId, created: now, exp: now + 5 * 60_000 }
  db.mcpLinks.push(link)
  return { code, link }
}
function take(db, code, now = Date.now()) {
  prune(db, now)
  const target = Buffer.from(hashMcpLinkCode(code), 'hex')
  if (clean(code).length !== CODE_LENGTH) return null
  const found = db.mcpLinks.find(x => {
    const stored = Buffer.from(x.h, 'hex')
    return stored.length === target.length && crypto.timingSafeEqual(stored, target)
  })
  if (!found) return null
  db.mcpLinks = db.mcpLinks.filter(x => x !== found)
  return found
}

async function callInternalMcp(req, pathname, { method = 'GET', body } = {}) {
  const base = String(process.env.MCP_INTERNAL_URL || '').replace(/\/+$/, '')
  const secretFile = process.env.MCP_SERVICE_TOKEN_FILE
  if (!base || !secretFile) return null
  let token
  try { token = (await import('node:fs')).readFileSync(secretFile, 'utf8').trim() }
  catch { throw Object.assign(new Error('MCP service is unavailable'), { status: 502 }) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(base + pathname, {
      method, signal: controller.signal,
      headers: {
        'X-OpenGym-Service-Token': token,
        'X-OpenGym-Profile': req.account.id,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    let data = null
    try { data = await response.json() } catch { /* opaque internal response */ }
    if (!response.ok) throw Object.assign(new Error('MCP service is unavailable'), { status: 502 })
    return data
  } catch (e) {
    if (e.status) throw e
    throw Object.assign(new Error('MCP service is unavailable'), { status: 502 })
  } finally { clearTimeout(timer) }
}

export function mcpLinkRoutes({ json, readBody, readSession, proveOwner, audit, db, saveDb, addressPaused, strikeAddress }) {
  return {
    'POST /api/account/mcp-link': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const body = await readBody(req)
      const proof = await proveOwner(req, res, user, body, 'mcp-link')
      if (!proof) return
      if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' })
      const { code, link } = create(db, user.id)
      saveDb()
      audit(req, 'mcp.link.create', { user, msg: proof })
      json(res, 200, { code, expires: link.exp })
    },

    'POST /api/internal/mcp/link-code/redeem': async (req, res) => {
      if (!req.service || req.service.user) return json(res, 401, { error: 'invalid service credentials' });
      const body = await readBody(req, 4096)
      if (Object.keys(body).some(k => k !== 'code') || typeof body.code !== 'string') return json(res, 400, { error: 'invalid request' })
      if (addressPaused(req, res, 'mcp-link')) return
      const link = take(db, body.code)
      const user = link && db.users.find(x => x.id === link.userId && !x.disabled)
      if (!link || !user) {
        strikeAddress(req, 'mcp-link')
        audit(req, 'mcp.link.redeem', { ok: false, msg: 'invalid' })
        return json(res, 404, { error: 'invalid or expired link code' })
      }
      saveDb()
      audit(req, 'mcp.link.redeem', { user })
      json(res, 200, { profile_id: user.id })
    },

    'GET /api/account/mcp-apps': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      req.account = user
      try {
        const result = await callInternalMcp(req, '/internal/connections?profile_id=' + encodeURIComponent(user.id))
        if (!result) return json(res, 404, { error: 'MCP is not configured' })
        json(res, 200, { apps: Array.isArray(result.apps) ? result.apps : [] })
      } catch (e) { json(res, e.status || 502, { error: 'MCP service is unavailable' }) }
    },

    'POST /api/account/mcp-apps/revoke': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const body = await readBody(req, 4096)
      if (Object.keys(body).some(k => !['client_id', 'all'].includes(k)) ||
          (body.all !== true && (typeof body.client_id !== 'string' || !body.client_id || body.client_id.length > 100))) {
        return json(res, 400, { error: 'invalid request' })
      }
      req.account = user
      try {
        const result = await callInternalMcp(req, '/internal/revoke', { method: 'POST', body: { ...(body.all === true ? { all: true } : { client_id: body.client_id }) } })
        if (!result) return json(res, 404, { error: 'MCP is not configured' })
        audit(req, 'mcp.app.revoke', { user, msg: body.all ? 'all' : 'client' })
        json(res, 200, { ok: true })
      } catch (e) { json(res, e.status || 502, { error: 'MCP service is unavailable' }) }
    }
  }
}
