import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const priorFile = process.env.MCP_SERVICE_TOKEN_FILE
const priorUrl = process.env.API_INTERNAL_URL
let dir
let fetchMock

afterEach(() => {
  vi.unstubAllGlobals()
  if (priorFile === undefined) delete process.env.MCP_SERVICE_TOKEN_FILE
  else process.env.MCP_SERVICE_TOKEN_FILE = priorFile
  if (priorUrl === undefined) delete process.env.API_INTERNAL_URL
  else process.env.API_INTERNAL_URL = priorUrl
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

async function clientWithToken() {
  vi.resetModules()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-api-client-'))
  const file = path.join(dir, 'service-token')
  fs.writeFileSync(file, 's'.repeat(48))
  process.env.MCP_SERVICE_TOKEN_FILE = file
  process.env.API_INTERNAL_URL = 'http://api:3000/'
  fetchMock = vi.fn(async (_url, _options) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return import('../src/api-client.js')
}

describe('MCP service API client', () => {
  it('sends the file-backed token and OAuth profile, with no user session token', async () => {
    const { apiCall } = await clientWithToken()
    await apiCall('profile-a', '/api/food?from=2026-10-01')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api:3000/api/food?from=2026-10-01')
    expect(init.headers['X-OpenGym-Service-Token']).toBe('s'.repeat(48))
    expect(init.headers['X-OpenGym-Profile']).toBe('profile-a')
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('returns fixed error categories without forwarding the API body', async () => {
    const { apiCall } = await clientWithToken()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'secret food contents', field: 'calories' }), { status: 400 }))
    await expect(apiCall('profile-a', '/api/food', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'invalid calories' })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'private profile data' }), { status: 500 }))
    await expect(apiCall('profile-a', '/api/food')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'request could not be completed' })
  })
})
