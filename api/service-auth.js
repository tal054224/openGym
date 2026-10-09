/* Service-to-service auth (the homelab MCP service calling this API). A shared secret read from
   MCP_SERVICE_TOKEN_FILE plus the profile the MCP resolved from its OAuth token. Only the routes
   in SERVICE_ROUTES accept it; the allowlist is enforced here, in the API, before any handler. */
import fs from 'node:fs';
import crypto from 'node:crypto';

export const SERVICE_TOKEN_HEADER = 'x-opengym-service-token';
export const SERVICE_PROFILE_HEADER = 'x-opengym-profile';
const MIN_SECRET_BYTES = 32;
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 'profile': acts as the profile named in the header. 'none': service-only, no profile.
export const SERVICE_ROUTES = Object.freeze({
  'GET /api/data': 'profile',
  'GET /api/data/rev': 'profile',
  'GET /api/food': 'profile',
  'GET /api/food/summary': 'profile',
  'GET /api/food/goals': 'profile',
  'GET /api/food/{id}': 'profile',
  'POST /api/food': 'profile',
  'PUT /api/food/{id}': 'profile',
  'DELETE /api/food/{id}': 'profile',
  'POST /api/internal/mcp/link-code/redeem': 'none'
});

const digest = s => crypto.createHash('sha256').update(s).digest();

/** Reads the secret once at boot. Unset: the feature is off. Set but unusable: throw (fail closed). */
export function loadServiceSecret(file) {
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`MCP_SERVICE_TOKEN_FILE ${file} is not readable (${e.code || e.message})`); }
  const secret = raw.trim();
  if (Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new Error(`MCP_SERVICE_TOKEN_FILE must hold at least ${MIN_SECRET_BYTES} bytes of secret`);
  }
  return digest(secret);
}

/**
 * Decides a request that carries the service header. Returns null when it carries none (the
 * normal session path applies), otherwise { status, error } to refuse with, or { user } / { ok }.
 */
export function checkService(req, key, { secretDigest, findUser }) {
  const given = req.headers[SERVICE_TOKEN_HEADER];
  const profile = req.headers[SERVICE_PROFILE_HEADER];
  if (given === undefined && profile === undefined) return null;
  if (!secretDigest || typeof given !== 'string' || !crypto.timingSafeEqual(digest(given), secretDigest)) {
    return { status: 401, error: 'invalid service credentials' };
  }
  // Mixed credentials are refused outright: a browser session must never ride a service call.
  if (req.headers.cookie || req.headers.authorization) return { status: 400, error: 'mixed credentials' };
  const kind = SERVICE_ROUTES[key];
  if (!kind) return { status: 403, error: 'route not allowed for service auth' };
  if (kind === 'none') return { ok: true };
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) return { status: 401, error: 'invalid service credentials' };
  const user = findUser(profile);
  if (!user || user.disabled) return { status: 401, error: 'invalid service credentials' };
  return { user };
}
