import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOAuthStore } from '../src/oauth/store.js'

let dir
let store
const setup = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-oauth-'))
  store = createOAuthStore({ stateDir: dir, maxClients: 2 })
  return store
}
afterEach(() => { store?.close(); store = null; if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null })
const client = (id = 'client-a', method = 'none') => ({
  client_id: id, client_name: 'Test app', redirect_uris: ['https://client.example/callback'],
  token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
})
const pending = overrides => ({
  id: 'pending-1', clientId: 'client-a', redirectUri: 'https://client.example/callback',
  scopes: ['opengym:read', 'food:write'], state: 'state-1', codeChallenge: 'pkce-challenge',
  resource: 'https://gym.example/mcp', browserSecret: 'browser-secret', csrf: 'csrf-token',
  exp: Date.now() + 600000, ...overrides
})
const minted = (db, scopes = ['opengym:read', 'food:write']) => {
  const p = pending({ scopes })
  const code = db.issueCode({ pending: p, profileId: 'profile-a' })
  const tokens = db.exchangeCode({ clientId: 'client-a', code, redirectUri: p.redirectUri, resource: new URL(p.resource) })
  return { p, code, tokens }
}

 describe('OAuth client storage', () => {
  it('stores only the client-secret hash and enforces the registration cap', () => {
    const db = setup()
    const secret = 'secret-from-dcr'
    db.registerClient({ ...client('confidential', 'client_secret_post'), client_secret: secret, client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600 })
    const stored = db.db.prepare('SELECT * FROM clients WHERE client_id=?').get('confidential')
    expect(stored.secret_hash).not.toBe(secret)
    expect(stored.secret_hash).toHaveLength(64)
    expect(db.getClient('confidential').client_secret).toBeUndefined()
    expect(db.clientSecretValid('confidential', secret)).toBe(true)
    expect(db.clientSecretValid('confidential', 'wrong')).toBe(false)
    db.registerClient(client('public'))
    expect(() => db.registerClient(client('third'))).toThrow()
  })

  it('refuses insecure redirects and enforces an optional exact host allowlist', () => {
    const db = setup()
    expect(() => db.registerClient({ ...client(), redirect_uris: ['http://client.example/callback'] })).toThrow(/HTTPS/)
    expect(() => db.registerClient(client('blocked'), { allowedRedirectHosts: ['other.example'] })).toThrow(/not allowed/)
    expect(() => db.registerClient({ ...client('fragment'), redirect_uris: ['https://client.example/cb#frag'] })).toThrow(/fragments/)
  })
})

describe('OAuth codes and tokens', () => {
  it('binds a single-use code to client, redirect, PKCE challenge, profile, scopes and audience', () => {
    const db = setup()
    db.registerClient(client())
    const p = pending()
    const code = db.issueCode({ pending: p, profileId: 'profile-a' })
    expect(db.challengeFor('client-a', code)).toBe('pkce-challenge')
    expect(() => db.exchangeCode({ clientId: 'client-a', code, redirectUri: p.redirectUri, resource: new URL('https://other.example/mcp') })).toThrow(/invalid/)
    const tokens = db.exchangeCode({ clientId: 'client-a', code, redirectUri: p.redirectUri, resource: new URL(p.resource) })
    const auth = db.verifyAccess(tokens.access_token)
    expect(auth.clientId).toBe('client-a')
    expect(auth.extra.profileId).toBe('profile-a')
    expect(auth.scopes).toEqual(['opengym:read', 'food:write'])
    expect(auth.resource.href).toBe(p.resource)
    expect(() => db.challengeFor('client-a', code)).toThrow(/invalid/)
    expect(() => db.exchangeCode({ clientId: 'client-a', code, redirectUri: p.redirectUri, resource: new URL(p.resource) })).toThrow(/invalid/)
    const savedCode = db.db.prepare('SELECT * FROM auth_codes').get()
    expect(savedCode.code_hash).not.toBe(code)
    expect(savedCode.used_at).toBeTruthy()
  })

  it('rejects expired authorization codes', () => {
    const db = setup()
    db.registerClient(client())
    const p = pending()
    const now = Date.now() - 120000
    const code = db.issueCode({ pending: p, profileId: 'profile-a', now })
    expect(() => db.challengeFor('client-a', code)).toThrow(/invalid/)
  })

  it('rotates refresh tokens, allows scope reduction, and revokes the family on reuse', () => {
    const db = setup()
    db.registerClient(client())
    const { p, tokens } = minted(db)
    const next = db.exchangeRefresh({ clientId: 'client-a', refreshToken: tokens.refresh_token, scopes: ['opengym:read'], resource: new URL(p.resource) })
    expect(next.scope).toBe('opengym:read')
    expect(() => db.exchangeRefresh({ clientId: 'client-a', refreshToken: tokens.refresh_token, resource: new URL(p.resource) })).toThrow(/reuse/)
    expect(() => db.verifyAccess(next.access_token)).toThrow(/invalid/)
  })

  it('rejects scope expansion, wrong audience, expiration, and revocation', () => {
    const db = setup()
    db.registerClient(client())
    const { p, tokens } = minted(db, ['opengym:read'])
    expect(() => db.exchangeRefresh({ clientId: 'client-a', refreshToken: tokens.refresh_token, scopes: ['food:write'], resource: new URL(p.resource) })).toThrow(/expand/)
    expect(() => db.exchangeRefresh({ clientId: 'client-a', refreshToken: tokens.refresh_token, resource: new URL('https://other.example/mcp') })).toThrow(/resource/)
    expect(() => db.verifyAccess(tokens.access_token, Date.now() + 16 * 60 * 1000)).toThrow(/invalid/)
    db.revoke(tokens.access_token)
    expect(() => db.verifyAccess(tokens.access_token)).toThrow(/invalid/)
    expect(() => db.exchangeRefresh({ clientId: 'client-a', refreshToken: tokens.refresh_token })).toThrow(/invalid/)
  })
})
