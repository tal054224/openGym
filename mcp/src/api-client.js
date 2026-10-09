/* MCP's only data path: calls the API with service auth and the profile resolved from OAuth.
   Never returns server error bodies to tool callers. */
import fs from 'node:fs'

const API_URL = (process.env.API_INTERNAL_URL || 'http://api:3000').replace(/\/+$/, '')
let token = null

function serviceToken() {
  if (token) return token
  const file = process.env.MCP_SERVICE_TOKEN_FILE
  if (!file) throw Object.assign(new Error('service auth is not configured'), { code: 'UNAVAILABLE' })
  try { token = fs.readFileSync(file, 'utf8').trim() }
  catch { throw Object.assign(new Error('service auth is unavailable'), { code: 'UNAVAILABLE' }) }
  if (Buffer.byteLength(token) < 32) throw Object.assign(new Error('service auth is unavailable'), { code: 'UNAVAILABLE' })
  return token
}

export async function apiCall(profileId, path, { method = 'GET', body } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(API_URL + path, {
      method,
      headers: {
        'X-OpenGym-Service-Token': serviceToken(),
        ...(profileId ? { 'X-OpenGym-Profile': profileId } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    })
    let data = null
    try { data = await response.json() } catch { /* malformed API response is unavailable */ }
    if (!response.ok) {
      const status = response.status
      const code = status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : status === 400 ? 'INVALID_INPUT' : status === 401 || status === 403 ? 'UNAUTHORIZED' : 'UNAVAILABLE'
      const error = new Error(code === 'INVALID_INPUT' && typeof data?.field === 'string' ? `invalid ${data.field}` : 'request could not be completed')
      error.code = code
      error.field = code === 'INVALID_INPUT' && typeof data?.field === 'string' ? data.field : undefined
      throw error
    }
    if (!data || typeof data !== 'object') throw Object.assign(new Error('invalid API response'), { code: 'UNAVAILABLE' })
    return data
  } catch (error) {
    if (error?.code) throw error
    throw Object.assign(new Error('API unavailable'), { code: 'UNAVAILABLE' })
  } finally { clearTimeout(timeout) }
}
