import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DAY = 86400
const hash = token => crypto.createHash('sha256').update(token).digest('hex')
const random = () => crypto.randomBytes(32).toString('base64url')
const json = value => JSON.stringify(value)
const parse = value => { try { return JSON.parse(value) } catch { return null } }

export function createOAuthStore({ stateDir = process.env.MCP_STATE_DIR || '/state', maxClients = 50 } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path.join(stateDir, 'oauth.sqlite'))
  try { fs.chmodSync(path.join(stateDir, 'oauth.sqlite'), 0o600) } catch { /* volume may not support chmod */ }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version > 1) throw new Error('OAuth state database schema is newer than this server')
  if (version === 0) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE clients (
        client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
        auth_method TEXT NOT NULL, secret_hash TEXT, secret_exp INTEGER, grant_types TEXT NOT NULL,
        response_types TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE pending_auth (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL,
        state TEXT, code_challenge TEXT NOT NULL, resource TEXT NOT NULL, browser_hash TEXT NOT NULL,
        csrf_hash TEXT NOT NULL, exp INTEGER NOT NULL
      );
      CREATE TABLE auth_codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, profile_id TEXT NOT NULL, scopes TEXT NOT NULL,
        resource TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
        created_at INTEGER NOT NULL, exp INTEGER NOT NULL, used_at INTEGER
      );
      CREATE TABLE families (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, profile_id TEXT NOT NULL, scopes TEXT NOT NULL,
        audience TEXT NOT NULL, created_at INTEGER NOT NULL, absolute_exp INTEGER NOT NULL,
        last_used_at INTEGER, revoked_at INTEGER
      );
      CREATE TABLE tokens (
        token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id), kind TEXT NOT NULL,
        created_at INTEGER NOT NULL, exp INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER
      );
      CREATE INDEX tokens_family ON tokens(family_id);
      CREATE INDEX families_profile ON families(profile_id, client_id);
      PRAGMA user_version=1;
      COMMIT;`)
  }

  const tx = fn => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const q = {
    client: db.prepare('SELECT * FROM clients WHERE client_id=?'),
    clientCount: db.prepare('SELECT COUNT(*) AS n FROM clients'),
    clientInsert: db.prepare(`INSERT INTO clients (client_id,client_name,redirect_uris,auth_method,secret_hash,secret_exp,grant_types,response_types,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`),
    pending: db.prepare('SELECT * FROM pending_auth WHERE id=?'),
    pendingInsert: db.prepare(`INSERT INTO pending_auth (id,client_id,redirect_uri,scopes,state,code_challenge,resource,browser_hash,csrf_hash,exp)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
    pendingDelete: db.prepare('DELETE FROM pending_auth WHERE id=?'),
    code: db.prepare('SELECT * FROM auth_codes WHERE code_hash=?'),
    family: db.prepare('SELECT * FROM families WHERE id=?'),
    token: db.prepare('SELECT * FROM tokens WHERE token_hash=?'),
    allFamilies: db.prepare('SELECT * FROM families WHERE profile_id=? AND revoked_at IS NULL'),
    revokeClient: db.prepare('UPDATE families SET revoked_at=? WHERE profile_id=? AND client_id=? AND revoked_at IS NULL'),
    revokeProfile: db.prepare('UPDATE families SET revoked_at=? WHERE profile_id=? AND revoked_at IS NULL')
  }

  function publicClient(row) {
    if (!row) return undefined
    return {
      client_id: row.client_id,
      client_name: row.client_name,
      redirect_uris: parse(row.redirect_uris) || [],
      token_endpoint_auth_method: row.auth_method,
      grant_types: parse(row.grant_types) || ['authorization_code', 'refresh_token'],
      response_types: parse(row.response_types) || ['code'],
      client_id_issued_at: Math.floor(row.created_at / 1000),
      ...(row.auth_method === 'none' ? {} : { client_secret_expires_at: row.secret_exp || 0 })
    }
  }
  function revokeFamily(id, now = Date.now()) {
    db.prepare('UPDATE families SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, id)
    db.prepare('UPDATE tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL').run(now, id)
  }
  function issueFamily({ clientId, profileId, scopes, audience, now = Date.now() }) {
    const id = crypto.randomUUID()
    const absoluteExp = now + 90 * DAY * 1000
    db.prepare(`INSERT INTO families (id,client_id,profile_id,scopes,audience,created_at,absolute_exp)
      VALUES (?,?,?,?,?,?,?)`).run(id, clientId, profileId, json(scopes), audience, now, absoluteExp)
    return issuePair(id, scopes, absoluteExp, now)
  }
  function issuePair(familyId, scopes, absoluteExp, now = Date.now()) {
    const access = random(), refresh = random()
    const accessExp = Math.min(now + 15 * 60 * 1000, absoluteExp)
    const refreshExp = Math.min(now + 30 * DAY * 1000, absoluteExp)
    const insert = db.prepare('INSERT INTO tokens (token_hash,family_id,kind,created_at,exp) VALUES (?,?,?,?,?)')
    insert.run(hash(access), familyId, 'access', now, accessExp)
    insert.run(hash(refresh), familyId, 'refresh', now, refreshExp)
    return {
      access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((accessExp - now) / 1000)),
      refresh_token: refresh, scope: scopes.join(' ')
    }
  }

  return {
    db,
    hash,
    random,
    transaction: tx,
    getClient(clientId) { return publicClient(q.client.get(clientId)) },
    registerClient(client, { allowedRedirectHosts = [], max = maxClients } = {}) {
      const name = String(client.client_name || 'MCP client').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'MCP client'
      const redirects = client.redirect_uris || []
      if (!redirects.length || redirects.length > 20) throw Object.assign(new Error('redirect_uris is required'), { code: 'invalid_client_metadata' })
      for (const raw of redirects) {
        let url
        try { url = new URL(raw) } catch { throw Object.assign(new Error('redirect URI is invalid'), { code: 'invalid_client_metadata' }) }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Object.assign(new Error('redirect URIs must be HTTPS without userinfo or fragments'), { code: 'invalid_client_metadata' })
        if (allowedRedirectHosts.length && !allowedRedirectHosts.includes(url.host)) throw Object.assign(new Error('redirect host is not allowed'), { code: 'invalid_client_metadata' })
      }
      if (q.clientCount.get().n >= max) throw Object.assign(new Error('client limit reached'), { code: 'invalid_client_metadata' })
      const id = client.client_id || crypto.randomUUID()
      const authMethod = client.token_endpoint_auth_method === 'none' ? 'none' : 'client_secret_post'
      const secretHash = client.client_secret ? hash(client.client_secret) : null
      const now = Date.now()
      q.clientInsert.run(id, name, json(redirects), authMethod, secretHash, client.client_secret_expires_at || 0,
        json(['authorization_code', 'refresh_token']), json(['code']), now)
      return {
        ...client, client_id: id, client_name: name, redirect_uris: redirects,
        token_endpoint_auth_method: authMethod,
        ...(secretHash ? { client_secret: client.client_secret, client_secret_expires_at: client.client_secret_expires_at || 0 } : { client_secret: undefined })
      }
    },
    clientSecretValid(clientId, secret) {
      const row = q.client.get(clientId)
      if (!row || row.auth_method !== 'client_secret_post' || !row.secret_hash || typeof secret !== 'string') return false
      if (row.secret_exp && row.secret_exp < Math.floor(Date.now() / 1000)) return false
      const given = Buffer.from(hash(secret), 'hex'), stored = Buffer.from(row.secret_hash, 'hex')
      return given.length === stored.length && crypto.timingSafeEqual(given, stored)
    },
    clientAuthMethod(clientId) { return q.client.get(clientId)?.auth_method || null },
    clientName(clientId) { return q.client.get(clientId)?.client_name || 'MCP client' },
    createPending(pending) {
      q.pendingInsert.run(pending.id, pending.clientId, pending.redirectUri, json(pending.scopes), pending.state,
        pending.codeChallenge, pending.resource, hash(pending.browserSecret), hash(pending.csrf), pending.exp)
    },
    getPending(id) {
      const row = q.pending.get(id)
      return row ? { id: row.id, clientId: row.client_id, redirectUri: row.redirect_uri, scopes: parse(row.scopes) || [],
        state: row.state, codeChallenge: row.code_challenge, resource: row.resource,
        browserHash: row.browser_hash, csrfHash: row.csrf_hash, exp: row.exp } : null
    },
    deletePending(id) { q.pendingDelete.run(id) },
    issueCode({ pending, profileId, now = Date.now() }) {
      const code = random()
      db.prepare(`INSERT INTO auth_codes (code_hash,client_id,profile_id,scopes,resource,redirect_uri,code_challenge,created_at,exp)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(hash(code), pending.clientId, profileId, json(pending.scopes), pending.resource,
        pending.redirectUri, pending.codeChallenge, now, now + 60_000)
      return code
    },
    challengeFor(clientId, code, now = Date.now()) {
      const row = q.code.get(hash(code))
      if (!row || row.client_id !== clientId || row.used_at || row.exp <= now) throw Object.assign(new Error('authorization code is invalid'), { code: 'invalid_grant' })
      return row.code_challenge
    },
    exchangeCode({ clientId, code, redirectUri, resource, now = Date.now() }) {
      return tx(() => {
        const row = q.code.get(hash(code))
        if (!row || row.client_id !== clientId || row.used_at || row.exp <= now || row.redirect_uri !== redirectUri || !resource || row.resource !== resource.href) {
          throw Object.assign(new Error('authorization code is invalid'), { code: 'invalid_grant' })
        }
        db.prepare('UPDATE auth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL').run(now, row.code_hash)
        return issueFamily({ clientId, profileId: row.profile_id, scopes: parse(row.scopes) || [], audience: row.resource, now })
      })
    },
    exchangeRefresh({ clientId, refreshToken, scopes, resource, now = Date.now() }) {
      const result = tx(() => {
        const token = q.token.get(hash(refreshToken))
        const family = token && q.family.get(token.family_id)
        if (!token || token.kind !== 'refresh' || !family || family.client_id !== clientId || family.revoked_at || token.revoked_at || token.exp <= now || family.absolute_exp <= now) {
          throw Object.assign(new Error('refresh token is invalid'), { code: 'invalid_grant' })
        }
        if (token.used_at) {
          revokeFamily(family.id, now)
          return { replay: true }
        }
        if (resource && resource.href !== family.audience) throw Object.assign(new Error('resource does not match token audience'), { code: 'invalid_grant' })
        const granted = parse(family.scopes) || []
        const nextScopes = scopes?.length ? scopes : granted
        if (nextScopes.some(scope => !granted.includes(scope))) throw Object.assign(new Error('scope cannot be expanded'), { code: 'invalid_scope' })
        db.prepare('UPDATE tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(now, token.token_hash)
        db.prepare('UPDATE families SET last_used_at=? WHERE id=?').run(now, family.id)
        return { tokens: issuePair(family.id, nextScopes, family.absolute_exp, now) }
      })
      if (result.replay) throw Object.assign(new Error('refresh token reuse revoked the token family'), { code: 'invalid_grant' })
      return result.tokens
    },
    verifyAccess(token, now = Date.now()) {
      const row = q.token.get(hash(token))
      const family = row && q.family.get(row.family_id)
      if (!row || row.kind !== 'access' || !family || row.revoked_at || family.revoked_at || row.exp <= now || family.absolute_exp <= now) {
        throw Object.assign(new Error('access token is invalid'), { code: 'invalid_token' })
      }
      db.prepare('UPDATE families SET last_used_at=? WHERE id=?').run(now, family.id)
      return { token, clientId: family.client_id, scopes: parse(family.scopes) || [], expiresAt: Math.floor(row.exp / 1000), resource: new URL(family.audience), extra: { profileId: family.profile_id } }
    },
    revoke(tokenValue, now = Date.now()) {
      const row = q.token.get(hash(tokenValue))
      if (row) revokeFamily(row.family_id, now)
    },
    listConnections(profileId) {
      return q.allFamilies.all(profileId).map(f => ({
        client_id: f.client_id, client_name: this.clientName(f.client_id), created_at: new Date(f.created_at).toISOString(),
        last_used_at: f.last_used_at ? new Date(f.last_used_at).toISOString() : null, scopes: parse(f.scopes) || []
      })).filter((x, i, all) => all.findIndex(y => y.client_id === x.client_id) === i)
    },
    revokeClient(profileId, clientId, now = Date.now()) { q.revokeClient.run(now, profileId, clientId) },
    revokeProfile(profileId, now = Date.now()) { q.revokeProfile.run(now, profileId) },
    prune(now = Date.now()) {
      db.prepare('DELETE FROM pending_auth WHERE exp<=?').run(now)
      db.prepare('DELETE FROM auth_codes WHERE exp<=? OR used_at IS NOT NULL').run(now)
      db.prepare('DELETE FROM tokens WHERE exp<=? OR revoked_at IS NOT NULL').run(now - 90 * DAY * 1000)
      db.prepare('DELETE FROM families WHERE absolute_exp<=? OR revoked_at IS NOT NULL').run(now - 90 * DAY * 1000)
    },
    close() { db.close() }
  }
}
