#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import express from 'express'
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { apiCall } from './api-client.js'
import { createOAuthStore } from './oauth/store.js'
import { createOAuthProvider, SUPPORTED_SCOPES } from './oauth/provider.js'
import { createClientsStore } from './oauth/clients-store.js'
import { mountConsentRoute } from './oauth/consent.js'
import { buildMcpServer } from './mcp-server.js'
import { runRequestContext } from './request-context.js'

process.env.MCP_MODE = 'http'
const PORT = Number(process.env.PORT || 3001)
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 3002)
const TRUST_PROXY_HOPS = Math.max(0, Math.min(5, Number(process.env.TRUST_PROXY_HOPS) || 0))
const base = new URL(process.env.PUBLIC_BASE_URL || '')
if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
  throw new Error('PUBLIC_BASE_URL must be an origin without path, query or fragment')
}
if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS in production')
const PUBLIC_BASE_URL = base.origin
const RESOURCE_URL = new URL('/mcp', PUBLIC_BASE_URL)
const METADATA_URL = getOAuthProtectedResourceMetadataUrl(RESOURCE_URL)
const allowedOrigins = new Set([base.origin, ...(process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)])
const serviceTokenFile = process.env.MCP_SERVICE_TOKEN_FILE
if (!serviceTokenFile) throw new Error('MCP_SERVICE_TOKEN_FILE is required in HTTP mode')
const serviceSecret = fs.readFileSync(serviceTokenFile, 'utf8').trim()
if (Buffer.byteLength(serviceSecret) < 32) throw new Error('MCP_SERVICE_TOKEN_FILE must hold at least 32 bytes')
const tokenDigest = crypto.createHash('sha256').update(serviceSecret).digest()
const log = (event, clientId, outcome) => console.log(JSON.stringify({ event, client_id: clientId || null, outcome }))
const state = createOAuthStore()
const clientsStore = createClientsStore(state, log)
const provider = createOAuthProvider({ store: state, clientsStore, baseUrl: PUBLIC_BASE_URL, resourceUrl: RESOURCE_URL.href, log })
const oauthMetadata = createOAuthMetadata({ provider, issuerUrl: new URL(PUBLIC_BASE_URL), baseUrl: new URL(PUBLIC_BASE_URL), scopesSupported: SUPPORTED_SCOPES })
const prm = { resource: RESOURCE_URL.href, authorization_servers: [new URL(PUBLIC_BASE_URL).href], scopes_supported: SUPPORTED_SCOPES, resource_name: 'openGym' }

function security(app) {
  app.disable('x-powered-by')
  app.set('trust proxy', TRUST_PROXY_HOPS)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'no-store')
    const host = String(req.headers.host || '').toLowerCase()
    if (host !== base.host.toLowerCase()) return res.status(403).json({ error: 'host refused' })
    const origin = req.get('origin')
    if (origin) {
      let normalized
      try { normalized = new URL(origin).origin } catch { return res.status(403).json({ error: 'origin refused' }) }
      if (!allowedOrigins.has(normalized)) return res.status(403).json({ error: 'origin refused' })
      res.setHeader('Access-Control-Allow-Origin', normalized)
      res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Mcp-Session-Id,Mcp-Protocol-Version')
      return res.status(204).end()
    }
    next()
  })
}

const publicApp = express()
security(publicApp)
publicApp.use(express.json({ limit: '64kb', strict: true }))
publicApp.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 50 }))

publicApp.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(prm))
mountConsentRoute(publicApp, {
  store: state, baseUrl: PUBLIC_BASE_URL, issuerUrl: PUBLIC_BASE_URL,
  redeemLink: async code => {
    const result = await apiCall(null, '/api/internal/mcp/link-code/redeem', { method: 'POST', body: { code } })
    return result.profile_id
  },
  log
})

