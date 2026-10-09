import crypto from 'node:crypto'
import { createBackoff } from '../../../api/rate-limit.js'

const ipFailures = createBackoff({ free: 5, baseMs: 30_000, maxMs: 15 * 60_000, forgetMs: 60 * 60_000 })
const clientFailures = createBackoff({ free: 20, baseMs: 60_000, maxMs: 60 * 60_000, forgetMs: 24 * 60 * 60_000 })
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const cookieValue = (req, name) => {
  const raw = String(req.headers.cookie || '')
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i >= 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}
const digestEq = (value, expected) => {
  if (typeof value !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(crypto.createHash('sha256').update(value).digest('hex'), 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
const originOf = baseUrl => new URL(baseUrl).origin
const cspHeaders = {
  'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'
}

export function consentHtml({ pending, clientName, code = '', error = '' }) {
  const host = new URL(pending.redirectUri).host
  const hasWrite = pending.scopes.includes('food:write')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect openGym</title><body>
<main><h1>Connect openGym</h1><p><strong>${escapeHtml(clientName)}</strong> wants access to the openGym profile that created this code.</p>
<p>Redirect host: <code>${escapeHtml(host)}</code></p><p>Read access to workouts and profile data is included.</p>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize/consent" autocomplete="off">
<input type="hidden" name="id" value="${escapeHtml(pending.id)}"><input type="hidden" name="csrf" value="${escapeHtml(code)}">
<label for="link_code">MCP link code</label><input id="link_code" name="link_code" maxlength="32" required autofocus>
${hasWrite ? '<p><label><input type="checkbox" name="food_write" value="yes"> Allow logging and changing food entries</label></p>' : ''}
<p><button name="decision" value="approve">Connect</button> <button name="decision" value="deny">Deny</button></p></form></main></body></html>`
}

export function mountConsentRoute(app, { store, baseUrl, issuerUrl, redeemLink, log }) {
  const origin = originOf(baseUrl)
  app.post('/authorize/consent', async (req, res) => {
    const fetchSite = req.get('sec-fetch-site')
    if ((fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') ||
        (!fetchSite && req.get('origin') !== origin) || (req.get('origin') && req.get('origin') !== origin)) {
      return res.status(403).set(cspHeaders).type('text/plain').send('Request refused')
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some(k => !['id', 'csrf', 'link_code', 'food_write', 'decision'].includes(k)) ||
        typeof body.id !== 'string' || typeof body.csrf !== 'string' || typeof body.decision !== 'string') {
      return res.status(400).set(cspHeaders).type('text/plain').send('Invalid request')
    }
    const pending = store.getPending(body.id)
    if (!pending || pending.exp <= Date.now()) return res.status(400).set(cspHeaders).type('text/plain').send('Request expired. Start again from your MCP client.')
    const clientId = pending.clientId
    const cookie = cookieValue(req, '__Host-og_consent')
    if (!cookie || !digestEq(cookie, pending.browserHash) || !digestEq(body.csrf, pending.csrfHash)) {
      log('oauth.consent', clientId, 'csrf-failed')
      return res.status(403).set(cspHeaders).type('text/plain').send('Request refused')
    }
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const wait = Math.max(ipFailures.retryAfter(ip), clientFailures.retryAfter(clientId))
    if (wait) return res.status(429).set({ ...cspHeaders, 'Retry-After': String(wait) }).type('text/plain').send('Too many attempts. Try again later.')
    const finish = () => { res.setHeader('Set-Cookie', '__Host-og_consent=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax') }
    if (body.decision === 'deny') {
      store.deletePending(pending.id)
      finish()
      const denied = new URL(pending.redirectUri)
      denied.searchParams.set('error', 'access_denied')
      if (pending.state) denied.searchParams.set('state', pending.state)
      denied.searchParams.set('iss', issuerUrl)
      log('oauth.consent', clientId, 'denied')
      return res.redirect(303, denied.href)
    }
    if (body.decision !== 'approve' || typeof body.link_code !== 'string') return res.status(400).set(cspHeaders).type('text/plain').send('Invalid request')
    if (pending.scopes.includes('food:write') && body.food_write === 'yes') pending.scopes = [...new Set([...pending.scopes, 'food:write'])]
    else pending.scopes = pending.scopes.filter(s => s !== 'food:write')
    let profileId
    try { profileId = await redeemLink(body.link_code) }
    catch {
      ipFailures.fail(ip)
      clientFailures.fail(clientId)
      log('oauth.consent', clientId, 'link-failed')
      return res.status(400).set(cspHeaders).type('text/html').send(consentHtml({ pending, clientName: store.clientName(clientId), code: body.csrf, error: 'The code was invalid or expired. Check it and try again.' }))
    }
    const code = store.transaction(() => {
      const authorizationCode = store.issueCode({ pending, profileId })
      store.deletePending(pending.id)
      return authorizationCode
    })
    finish()
    const redirect = new URL(pending.redirectUri)
    redirect.searchParams.set('code', code)
    if (pending.state) redirect.searchParams.set('state', pending.state)
    redirect.searchParams.set('iss', issuerUrl)
    log('oauth.consent', clientId, 'approved')
    return res.redirect(303, redirect.href)
  })
}
