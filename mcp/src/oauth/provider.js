import crypto from 'node:crypto'
import { AccessDeniedError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { consentHtml } from './consent.js'

export const READ_SCOPE = 'opengym:read'
export const FOOD_WRITE_SCOPE = 'food:write'
export const SUPPORTED_SCOPES = [READ_SCOPE, FOOD_WRITE_SCOPE]
const random = () => crypto.randomBytes(32).toString('base64url')

// The SDK answers only its own OAuthError subclasses with a 4xx; anything else is a 500.
function toOAuth(error) {
  if (error instanceof OAuthError) return error
  if (error?.code === 'invalid_grant') return new InvalidGrantError(error.message)
  if (error?.code === 'invalid_scope') return new InvalidScopeError(error.message)
  if (error?.code === 'invalid_token') return new InvalidTokenError(error.message)
  return error
}
const guarded = fn => (...args) => { try { return fn(...args) } catch (error) { throw toOAuth(error) } }

export function createOAuthProvider({ store, clientsStore = store, baseUrl, resourceUrl, log }) {
  const issuer = new URL(baseUrl).href
  return {
    clientsStore,

    async authorize(client, params, res) {
      if (!params.resource || params.resource.href !== resourceUrl) throw new InvalidTargetError('resource must identify this openGym MCP server')
      const scopes = params.scopes?.length ? [...new Set(params.scopes)] : [READ_SCOPE]
      if (scopes.some(s => !SUPPORTED_SCOPES.includes(s))) throw new InvalidScopeError('requested scope is not supported')
      const id = crypto.randomUUID()
      const browserSecret = random()
      const csrf = random()
      const pending = {
        id, clientId: client.client_id, redirectUri: params.redirectUri, scopes,
        state: params.state || null, codeChallenge: params.codeChallenge,
        resource: params.resource.href, browserSecret, csrf,
        exp: Date.now() + 10 * 60_000
      }
      store.createPending(pending)
      const html = consentHtml({ pending, clientName: client.client_name || store.clientName(client.client_id), code: csrf })
      res.status(200).set({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
        'Set-Cookie': `__Host-og_consent=${encodeURIComponent(browserSecret)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
      }).send(html)
    },

    async challengeForAuthorizationCode(client, code) {
      return guarded(() => store.challengeFor(client.client_id, code))()
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      if (!redirectUri || !resource) throw new InvalidTargetError('redirect_uri and resource are required')
      return guarded(() => store.exchangeCode({ clientId: client.client_id, code, redirectUri, resource }))()
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      return guarded(() => store.exchangeRefresh({ clientId: client.client_id, refreshToken, scopes, resource }))()
    },

    async verifyAccessToken(token) { return guarded(() => store.verifyAccess(token))() },

    async revokeToken(client, request) { store.revoke(request.token) }
  }
}
