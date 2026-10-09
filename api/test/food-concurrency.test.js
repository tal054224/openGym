/* Parallel food writes: optimistic versioning must let exactly one of a burst of same-version
   updates through, and a burst of same-key creates must leave exactly one row. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFoodServer, entry } from './food-helpers.mjs';

test('parallel updates on one version: one wins, the rest are 409, nothing is lost', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  const made = await a('POST', '/api/food', { body: entry() });
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    a('PUT', `/api/food/${made.body.id}`, { body: { version: 1, calories: 1000 + i } })));
  const ok = results.filter(r => r.status === 200);
  assert.equal(ok.length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 49);
  const final = await a('GET', `/api/food/${made.body.id}`);
  assert.equal(final.body.version, 2);
  assert.equal(final.body.calories, ok[0].body.calories, 'the stored value is the winner, not a later loser');
});

test('a read-modify-write loop under contention keeps every increment', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  const made = await a('POST', '/api/food', { body: entry({ quantity: 1 }) });
  const bump = async () => {
    for (;;) {
      const cur = await a('GET', `/api/food/${made.body.id}`);
      const r = await a('PUT', `/api/food/${made.body.id}`, { body: { version: cur.body.version, quantity: cur.body.quantity + 1 } });
      if (r.status === 200) return;
      assert.equal(r.status, 409);
    }
  };
  await Promise.all(Array.from({ length: 10 }, bump));
  const final = await a('GET', `/api/food/${made.body.id}`);
  assert.equal(final.body.quantity, 11);
  assert.equal(final.body.version, 11);
});

test('parallel creates with one idempotency key leave one row', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  const body = entry({ idempotency_key: 'burst-1' });
  const results = await Promise.all(Array.from({ length: 30 }, () => a('POST', '/api/food', { body })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.ok(results.every(r => r.status === 201 || r.status === 200));
  assert.equal(new Set(results.map(r => r.body.id)).size, 1);
  assert.equal((await a('GET', '/api/food?from=2026-10-09&to=2026-10-09')).body.items.length, 1);
});
