/* Service auth (homelab MCP service → API): secret + profile headers, an allowlist enforced in
   the API, no mixed credentials, fail-closed boot. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFoodServer, entry, SERVICE_SECRET } from './food-helpers.mjs';

test('missing or wrong secret is a 401', async t => {
  const h = await startFoodServer(t);
  assert.equal((await h.svc('u_food_a', 'nope')('GET', '/api/data')).status, 401);
  assert.equal((await h.svc('u_food_a', SERVICE_SECRET + 'x')('GET', '/api/data')).status, 401);
  assert.equal((await h.call('GET', '/api/data', { headers: { 'X-OpenGym-Profile': 'u_food_a' } })).status, 401, 'profile without a secret');
  assert.equal((await h.svc(null)('GET', '/api/data')).status, 401, 'secret without a profile');
  assert.equal((await h.svc('u_nobody')('GET', '/api/data')).status, 401, 'unknown profile');
  assert.equal((await h.svc('u_food_off')('GET', '/api/data')).status, 401, 'disabled profile');
  assert.equal((await h.svc('../etc')('GET', '/api/data')).status, 401, 'malformed profile');
});

test('non-allowlisted routes are a 403, enforced in the API', async t => {
  const h = await startFoodServer(t);
  const s = h.svc('u_food_a');
  for (const [m, p, body] of [
    ['PUT', '/api/data', { state: { unit: 'lb' } }],
    ['POST', '/api/logout'], ['POST', '/api/logout/all'],
    ['POST', '/api/push/subscribe', { endpoint: 'https://x' }],
    ['POST', '/api/account/device-link', {}], ['POST', '/api/pair/create', {}],
    ['PUT', '/api/food/goals', { calories: 1 }],
    ['GET', '/api/admin/users'], ['GET', '/api/account/passkeys'], ['GET', '/api/me']
  ]) {
    const r = await s(m, p, body ? { body } : {});
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  // And nothing changed behind the 403.
  const state = await h.as('u_food_a')('GET', '/api/data');
  assert.equal(state.body.state.unit, 'kg');
});

test('valid service calls succeed and act as the named profile', async t => {
  const h = await startFoodServer(t);
  const s = h.svc('u_food_a');
  const data = await s('GET', '/api/data');
  assert.equal(data.status, 200);
  assert.equal(data.body.rev, 3);
  assert.equal((await s('GET', '/api/data/rev')).body.rev, 3);

  const made = await s('POST', '/api/food', { body: entry() });
  assert.equal(made.status, 201);
  assert.equal(made.body.source, 'mcp');
  assert.equal((await s('GET', `/api/food/${made.body.id}`)).status, 200);
  assert.equal((await s('PUT', `/api/food/${made.body.id}`, { body: { version: 1, calories: 1 } })).status, 200);
  assert.equal((await s('GET', '/api/food?from=2026-10-01&to=2026-10-31')).body.items.length, 1);
  assert.equal((await s('GET', '/api/food/summary?from=2026-10-01&to=2026-10-31')).status, 200);
  assert.equal((await s('GET', '/api/food/goals')).status, 200);

  // Profile B through the service cannot see or touch A's entry.
  const b = h.svc('u_food_b');
  assert.equal((await b('GET', `/api/food/${made.body.id}`)).status, 404);
  assert.equal((await b('DELETE', `/api/food/${made.body.id}`)).status, 404);
  assert.equal((await s('DELETE', `/api/food/${made.body.id}`)).status, 200);
});

test('a session cookie or bearer alongside the service secret is refused', async t => {
  const h = await startFoodServer(t);
  const s = h.svc('u_food_a');
  assert.equal((await s('GET', '/api/data', { headers: { Cookie: `gymsid=${h.mint('u_food_b')}` } })).status, 400);
  assert.equal((await s('GET', '/api/data', { headers: { Authorization: `Bearer ${h.mint('u_food_b')}` } })).status, 400);
});

test('with no secret configured, the service headers are a 401 everywhere', async t => {
  const h = await startFoodServer(t, { service: false });
  assert.equal((await h.svc('u_food_a')('GET', '/api/data')).status, 401);
  assert.equal((await h.as('u_food_a')('GET', '/api/data')).status, 200, 'sessions unaffected');
});

test('a configured but weak or unreadable secret file refuses to boot', async () => {
  const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-svc-boot-'));
  fs.writeFileSync(path.join(dir, 'secret'), 'a'.repeat(64));
  const weak = path.join(dir, 'weak');
  fs.writeFileSync(weak, 'short');
  try {
    for (const file of [weak, path.join(dir, 'missing')]) {
      const code = await new Promise(resolve => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
          cwd: API, stdio: 'ignore',
          env: { ...process.env, PORT: '0', DATA_DIR: dir, MCP_SERVICE_TOKEN_FILE: file, MEDIA_UPLOADS: '0', COACH_DISABLED: '1' }
        });
        const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.on('exit', c => { clearTimeout(kill); resolve(c); });
      });
      assert.notEqual(code, 0, file);
      assert.notEqual(code, null, file);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
