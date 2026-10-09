/* Remote MCP pairing code: owner proof, 130-bit one-use code, only its hash is persisted, and
   redemption is restricted to the service-auth allowlist. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hashPassword } from '../password.js';
import { startFoodServer } from './food-helpers.mjs';

const GOOD = 'correct horse battery staple';
let passwordHash;

async function linkedServer(t, extra = {}) {
  passwordHash ||= await hashPassword(GOOD);
  return startFoodServer(t, {
    env: { PASSWORD_LOGIN: '1', ...extra },
    users: [{ id: 'u_food_a', name: 'A', created: new Date().toISOString(), pw: { h: passwordHash, set: new Date().toISOString() } }]
  });
}

test('making an MCP code requires owner proof and stores only its hash', async t => {
  const h = await linkedServer(t);
  const a = h.as('u_food_a');
  assert.equal((await a('POST', '/api/account/mcp-link', { body: {} })).status, 403, 'session alone is not enough');
  assert.equal((await a('POST', '/api/account/mcp-link', { body: { current: 'wrong password' } })).status, 403);

  const made = await a('POST', '/api/account/mcp-link', { body: { current: GOOD } });
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^[A-HJ-NP-Z2-9]{5}(?:-[A-HJ-NP-Z2-9]{5}){3}-[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(made.body.expires > Date.now(), true);
  const db = JSON.parse(fs.readFileSync(`${h.dataDir}/db.json`, 'utf8'));
  assert.equal(db.mcpLinks.length, 1);
  assert.equal(db.mcpLinks[0].h.length, 64);
  assert.equal(db.mcpLinks[0].h.includes(made.body.code.replaceAll('-', '')), false);
  assert.equal(db.mcpLinks[0].userId, 'u_food_a');
});

test('link redemption is service-only, profile-scoped, and one-time', async t => {
  const h = await linkedServer(t);
  const made = await h.as('u_food_a')('POST', '/api/account/mcp-link', { body: { current: GOOD } });
  const redeem = h.svc(null);
  assert.equal((await h.call('POST', '/api/internal/mcp/link-code/redeem', { body: { code: made.body.code } })).status, 401);
  assert.equal((await redeem('POST', '/api/internal/mcp/link-code/redeem', { body: { code: 'wrong' } })).status, 404);
  const ok = await redeem('POST', '/api/internal/mcp/link-code/redeem', { body: { code: made.body.code } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { profile_id: 'u_food_a' });
  assert.equal((await redeem('POST', '/api/internal/mcp/link-code/redeem', { body: { code: made.body.code } })).status, 404);
});

test('a newer owner code invalidates the earlier one', async t => {
  const h = await linkedServer(t);
  const a = h.as('u_food_a');
  const first = await a('POST', '/api/account/mcp-link', { body: { current: GOOD } });
  const second = await a('POST', '/api/account/mcp-link', { body: { current: GOOD } });
  assert.notEqual(first.body.code, second.body.code);
  const redeem = h.svc(null);
  assert.equal((await redeem('POST', '/api/internal/mcp/link-code/redeem', { body: { code: first.body.code } })).status, 404);
  assert.equal((await redeem('POST', '/api/internal/mcp/link-code/redeem', { body: { code: second.body.code } })).status, 200);
});
