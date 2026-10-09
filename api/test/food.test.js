/* Food log API (homelab fork): CRUD, strict validation, bounds, idempotency, optimistic
   versioning, ownership (another profile's entry is a 404), goals and the summary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFoodServer, entry } from './food-helpers.mjs';

test('create, read, list, update, delete', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');

  const made = await a('POST', '/api/food', { body: entry({ time: '08:15', notes: '  with berries ' }) });
  assert.equal(made.status, 201);
  assert.match(made.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(made.body.version, 1);
  assert.equal(made.body.source, 'ui');
  assert.equal(made.body.notes, 'with berries');

  const got = await a('GET', `/api/food/${made.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, made.body);

  const list = await a('GET', '/api/food?from=2026-10-01&to=2026-10-31');
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.next_cursor, null);

  const upd = await a('PUT', `/api/food/${made.body.id}`, { body: { version: 1, calories: 320, notes: null } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.version, 2);
  assert.equal(upd.body.calories, 320);
  assert.equal(upd.body.notes, null);
  assert.equal(upd.body.name, 'Oatmeal', 'fields not sent are untouched');

  const del = await a('DELETE', `/api/food/${made.body.id}?version=2`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });
  assert.equal((await a('GET', `/api/food/${made.body.id}`)).status, 404);
});

test('unknown fields are refused, on create and on update', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  const r = await a('POST', '/api/food', { body: entry({ brand: 'x' }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'brand');
  assert.equal((await a('POST', '/api/food', { body: entry({ source: 'mcp' }) })).body.field, 'source', 'source is never client-set');
  assert.equal((await a('POST', '/api/food', { body: entry({ id: 'x' }) })).status, 400);

  const made = await a('POST', '/api/food', { body: entry() });
  const u = await a('PUT', `/api/food/${made.body.id}`, { body: { version: 1, profile_id: 'u_food_b' } });
  assert.equal(u.status, 400);
  assert.equal(u.body.field, 'profile_id');
  assert.equal((await a('GET', '/api/food?from=2026-10-01&to=2026-10-02&evil=1')).status, 400);
});

test('out-of-bounds and malformed values are refused', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  const cases = [
    [{ name: '' }, 'name'], [{ name: '   ' }, 'name'], [{ name: 'x'.repeat(121) }, 'name'], [{ name: 'a\u0000b' }, 'name'],
    [{ name: 5 }, 'name'], [{ meal: 'brunch' }, 'meal'], [{ unit: 'kg' }, 'unit'],
    [{ date: '2026-02-30' }, 'date'], [{ date: '09-10-2026' }, 'date'], [{ date: '1999-12-31' }, 'date'],
    [{ time: '24:00' }, 'time'], [{ time: '8:15' }, 'time'],
    [{ quantity: 0 }, 'quantity'], [{ quantity: 10001 }, 'quantity'], [{ quantity: '80' }, 'quantity'],
    [{ calories: -1 }, 'calories'], [{ calories: 20001 }, 'calories'], [{ protein_g: 2001 }, 'protein_g'],
    [{ fat_g: -0.5 }, 'fat_g'], [{ notes: 'n'.repeat(501) }, 'notes'],
    [{ idempotency_key: 'has space' }, 'idempotency_key'], [{ idempotency_key: 'k'.repeat(101) }, 'idempotency_key']
  ];
  for (const [over, field] of cases) {
    const r = await a('POST', '/api/food', { body: entry(over) });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.body.field, field, JSON.stringify(over));
  }
  for (const missing of ['date', 'meal', 'name']) {
    const body = entry(); delete body[missing];
    assert.equal((await a('POST', '/api/food', { body })).status, 400, missing);
  }
  assert.equal((await a('POST', '/api/food', { body: '[1]' })).status, 400, 'non-object body');
  assert.equal((await a('POST', '/api/food', { body: entry({ notes: 'x'.repeat(17000) }) })).status, 413, 'body cap is 16 KiB');

  const made = await a('POST', '/api/food', { body: entry() });
  assert.equal((await a('PUT', `/api/food/${made.body.id}`, { body: { calories: 1 } })).status, 400, 'version required');
  assert.equal((await a('PUT', `/api/food/${made.body.id}`, { body: { version: 1, name: null } })).status, 400, 'required field cannot be cleared');
  assert.equal((await a('PUT', `/api/food/${made.body.id}`, { body: { version: 1 } })).status, 400, 'empty patch');

  assert.equal((await a('GET', '/api/food?from=2026-10-01&to=2026-10-31&limit=201')).status, 400);
  assert.equal((await a('GET', '/api/food?from=2025-01-01&to=2026-10-31')).status, 400, 'range over 366 days');
  assert.equal((await a('GET', '/api/food?from=2026-10-31&to=2026-10-01')).status, 400, 'reversed range');
  assert.equal((await a('GET', '/api/food?from=2026-10-01')).status, 400, 'to required');
});

test('a stale version is a 409 carrying the current entry', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  const made = await a('POST', '/api/food', { body: entry() });
  assert.equal((await a('PUT', `/api/food/${made.body.id}`, { body: { version: 1, calories: 310 } })).status, 200);
  const stale = await a('PUT', `/api/food/${made.body.id}`, { body: { version: 1, calories: 999 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'version-conflict');
  assert.equal(stale.body.current.calories, 310);
  assert.equal(stale.body.current.version, 2);
  assert.equal((await a('DELETE', `/api/food/${made.body.id}?version=1`)).status, 409);
});

test('repeating an idempotency key returns the first entry, never a duplicate', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  const body = entry({ idempotency_key: 'meal-2026-10-09-1' });
  const first = await a('POST', '/api/food', { body });
  const again = await a('POST', '/api/food', { body });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  const reuse = await a('POST', '/api/food', { body: { ...body, calories: 999 } });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.code, 'idempotency-key-reuse');
  // Keys are per profile: B may use the same one.
  assert.equal((await h.as('u_food_b')('POST', '/api/food', { body })).status, 201);
  const list = await a('GET', '/api/food?from=2026-10-09&to=2026-10-09');
  assert.equal(list.body.items.length, 1);
});

test("another profile's entry answers 404, never 403", async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a'), b = h.as('u_food_b');
  const made = await a('POST', '/api/food', { body: entry() });
  assert.equal((await b('GET', `/api/food/${made.body.id}`)).status, 404);
  assert.equal((await b('PUT', `/api/food/${made.body.id}`, { body: { version: 1, calories: 1 } })).status, 404);
  assert.equal((await b('DELETE', `/api/food/${made.body.id}`)).status, 404);
  assert.equal((await b('GET', '/api/food?from=2026-10-01&to=2026-10-31')).body.items.length, 0);
  assert.equal((await b('GET', '/api/food/summary?from=2026-10-01&to=2026-10-31')).body.totals.entries, 0);
  assert.equal((await a('GET', `/api/food/${made.body.id}`)).body.calories, 300, 'and A still has it untouched');
});

test('no session, no food', async t => {
  const h = await startFoodServer(t);
  assert.equal((await h.call('GET', '/api/food?from=2026-10-01&to=2026-10-31')).status, 401);
  assert.equal((await h.call('POST', '/api/food', { body: entry() })).status, 401);
  assert.equal((await h.call('GET', '/api/food/goals')).status, 401);
  assert.equal((await h.as('u_food_off')('GET', '/api/food/goals')).status, 401, 'disabled profile');
});

test('food is stored in the normal profile state file and generic sync cannot replace it', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  const made = await a('POST', '/api/food', { body: entry({ idempotency_key: 'state-test' }) });
  const file = JSON.parse((await import('node:fs')).readFileSync(`${h.dataDir}/state-u_food_a.json`, 'utf8'));
  assert.equal(file.foodLogs[0].id, made.body.id);
  assert.equal(file.foodLogs[0].idempotency_hash.length, 64);
  assert.equal(file._rev, 4, 'the normal whole-state revision advances');

  const publicState = await a('GET', '/api/data');
  assert.equal(publicState.status, 200);
  assert.equal(publicState.body.state.foodLogs, undefined, 'food is server-managed, not a stale client snapshot');
  assert.equal(publicState.body.state.nutritionGoals, undefined);

  // Even a crafted app-state push cannot replace or inject the food-owned fields.
  const pushed = await a('PUT', '/api/data', { body: {
    baseRev: publicState.body.rev,
    state: { unit: 'lb', routines: [], workouts: [], foodLogs: [], nutritionGoals: { calories: 1 } }
  } });
  assert.equal(pushed.status, 200);
  assert.equal((await a('GET', `/api/food/${made.body.id}`)).body.id, made.body.id);
  assert.equal((await a('GET', '/api/food/goals')).body.goals, null);
  assert.equal((await a('GET', '/api/data')).body.state.foodLogs, undefined);
});

test('paging walks the whole range in order', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  for (let i = 0; i < 5; i++) await a('POST', '/api/food', { body: entry({ date: `2026-10-0${i + 1}`, name: 'n' + i }) });
  const p1 = await a('GET', '/api/food?from=2026-10-01&to=2026-10-31&limit=2');
  assert.deepEqual(p1.body.items.map(x => x.name), ['n0', 'n1']);
  const p2 = await a('GET', `/api/food?from=2026-10-01&to=2026-10-31&limit=2&cursor=${p1.body.next_cursor}`);
  const p3 = await a('GET', `/api/food?from=2026-10-01&to=2026-10-31&limit=2&cursor=${p2.body.next_cursor}`);
  assert.deepEqual([...p2.body.items, ...p3.body.items].map(x => x.name), ['n2', 'n3', 'n4']);
  assert.equal(p3.body.next_cursor, null);
});

test('goals and the summary', async t => {
  const h = await startFoodServer(t);
  const a = h.as('u_food_a');
  assert.deepEqual((await a('GET', '/api/food/goals')).body, { goals: null });
  assert.equal((await a('PUT', '/api/food/goals', { body: { calories: 0 } })).status, 400);
  assert.equal((await a('PUT', '/api/food/goals', { body: { kcal: 2000 } })).status, 400);
  const set = await a('PUT', '/api/food/goals', { body: { calories: 2400, protein_g: 160 } });
  assert.equal(set.status, 200);
  assert.equal(set.body.goals.calories, 2400);
  assert.equal(set.body.goals.carbs_g, null);

  await a('POST', '/api/food', { body: entry({ date: '2026-10-08', calories: 500, protein_g: 30 }) });
  await a('POST', '/api/food', { body: entry({ date: '2026-10-09', calories: 700.25, protein_g: 40 }) });
  await a('POST', '/api/food', { body: entry({ date: '2026-10-09', name: 'Coffee', calories: undefined, protein_g: undefined, carbs_g: undefined, fat_g: undefined }) });
  const s = await a('GET', '/api/food/summary?from=2026-10-08&to=2026-10-09');
  assert.equal(s.status, 200);
  assert.equal(s.body.days_logged, 2);
  assert.equal(s.body.totals.entries, 3);
  assert.equal(s.body.totals.calories, 1200.3);
  assert.equal(s.body.days[1].entries_missing_calories, 1);
  assert.equal(s.body.goals.calories, 2400);
});
