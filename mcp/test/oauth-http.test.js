import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { createOAuthStore } from '../src/oauth/store.js'
import { createOAuthProvider, SUPPORTED_SCOPES } from '../src/oauth/provider.js'
import { createClientsStore } from '../src/oauth/clients-store.js'
import { mountConsentRoute } from '../src/oauth/consent.js'

let dir, store, server, base, provider
const issuer = 'http://localhost'
const resource = 'http://localhost/mcp'
const redirect = 'https://client.example/callback'
const verifier = 'a'.repeat(43)
const challenge = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(b => Buffer.from(b).toString('base64url'))

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  server = null
  store?.close(); store = null
  if (dir) await import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true }))
  dir = null
})

async function start() {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'og-oauth-http-'))
  store = createOAuthStore({ stateDir: dir })
  const clients = createClientsStore(store, () => {})
  provider = createOAuthProvider({ store, clientsStore: clients, baseUrl: issuer, resourceUrl: resource, log: () => {} })
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  mountConsentRoute(app, { store, baseUrl: issuer, issuerUrl: issuer, redeemLink: async code => code === 'ONE-TIME-LINK' ? 'profile-a' : Promise.reject(new Error('invalid')), log: () => {} })
  app.use(mcpAuthRouter({
    provider, issuerUrl: new URL(issuer), baseUrl: new URL(issuer), resourceServerUrl: new URL(resource), scopesSupported: SUPPORTED_SCOPES,
    clientRegistrationOptions: { rateLimit: false }
  }))
  app.get('/protected', requireBearerAuth({ verifier: provider, expectedResource: new URL(resource), resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resource)) }), (req, res) => res.json({ scopes: req.auth.scopes }))
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  return { clients, metadata: createOAuthMetadata({ provider, issuerUrl: new URL(issuer), baseUrl: new URL(issuer), scopesSupported: SUPPORTED_SCOPES }) }
}

async function register() {
  const r = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    client_name: 'Test client', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
  }) })
  return { response: r, body: await r.json() }
}
async function authorize(clientId, query = {}) {
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'opengym:read', state: 'state-1', ...query
  })
  if (Object.hasOwn(query, 'resource') && query.resource === undefined) params.delete('resource')
  const response = await fetch(base + '/authorize?' + params, { redirect: 'manual' })
  const html = await response.text()
  const id = /name="id" value="([^"]+)"/.exec(html)?.[1]
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  return { response, html, id, csrf, cookie }
}
async function approve(consent, linkCode = 'ONE-TIME-LINK') {
  const response = await fetch(base + '/authorize/consent', {
    method: 'POST', redirect: 'manual',
    headers: { origin: issuer, 'sec-fetch-site': 'same-origin', cookie: consent.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: consent.id, csrf: consent.csrf, link_code: linkCode, decision: 'approve' })
  })
  return response
}

describe('MCP OAuth HTTP flow', () => {
  it('publishes authorization and protected-resource metadata', async () => {
    const { metadata } = await start()
    const as = await fetch(base + '/.well-known/oauth-authorization-server')
    const asBody = await as.json()
    expect(as.status).toBe(200)
    expect(asBody.code_challenge_methods_supported).toEqual(['S256'])
    expect(asBody.authorization_endpoint).toBe('http://localhost/authorize')
    expect(asBody.registration_endpoint).toBe('http://localhost/register')
    const protectedMeta = await fetch(base + '/.well-known/oauth-protected-resource/mcp').then(r => r.json())
    expect(protectedMeta.resource).toBe(resource)
    expect(metadata.scopes_supported).toEqual(SUPPORTED_SCOPES)
  })

  it('requires resource, uses consent + link redemption, verifies PKCE, and binds the access-token audience', async () => {
    await start()
    const registered = await register()
    expect(registered.response.status).toBe(201)
    const deniedTarget = await authorize(registered.body.client_id, { resource: undefined })
    expect(deniedTarget.response.status).toBe(302)
    expect(new URL(deniedTarget.response.headers.get('location')).searchParams.get('error')).toBe('invalid_target')

    const consent = await authorize(registered.body.client_id)
    expect(consent.response.status, consent.response.headers.get('location') || consent.html).toBe(200)
    expect(consent.html).toContain('Test client')
    expect(consent.html).toContain('client.example')
    const response = await approve(consent)
    expect(response.status).toBe(303)
    const code = new URL(response.headers.get('location')).searchParams.get('code')

    const wrong = await fetch(base + '/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.body.client_id, code, redirect_uri: redirect, code_verifier: 'b'.repeat(43), resource })
    })
    expect(wrong.status).toBe(400)
    expect((await wrong.json()).error).toBe('invalid_grant')

    const issued = await fetch(base + '/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.body.client_id, code, redirect_uri: redirect, code_verifier: verifier, resource })
    })
    expect(issued.status).toBe(200)
    const tokens = await issued.json()
    const accepted = await fetch(base + '/protected', { headers: { authorization: `Bearer ${tokens.access_token}` } })
    expect(accepted.status).toBe(200)
    const unauthorized = await fetch(base + '/protected')
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it('refuses insecure dynamic-client redirect URIs', async () => {
    await start()
    const response = await fetch(base + '/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://client.example/callback'], token_endpoint_auth_method: 'none' })
    })
    expect(response.status, await response.clone().text()).toBe(400)
    expect((await response.json()).error).toBe('invalid_client_metadata')
  })
})
