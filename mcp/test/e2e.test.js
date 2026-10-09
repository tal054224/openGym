/* End to end: the real API and the real MCP HTTP service as child processes, a full OAuth 2.1
   authorization-code + PKCE flow with a link code, then every tool through the MCP SDK client. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { hashPassword } from '../../api/password.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECRET = 'b'.repeat(64)
const SERVICE = 's'.repeat(48)
const PASSWORD = 'correct horse battery staple'
const REDIRECT = 'https://client.example/callback'
const children = []
let dir, api, base, publicPort, internalPort

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const start = (cmd, cwd, env, ready) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, cmd, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  const timer = setTimeout(() => reject(new Error('did not start:\n' + out)), 20000)
  const look = d => { out += d; const m = ready(out); if (m) { clearTimeout(timer); resolve(m) } }
  child.stdout.on('data', look); child.stderr.on('data', d => { out += d })
  child.once('exit', c => { clearTimeout(timer); reject(new Error(`exited ${c}:\n${out}`)) })
})
const cookieFor = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`
  return `gymsid=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`
}
const apiCall = async (method, p, { uid, body } = {}) => {
  const r = await fetch(api + p, { method, headers: { 'content-type': 'application/json', ...(uid ? { cookie: cookieFor(uid) } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
const verifier = 'v'.repeat(43)
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

/** A complete connection for `uid`: link code → DCR → authorize → consent → token. */
async function connect(uid, { write = true, name = 'E2E client' } = {}) {
  const link = await apiCall('POST', '/api/account/mcp-link', { uid, body: { current: PASSWORD } })
  expect(link.status).toBe(200)
  const reg = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })
  expect(reg.status).toBe(201)
  const client = await reg.json()
  const auth = await fetch(base + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', resource: base + '/mcp', scope: 'opengym:read food:write', state: 's1' }), { redirect: 'manual' })
  expect(auth.status).toBe(200)
  const html = await auth.text()
  const id = /name="id" value="([^"]+)"/.exec(html)[1]
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1]
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const consent = await fetch(base + '/authorize/consent', { method: 'POST', redirect: 'manual',
    headers: { origin: base, 'sec-fetch-site': 'same-origin', cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id, csrf, link_code: link.body.code, decision: 'approve', ...(write ? { food_write: 'yes' } : {}) }) })
  expect(consent.status).toBe(303)
  const code = new URL(consent.headers.get('location')).searchParams.get('code')
  const token = await fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: base + '/mcp' }) })
  expect(token.status).toBe(200)
  return { client, tokens: await token.json(), linkCode: link.body.code, consentArgs: { id, csrf, cookie } }
}
async function mcp(accessToken) {
  const c = new Client({ name: 'e2e', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }))
  return c
}
const run = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args })
  return { error: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-e2e-'))
  const pw = await hashPassword(PASSWORD)
  const when = new Date().toISOString()
  fs.writeFileSync(path.join(dir, 'secret'), SECRET)
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ creds: [], subs: [], invites: [], users: ['u_e2e_a', 'u_e2e_b'].map(id => ({ id, name: id, created: when, pw: { h: pw, set: when } })) }))
  fs.writeFileSync(path.join(dir, 'state-u_e2e_a.json'), JSON.stringify({ unit: 'kg', routines: [{ id: 'r1', name: 'Push', ex: [] }], workouts: [], bodyweight: [], _rev: 1 }))
  const tokenFile = path.join(dir, 'service-token')
  fs.writeFileSync(tokenFile, SERVICE)
  publicPort = await freePort(); internalPort = await freePort()
  base = `http://localhost:${publicPort}`
  const apiPort = await start(['server.js'], path.join(ROOT, 'api'), {
    PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', PASSWORD_LOGIN: '1', COACH_DISABLED: '1', MEDIA_UPLOADS: '0',
    MCP_SERVICE_TOKEN_FILE: tokenFile, MCP_INTERNAL_URL: `http://127.0.0.1:${internalPort}`
  }, out => /gym-api on :(\d+)/.exec(out)?.[1])
  api = `http://127.0.0.1:${apiPort}`
  await start(['src/http.js'], path.join(ROOT, 'mcp'), {
    PUBLIC_BASE_URL: base, PORT: String(publicPort), INTERNAL_PORT: String(internalPort), API_INTERNAL_URL: api,
    MCP_SERVICE_TOKEN_FILE: tokenFile, MCP_STATE_DIR: path.join(dir, 'mcp-state'), NODE_ENV: 'test'
  }, out => (out.includes('mcp.http') && out.includes('mcp.internal') ? true : null))
}, 60000)
afterAll(() => { for (const c of children) c.kill('SIGKILL'); if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

describe('remote MCP end to end', () => {
  it('serves discovery metadata and challenges an unauthenticated /mcp', async () => {
    const prm = await (await fetch(base + '/.well-known/oauth-protected-resource')).json()
    expect(prm.resource).toBe(base + '/mcp')
    const as = await (await fetch(base + '/.well-known/oauth-authorization-server')).json()
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=')
    expect((await fetch(base + '/api/food')).status).toBe(404)
    // fetch() cannot override Host, so the foreign-host probe is a raw request.
    const foreign = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: publicPort, path: '/.well-known/oauth-authorization-server', headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) })
      req.end()
    })
    expect(foreign).toBe(403)
  })

  it('runs every tool end to end, and the only write tools are the three food tools', async () => {
    const { tokens } = await connect('u_e2e_a')
    const c = await mcp(tokens.access_token)
    const tools = (await c.listTools()).tools
    const writes = tools.filter(t => !t.annotations?.readOnlyHint).map(t => t.name).sort()
    expect(writes).toEqual(['create_food_log', 'delete_food_log', 'update_food_log'])
    expect(tools.some(t => /file|shell|fetch|raw|patch/i.test(t.name))).toBe(false)
    expect(tools.find(t => t.name === 'delete_food_log').annotations.destructiveHint).toBe(true)

    expect((await run(c, 'list_routines')).json.routines.map(r => r.name)).toEqual(['Push'])
    const made = await run(c, 'create_food_log', { date: '2026-10-09', meal: 'lunch', name: 'Rice bowl', calories: 640, protein_g: 30, carbs_g: 90, fat_g: 14 })
    expect(made.json.source).toBe('mcp')
    const id = made.json.id
    expect((await run(c, 'get_food_log', { id })).json.name).toBe('Rice bowl')
    expect((await run(c, 'list_food_logs', { from: '2026-10-09', to: '2026-10-09' })).json.items).toHaveLength(1)
    expect((await run(c, 'get_nutrition_summary', { from: '2026-10-09', to: '2026-10-09' })).json.totals.calories).toBe(640)
    const upd = await run(c, 'update_food_log', { id, version: 1, calories: 600 })
    expect(upd.json.version).toBe(2)
    expect((await run(c, 'update_food_log', { id, version: 1, calories: 1 })).error).toBe(true)
    expect((await run(c, 'create_food_log', { date: '2026-10-09', meal: 'brunch', name: 'x' })).error).toBe(true)

    // Logged by the assistant, visible to the person in the manual log: one store.
    const ui = await apiCall('GET', '/api/food?from=2026-10-09&to=2026-10-09', { uid: 'u_e2e_a' })
    expect(ui.body.items.map(i => i.name)).toEqual(['Rice bowl'])
    expect((await run(c, 'delete_food_log', { id, version: 2 })).json.ok).toBe(true)
    await c.close()
  }, 60000)

  it('keeps profiles apart: a token for A cannot see or touch B', async () => {
    const a = await connect('u_e2e_a')
    const b = await connect('u_e2e_b')
    const ca = await mcp(a.tokens.access_token), cb = await mcp(b.tokens.access_token)
    const entry = await run(ca, 'create_food_log', { date: '2026-10-10', meal: 'dinner', name: 'A only' })
    expect((await run(cb, 'list_food_logs', { from: '2026-10-10', to: '2026-10-10' })).json.items).toEqual([])
    expect((await run(cb, 'get_food_log', { id: entry.json.id })).text).toContain('NOT_FOUND')
    expect((await run(cb, 'delete_food_log', { id: entry.json.id })).text).toContain('NOT_FOUND')
    const otherState = (await run(cb, 'list_routines')).json
    expect(otherState.routines).toBeUndefined() // B has no synced state: A's routines are not visible
    expect(otherState.error).toMatch(/no synced state/)
    await ca.close(); await cb.close()
  }, 60000)

  it('a token without food:write cannot write and is not offered the write tools', async () => {
    const { tokens } = await connect('u_e2e_a', { write: false })
    expect(tokens.scope).toBe('opengym:read')
    const c = await mcp(tokens.access_token)
    const names = (await c.listTools()).tools.map(t => t.name)
    expect(names).toContain('list_food_logs')
    expect(names).not.toContain('create_food_log')
    expect((await c.callTool({ name: 'create_food_log', arguments: { date: '2026-10-09', meal: 'lunch', name: 'x' } })).isError).toBe(true)
    await c.close()
  }, 60000)

  it('a link code and an authorization code work once', async () => {
    const first = await connect('u_e2e_a')
    const reuse = await fetch(base + '/authorize/consent', { method: 'POST', redirect: 'manual',
      headers: { origin: base, 'sec-fetch-site': 'same-origin', cookie: first.consentArgs.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: first.consentArgs.id, csrf: first.consentArgs.csrf, link_code: first.linkCode, decision: 'approve' }) })
    expect(reuse.status).toBe(400) // the pending request was consumed with the first approval
    const bad = await fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: first.client.client_id, code: 'nope', redirect_uri: REDIRECT, code_verifier: verifier, resource: base + '/mcp' }) })
    expect(bad.status).toBe(400)
  }, 60000)

  it('refresh rotation works, and reusing an old refresh token revokes the whole family', async () => {
    const { client, tokens } = await connect('u_e2e_a')
    const refresh = rt => fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: rt, resource: base + '/mcp' }) })
    const next = await refresh(tokens.refresh_token)
    expect(next.status).toBe(200)
    const rotated = await next.json()
    expect((await mcp(rotated.access_token).then(c => c.close())) ?? true).toBeTruthy()
    expect((await refresh(tokens.refresh_token)).status).toBe(400) // replay
    const after = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${rotated.access_token}`, 'content-type': 'application/json' }, body: '{}' })
    expect(after.status).toBe(401)
  }, 60000)

  it('lists connected apps through the API and revoking one ends its tokens', async () => {
    const { client, tokens } = await connect('u_e2e_b', { name: 'Revocable app' })
    const list = await apiCall('GET', '/api/account/mcp-apps', { uid: 'u_e2e_b' })
    expect(list.status).toBe(200)
    expect(list.body.apps.some(a => a.client_id === client.client_id && a.client_name === 'Revocable app')).toBe(true)
    expect((await apiCall('POST', '/api/account/mcp-apps/revoke', { uid: 'u_e2e_a', body: { client_id: client.client_id } })).status).toBe(200)
    const stillWorks = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: '{}' })
    expect(stillWorks.status).not.toBe(401) // A revoking B's client id removed nothing: it is scoped to A's profile
    expect((await apiCall('POST', '/api/account/mcp-apps/revoke', { uid: 'u_e2e_b', body: { client_id: client.client_id } })).status).toBe(200)
    const gone = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: '{}' })
    expect(gone.status).toBe(401)
  }, 60000)

  it('refuses a non-https redirect, a missing resource and plain PKCE', async () => {
    const reg = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://x.example/cb'], token_endpoint_auth_method: 'none' }) })
    expect(reg.status).toBe(400)
    const ok = await (await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json()
    const q = extra => fetch(base + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: ok.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: base + '/mcp', ...extra }), { redirect: 'manual' })
    const noResource = new URLSearchParams({ response_type: 'code', client_id: ok.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })
    expect(new URL((await fetch(base + '/authorize?' + noResource, { redirect: 'manual' })).headers.get('location')).searchParams.get('error')).toBe('invalid_target')
    expect(new URL((await q({ code_challenge_method: 'plain' })).headers.get('location')).searchParams.get('error')).toBe('invalid_request')
    expect(new URL((await q({ redirect_uri: 'https://evil.example/cb' })).headers.get('location') || 'https://x/?error=invalid_request').searchParams.get('error')).toBe('invalid_request')
    expect((await q({ redirect_uri: 'https://evil.example/cb' })).status).toBe(400)
  }, 60000)
})
