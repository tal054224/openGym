/* Routine create/update: in-place ids, revision conflicts, and nothing else in the profile moves. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFoodServer } from './food-helpers.mjs';
import { LIB_BY_ID } from '../coach/core/library.js';

const BENCH = '0025';
const ROW = '0007';
const SITUP = '0001';
const PRESS = '0002';

const bench = { id: BENCH, sets: 3, reps: 8, weight: 60, note: 'pause', warmupSets: [{ weight: 40, reps: 5 }], restSec: 90 };
const row = { id: ROW, sets: 3, reps: 10, weight: 20, sg: 'arms' };
const situp = { id: SITUP, sets: 3, reps: 12, weight: 0, mode: 'reps', bodyweight: true, sg: 'arms', pyramid: [12, 10, 8], pyramidRest: [60, 0, 90] };
const pull = { id: 'pull', name: 'Pull', emoji: '💪', prog: 'linear', ex: [{ id: PRESS, sets: 4, reps: 8, weight: 40, inc: 2.5 }] };

const profile = {
  _rev: 7,
  unit: 'kg',
  restSec: 90,
  routines: [
    { id: 'push', name: 'Push', emoji: '🏋️', prog: 'linear', excludeFromProgression: false, ex: [bench, row, situp] },
    pull
  ],
  week: { 1: 'push', 3: 'pull' },
  dayPlan: { '2026-10-29': 'push' },
  queue: { ids: ['push', 'pull'], since: 1, startsOn: '2026-10-27', label: 'Week A' },
  workouts: [{ id: 'w1', d: '2026-10-20', start: 1, end: 2, routineId: 'push', name: 'Push', entries: [{ id: BENCH, sets: [{ w: 60, r: 8, done: true }] }] }],
  bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }],
  foodLogs: [{ id: 'f1', date: '2026-10-09', meal: 'lunch', name: 'Rice', calories: 640, version: 1 }],
  nutritionGoals: { calories: 2200, protein_g: 140, carbs_g: null, fat_g: null },
  customEx: [{ id: 'cx1', n: 'Cable thing', bp: 'back' }],
  measurementGoals: { waist: 80 },
  targetW: 75
};

const BOOK = new Set(['_rev', '_wid', '_wids', '_ts', '_prior', '_unstamped', 'edited', 'deleted', 'undone']);

function domain(state) {
  const out = {};
  for (const [key, value] of Object.entries(state)) if (key !== 'routines' && !BOOK.has(key)) out[key] = value;
  return out;
}

test('editing a routine keeps its id and leaves the rest of the profile byte-identical', async t => {
  assert.equal(LIB_BY_ID.has(BENCH), true);
  assert.equal(LIB_BY_ID.has(ROW), true);
  assert.equal(LIB_BY_ID.has(SITUP), true);
  const server = await startFoodServer(t);
  const file = path.join(server.dataDir, 'state-u_food_a.json');
  fs.writeFileSync(file, JSON.stringify(profile));
  const service = server.svc('u_food_a');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const bytes = () => fs.readFileSync(file);
  const original = bytes();

  const rejected = [
    ['PUT', { routine_id: 'missing', revision: 7, name: 'Nope' }, 404, 'unknown-routine'],
    ['PUT', { routine_id: 'push', revision: 7, name: 'Push', workouts: [] }, 400, 'unknown-field'],
    ['PUT', { routine_id: 'push', revision: 7, exercises: [] }, 400, 'empty-routine'],
    ['PUT', { routine_id: 'push', revision: 7 }, 400, 'nothing-to-update'],
    ['PUT', { routine_id: 'push', revision: 7, exercises: [{ id: 'not-a-lift', sets: 3 }] }, 400, 'not-in-library'],
    ['PUT', { routine_id: 'push', revision: 7, exercises: [{ id: BENCH, pyramid: [12, 0, 8] }, { id: ROW }, { id: SITUP }] }, 400, 'invalid-pyramid'],
    ['PUT', { routine_id: 'push', revision: 7, exercises: [{ id: BENCH, pyramid: [12, 10, 'max'], pyramid_rest_sec: [30] }, { id: ROW }, { id: SITUP }] }, 400, 'invalid-pyramid'],
    ['PUT', { routine_id: 'push', revision: 7, exercises: [{ id: BENCH, superset_with: 'not-in-this-routine' }, { id: ROW }, { id: SITUP }] }, 400, 'bad-superset'],
    ['PUT', { routine_id: 'push', revision: 7, exercises: [{ id: BENCH }, { id: ROW }] }, 400, 'bad-superset'],
    ['PUT', { routine_id: 'push', revision: 6, name: 'Stale' }, 409, 'revision-conflict'],
    ['POST', { revision: 7, name: '   ', exercises: [{ id: SITUP }] }, 400, 'invalid-name'],
    ['POST', { revision: 7, name: 'Arms', exercises: [{ id: 'nope' }] }, 400, 'not-in-library'],
    ['POST', { revision: 7, name: 'Arms', exercises: [], extra: true }, 400, 'unknown-field'],
    ['POST', { revision: 7, name: 'Arms' }, 400, 'empty-routine']
  ];
  for (const [method, body, status, code] of rejected) {
    const response = await service(method, '/api/routines', { body });
    assert.equal(response.status, status, `${method} ${code} -> ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, code);
    assert.deepEqual(bytes(), original, `${code} wrote the profile`);
  }

  const renamed = await service('PUT', '/api/routines', { body: {
    routine_id: 'push', revision: 7, name: 'Push heavy',
    exercises: [{ id: BENCH, sets: 4 }, { id: ROW }, { id: SITUP }]
  } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.routine_id, 'push');
  assert.deepEqual(renamed.body.exercise_ids, [BENCH, ROW, SITUP]);
  assert.equal(renamed.body.revision, 8);

  const saved = read();
  assert.deepEqual(domain(saved), domain(profile));
  assert.equal(JSON.stringify(saved.workouts), JSON.stringify(profile.workouts));
  assert.equal(JSON.stringify(saved.week), JSON.stringify(profile.week));
  assert.equal(JSON.stringify(saved.dayPlan), JSON.stringify(profile.dayPlan));
  assert.equal(JSON.stringify(saved.queue), JSON.stringify(profile.queue));
  assert.equal(JSON.stringify(saved.foodLogs), JSON.stringify(profile.foodLogs));
  assert.equal(JSON.stringify(saved.nutritionGoals), JSON.stringify(profile.nutritionGoals));
  assert.equal(JSON.stringify(saved.routines[1]), JSON.stringify(pull));
  const push = saved.routines[0];
  assert.equal(push.id, 'push');
  assert.equal(push.name, 'Push heavy');
  assert.equal(push.emoji, '🏋️');
  assert.equal(push.prog, 'linear');
  assert.equal(push.ex[0].id, BENCH);
  assert.equal(push.ex[0].sets, 4);
  assert.equal(push.ex[0].reps, 8);
  assert.equal(push.ex[0].note, 'pause');
  assert.deepEqual(push.ex[0].warmupSets, bench.warmupSets);
  assert.equal(push.ex[0].restSec, 90);
  assert.equal(JSON.stringify(push.ex[1]), JSON.stringify(row));
  assert.equal(JSON.stringify(push.ex[2]), JSON.stringify(situp));
  assert.equal(saved._rev, 8);

  const afterEdit = bytes();
  const stale = await service('PUT', '/api/routines', { body: { routine_id: 'push', revision: 7, name: 'Too late' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'revision-conflict');
  assert.equal(stale.body.revision, 8);
  assert.deepEqual(bytes(), afterEdit);

  const other = await server.svc('u_food_b')('PUT', '/api/routines', { body: { routine_id: 'push', revision: 0, name: 'Stolen' } });
  assert.equal(other.status, 404);
  assert.deepEqual(bytes(), afterEdit);

  const created = await service('POST', '/api/routines', { body: {
    revision: 8, name: 'Custom finisher',
    exercises: [{ id: 'cx1', sets: 2, reps: 15 }, { id: SITUP, superset_with: 'cx1' }]
  } });
  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);
  assert.notEqual(created.body.routine_id, 'push');
  assert.deepEqual(created.body.exercise_ids, ['cx1', SITUP]);
  const withNew = read();
  assert.equal(withNew.routines.length, 3);
  assert.equal(JSON.stringify(withNew.routines[1]), JSON.stringify(pull));
  assert.equal(withNew.routines[2].id, created.body.routine_id);
  assert.equal(withNew.routines[2].ex[0].id, 'cx1');
  assert.equal(withNew.routines[2].ex[1].id, SITUP);
  assert.ok(withNew.routines[2].ex[0].sg);
  assert.equal(withNew.routines[2].ex[0].sg, withNew.routines[2].ex[1].sg);
  assert.deepEqual(domain(withNew), domain(profile));
  assert.equal(JSON.stringify(withNew.workouts), JSON.stringify(profile.workouts));
  assert.equal(JSON.stringify(withNew.week), JSON.stringify(profile.week));
  assert.equal(JSON.stringify(withNew.queue), JSON.stringify(profile.queue));
  assert.equal(JSON.stringify(withNew.foodLogs), JSON.stringify(profile.foodLogs));
  // The edited routine is still the same object the rename wrote; creation did not rebuild it.
  assert.equal(withNew.routines[0].id, 'push');
  assert.equal(withNew.routines[0].ex[0].id, BENCH);
  assert.equal(withNew.routines[0].ex[0].sets, 4);

  assert.equal((await service('DELETE', '/api/routines', { body: { routine_id: 'push', revision: withNew._rev } })).status, 404);
  assert.equal((await server.call('PUT', '/api/routines', { body: { routine_id: 'push', revision: withNew._rev, name: 'Anon' } })).status, 401);
});

test('parallel routine edits cannot overwrite the same profile revision', async t => {
  const server = await startFoodServer(t);
  const file = path.join(server.dataDir, 'state-u_food_a.json');
  fs.writeFileSync(file, JSON.stringify({ ...profile, routines: [pull] }));
  const service = server.svc('u_food_a');
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => service('PUT', '/api/routines', {
    body: { routine_id: 'pull', revision: 7, name: 'Pull ' + index }
  })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 7);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved._rev, 8);
  assert.equal(saved.routines.length, 1);
  assert.equal(saved.routines[0].id, 'pull');
  assert.equal(JSON.stringify(saved.routines[0].ex), JSON.stringify(pull.ex));
  assert.equal(JSON.stringify(saved.workouts), JSON.stringify(profile.workouts));
  assert.equal(JSON.stringify(saved.week), JSON.stringify(profile.week));
  assert.equal(JSON.stringify(saved.queue), JSON.stringify(profile.queue));
  assert.equal(JSON.stringify(saved.foodLogs), JSON.stringify(profile.foodLogs));
});