// Client secrets are stored only as hashes. The SDK's built-in comparison accepts a plaintext
// client_secret on getClient(), so this front middleware verifies it before the SDK router.
const verifyClientSecret = (req, res, next) => {
  const clientId = req.body?.client_id
  if (typeof clientId !== 'string') return res.status(400).json({ error: 'invalid_request' })
  const method = state.clientAuthMethod(clientId)
  if (!method) return res.status(400).json({ error: 'invalid_client' })
  if (method === 'none') return next()
  if (!state.clientSecretValid(clientId, req.body.client_secret)) return res.status(401).json({ error: 'invalid_client' })
  next()
}
publicApp.use(['/token', '/revoke'], verifyClientSecret)
publicApp.use(mcpAuthRouter({
  provider, issuerUrl: new URL(PUBLIC_BASE_URL), baseUrl: new URL(PUBLIC_BASE_URL),
  resourceServerUrl: RESOURCE_URL, scopesSupported: SUPPORTED_SCOPES, resourceName: 'openGym',
  clientRegistrationOptions: { rateLimit: { windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false } }
}))

const tokenLimits = new Map()
function allowToken(token) {
  const key = crypto.createHash('sha256').update(token).digest('hex')
  const now = Date.now()
  let budget = tokenLimits.get(key)
  if (!budget || now - budget.start >= 60_000) tokenLimits.set(key, budget = { start: now, count: 0 })
  budget.count++
  if (tokenLimits.size > 10000) for (const [k, v] of tokenLimits) if (now - v.start > 60_000) tokenLimits.delete(k)
  return budget.count <= 120
}
const bearer = requireBearerAuth({ verifier: provider, expectedResource: RESOURCE_URL, resourceMetadataUrl: METADATA_URL })
publicApp.post('/mcp', bearer, async (req, res) => {
  const auth = req.auth
  if (!allowToken(auth.token)) return res.status(429).set('Retry-After', '60').json({ error: 'too many requests' })
  const profileId = auth.extra?.profileId
  if (typeof profileId !== 'string') return res.status(401).json({ error: 'invalid token' })
  try {
    const data = auth.scopes.includes('opengym:read') ? await apiCall(profileId, '/api/data') : null
    const context = { profileId, profileName: profileId, scopes: auth.scopes, state: data?.state || null }
    await runRequestContext(context, async () => {
      const server = buildMcpServer(auth.scopes)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        transport.close().catch(() => {})
        server.close().catch(() => {})
      }
      res.once('close', close)
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    })
  } catch (error) {
    log('mcp.request', auth.clientId, 'failed')
    if (!res.headersSent) res.status(error.status || 503).json({ error: 'MCP request unavailable' })
  }
})
publicApp.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' }))
publicApp.use((_req, res) => res.status(404).json({ error: 'not found' }))

const internalApp = express()
internalApp.disable('x-powered-by')
internalApp.use(express.json({ limit: '8kb', strict: true }))
internalApp.get('/internal/health', (_req, res) => res.json({ ok: true }))
internalApp.use((req, res, next) => {
  const given = req.get('x-opengym-service-token') || ''
  const digest = crypto.createHash('sha256').update(given).digest()
  if (!crypto.timingSafeEqual(digest, tokenDigest)) return res.status(401).json({ error: 'unauthorized' })
  const profileId = req.get('x-opengym-profile')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profileId || '')) return res.status(401).json({ error: 'unauthorized' })
  req.profileId = profileId
  next()
})
internalApp.get('/internal/connections', (req, res) => {
  if (req.query.profile_id !== req.profileId) return res.status(403).json({ error: 'forbidden' })
  res.json({ apps: state.listConnections(req.profileId) })
})
internalApp.post('/internal/revoke', (req, res) => {
  if (Object.keys(req.body).some(k => !['client_id', 'all'].includes(k))) return res.status(400).json({ error: 'invalid request' })
  if (req.body.all === true) state.revokeProfile(req.profileId)
  else if (typeof req.body.client_id === 'string' && req.body.client_id.length <= 100) state.revokeClient(req.profileId, req.body.client_id)
  else return res.status(400).json({ error: 'invalid request' })
  res.json({ ok: true })
})
internalApp.use((_req, res) => res.status(404).json({ error: 'not found' }))

const publicServer = publicApp.listen(PORT, '0.0.0.0', () => log('mcp.http', null, 'listening'))
const internalServer = internalApp.listen(INTERNAL_PORT, '0.0.0.0', () => log('mcp.internal', null, 'listening'))
setInterval(() => { state.prune(); }, 60 * 60 * 1000).unref()
const stop = () => {
  publicServer.close()
  internalServer.close()
  state.close()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
