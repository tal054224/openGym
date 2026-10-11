import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFoodServer } from './food-helpers.mjs';

test('body writes validate fields, preserve revisions and isolate profiles', async context => {
  const server = await startFoodServer(context);
  const service = server.svc('u_food_a');
  assert.equal((await service('PUT', '/api/body/goals', { body: { revision: 3, waist: 82, neck: 40, weight: 78 } })).status, 200);
  assert.equal((await service('PUT', '/api/body/goals', { body: { revision: 3, waist: 81 } })).status, 409);
  assert.equal((await service('PUT', '/api/body/goals', { body: { revision: 4, profile_id: 'u_food_b', waist: 81 } })).status, 400);
  assert.equal((await service('POST', '/api/body/weight', { body: { revision: 4, date: '2026-02-30', weight: 80 } })).status, 400);
  assert.equal((await service('POST', '/api/body/weight', { body: { revision: 4, date: '2026-10-10', weight: 80, navy: { sex: 'male', unit: 'in', height: 72, waist: 34, neck: 16, hip: {} } } })).status, 400);
  assert.equal((await service('POST', '/api/body/weight', { body: { revision: 4, date: '2026-10-10', weight: 80, navy: { sex: 'male', unit: 'in', height: 72, waist: 34, neck: 16 } } })).status, 200);
  assert.equal((await service('POST', '/api/body/measurements', { body: { revision: 5, date: '2026-10-10', waist: 86, neck: 40 } })).status, 200);
  assert.equal((await service('PUT', '/api/body/options', { body: { revision: 6, enabled: ['waist', 'neck', 'bodyFat'], custom: [{ id: 'knee', name: 'Knee', enabled: true }] } })).status, 200);
  assert.equal((await service('POST', '/api/body/measurements', { body: { revision: 7, date: '2026-10-10', other: [{ id: 'unknown', value: 40 }] } })).status, 400);
  assert.equal((await service('POST', '/api/body/measurements', { body: { revision: 7, date: '2026-10-10', other: [{ id: 'knee', value: 40 }] } })).status, 200);
  const state = (await service('GET', '/api/data')).body.state;
  assert.equal(state._rev, 8);
  assert.equal(state.measurementGoals.waist, 82);
  assert.ok(state.edited.measurementGoals > 0);
  assert.ok(state.edited.targetW > 0);
  assert.equal(state.bodyweight[0].navy.bodyFat, 14.6);
  assert.equal(state.measurements[0].waist, 86);
  assert.deepEqual(state.measurements[0].other, [{ id: 'knee', name: 'Knee', value: 40 }]);
  assert.deepEqual(state.measurementEnabled, ['waist', 'neck', 'bodyFat']);
  assert.equal((await server.svc('u_food_b')('GET', '/api/data')).body.state, null);
  assert.equal((await server.call('PUT', '/api/body/goals', { body: { revision: 7, waist: 80 } })).status, 401);
});

test('parallel body writes cannot overwrite the same profile revision', async context => {
  const server = await startFoodServer(context);
  const service = server.svc('u_food_a');
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => service('POST', '/api/body/weight', {
    body: { revision: 3, date: '2026-10-10', weight: 70 + index },
  })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 9);
  const state = (await service('GET', '/api/data')).body.state;
  assert.equal(state._rev, 4);
  assert.equal(state.bodyweight.length, 1);
});