/* Create and edit routines inside the profile document (state-<uid>.json).
   The routine id never changes, and an exercise the edit does not name keeps the stored
   object — including its id — so history, preview and 1RM stay pointed at the same lift.
   Writes go through the same revision counter as PUT /api/data. A stale revision writes
   nothing. There is no delete route. */
import crypto from 'node:crypto';
import { libraryHas, LIB_BY_ID } from './coach/core/library.js';

export const ROUTINE_BODY_MAX = 32 * 1024;
const NAME_MAX = 80;
const MAX_ROUTINES = 100;
const MAX_EXERCISES = 40;
const SETS_MAX = 30;
const REPS_MAX = 100;
const WEIGHT_MAX = 2000;
const SEC_MAX = 3600;
const MIN_MAX = 240;
const SPEED_MAX = 60;
const REST_MAX = 15 * 60;
const PYRAMID_MAX = 10;
const SG_MAX = 20;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const BODYWEIGHT_EQ = new Set(['body weight', 'band', 'resistance band']);
const CREATE_KEYS = ['revision', 'name', 'exercises'];
const UPDATE_KEYS = ['revision', 'routine_id', 'name', 'exercises'];
const EX_KEYS = ['id', 'position', 'mode', 'sets', 'reps', 'weight', 'pyramid', 'pyramid_rest_sec', 'pyramid_weight', 'sec', 'min', 'speed', 'rest_sec', 'superset_group', 'superset_with'];

export class RoutineInputError extends Error {
  constructor(message, field, code, status = 400) {
    super(message);
    this.field = field;
    this.reason = code;
    this.status = status;
  }
}
const fail = (message, field, code, status) => { throw new RoutineInputError(message, field, code, status); };

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const round2 = v => Math.round(v * 100) / 100;
const routinesOf = state => (Array.isArray(state.routines) ? state.routines : []);

function rejectUnknown(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('expected an object', null, 'unknown-field');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail('unknown field', key, 'unknown-field');
}

function revisionOf(body) {
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail('revision is required', 'revision', 'invalid-revision');
  return body.revision;
}

function checkName(value) {
  if (typeof value !== 'string') fail('name must be text', 'name', 'invalid-name');
  const name = value.trim();
  if (!name || [...name].length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) fail(`name must be 1-${NAME_MAX} characters`, 'name', 'invalid-name');
  return name;
}

function checkExerciseId(value, field) {
  if (typeof value !== 'string' || !value || value.length > 64 || value !== value.trim() || RESERVED.has(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('invalid exercise id', field, 'invalid-id');
  }
  return value;
}

function knownExercise(state, id) {
  if (libraryHas(id)) return LIB_BY_ID.get(id);
  const custom = (Array.isArray(state.customEx) ? state.customEx : []).find(item => item && item.id === id);
  return custom || null;
}

function catalogueMode(info) {
  return info && info.bp === 'cardio' ? 'cardio' : 'reps';
}

function freshExercise(id, info) {
  if (catalogueMode(info) === 'cardio') return { id, sets: 1, min: 20, speed: 8 };
  const bodyweight = BODYWEIGHT_EQ.has(info?.eq) ? { bodyweight: true } : {};
  return { id, sets: 3, reps: 10, weight: 0, mode: 'reps', ...bodyweight };
}

function modeOf(base, raw, info, field) {
  if (raw.mode != null) {
    if (raw.mode !== 'reps' && raw.mode !== 'time' && raw.mode !== 'cardio') fail('mode must be reps, time or cardio', field, 'invalid-mode');
    return raw.mode;
  }
  if (base.mode === 'reps' || base.mode === 'time' || base.mode === 'cardio') return base.mode;
  return catalogueMode(info);
}

function checkPyramid(list, field) {
  if (!Array.isArray(list) || list.length < 1 || list.length > PYRAMID_MAX) fail('invalid pyramid', field, 'invalid-pyramid');
  return list.map(value => {
    if (value === 'max') return 'max';
    if (!Number.isInteger(value) || value < 1 || value > REPS_MAX) fail('invalid pyramid', field, 'invalid-pyramid');
    return value;
  });
}

function alignedNumbers(list, length, field, check) {
  if (!Array.isArray(list) || list.length !== length) fail('invalid pyramid', field, 'invalid-pyramid');
  return list.map(value => {
    if (!check(value)) fail('invalid pyramid', field, 'invalid-pyramid');
    return value;
  });
}

function applyTargets(base, raw, field, info) {
  const where = key => `${field}.${key}`;
  const mode = modeOf(base, raw, info, where('mode'));
  if ('mode' in raw) {
    if (mode === 'time') {
      base.mode = 'time';
      delete base.min; delete base.speed; delete base.reps;
      delete base.pyramid; delete base.pyramidRest; delete base.pyramidWeight;
      if (!('sec' in raw) && !isInt(base.sec, 1, SEC_MAX)) base.sec = 45;
    } else if (mode === 'cardio') {
      base.mode = 'cardio';
      delete base.reps; delete base.sec;
      delete base.pyramid; delete base.pyramidRest; delete base.pyramidWeight;
      if (!('min' in raw) && !(base.min > 0)) base.min = 20;
      if (!('speed' in raw) && !(base.speed > 0)) base.speed = 8;
    } else {
      base.mode = 'reps';
      delete base.sec; delete base.min; delete base.speed;
      if (!('reps' in raw) && !isInt(base.reps, 1, REPS_MAX)) base.reps = 10;
      if (!('weight' in raw) && (typeof base.weight !== 'number' || !Number.isFinite(base.weight))) base.weight = 0;
    }
  }
  if ('sets' in raw) {
    if (!isInt(raw.sets, 1, SETS_MAX)) fail('invalid sets', where('sets'), 'invalid-sets');
    base.sets = raw.sets;
  }
  if ('reps' in raw) {
    if (mode !== 'reps') fail('reps are only valid for reps mode', where('reps'), 'invalid-reps');
    if (!isInt(raw.reps, 1, REPS_MAX)) fail('invalid reps', where('reps'), 'invalid-reps');
    base.reps = raw.reps;
  }
  if ('weight' in raw) {
    if (mode === 'cardio') fail('weight is not valid for cardio', where('weight'), 'invalid-weight');
    if (typeof raw.weight !== 'number' || !Number.isFinite(raw.weight) || raw.weight < 0 || raw.weight > WEIGHT_MAX) fail('invalid weight', where('weight'), 'invalid-weight');
    base.weight = round2(raw.weight);
  }
  if ('sec' in raw) {
    if (mode !== 'time') fail('sec is only valid for time mode', where('sec'), 'invalid-sec');
    if (!isInt(raw.sec, 1, SEC_MAX)) fail('invalid sec', where('sec'), 'invalid-sec');
    base.sec = raw.sec;
  }
  if ('min' in raw) {
    if (mode !== 'cardio') fail('min is only valid for cardio', where('min'), 'invalid-min');
    if (!isInt(raw.min, 1, MIN_MAX)) fail('invalid min', where('min'), 'invalid-min');
    base.min = raw.min;
  }
  if ('speed' in raw) {
    if (mode !== 'cardio') fail('speed is only valid for cardio', where('speed'), 'invalid-speed');
    if (typeof raw.speed !== 'number' || !Number.isFinite(raw.speed) || raw.speed <= 0 || raw.speed > SPEED_MAX) fail('invalid speed', where('speed'), 'invalid-speed');
    base.speed = round2(raw.speed);
  }
  if ('rest_sec' in raw) {
    if (raw.rest_sec == null || raw.rest_sec === 0) delete base.restSec;
    else if (!isInt(raw.rest_sec, 1, REST_MAX)) fail('invalid rest', where('rest_sec'), 'invalid-rest');
    else base.restSec = raw.rest_sec;
  }
  if ('pyramid' in raw) {
    if (raw.pyramid == null) {
      delete base.pyramid; delete base.pyramidRest; delete base.pyramidWeight;
    } else {
      if (mode !== 'reps') fail('invalid pyramid', where('pyramid'), 'invalid-pyramid');
      const list = checkPyramid(raw.pyramid, where('pyramid'));
      if ('sets' in raw && raw.sets !== list.length) fail('invalid pyramid', where('pyramid'), 'invalid-pyramid');
      if (!('pyramid_rest_sec' in raw) && Array.isArray(base.pyramidRest) && base.pyramidRest.length !== list.length) {
        fail('invalid pyramid', where('pyramid_rest_sec'), 'invalid-pyramid');
      }
      if (!('pyramid_weight' in raw) && Array.isArray(base.pyramidWeight) && base.pyramidWeight.length !== list.length) {
        fail('invalid pyramid', where('pyramid_weight'), 'invalid-pyramid');
      }
      base.pyramid = list;
      base.sets = list.length;
      base.mode = 'reps';
      if (!('reps' in raw)) {
        const first = list.find(value => typeof value === 'number');
        if (first != null) base.reps = first;
      }
    }
  }
  const pyramidLength = Array.isArray(base.pyramid) ? base.pyramid.length : 0;
  if ('pyramid_rest_sec' in raw) {
    if (raw.pyramid_rest_sec == null) delete base.pyramidRest;
    else {
      if (!pyramidLength) fail('invalid pyramid', where('pyramid_rest_sec'), 'invalid-pyramid');
      const rest = alignedNumbers(raw.pyramid_rest_sec, pyramidLength, where('pyramid_rest_sec'), value => isInt(value, 0, REST_MAX));
      if (rest.some(value => value > 0)) base.pyramidRest = rest; else delete base.pyramidRest;
    }
  }
  if ('pyramid_weight' in raw) {
    if (raw.pyramid_weight == null) delete base.pyramidWeight;
    else {
      if (!pyramidLength) fail('invalid pyramid', where('pyramid_weight'), 'invalid-pyramid');
      const weights = alignedNumbers(raw.pyramid_weight, pyramidLength, where('pyramid_weight'), value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= WEIGHT_MAX);
      const rounded = weights.map(round2);
      if (rounded.some(value => value > 0)) base.pyramidWeight = rounded; else delete base.pyramidWeight;
    }
  }
  return base;
}

function checkGroup(value, field) {
  if (typeof value !== 'string') fail('invalid superset', field, 'invalid-superset');
  const group = value.trim();
  if (!group || [...group].length > SG_MAX || /[\u0000-\u001f\u007f]/.test(group)) fail('invalid superset', field, 'invalid-superset');
  return group;
}

function clearSuperset(exercise) {
  delete exercise.sg;
  delete exercise.sgName;
  delete exercise.sgRest;
}

function applySupersets(built, incoming) {
  const at = new Map();
  built.forEach((exercise, index) => {
    const hits = at.get(exercise.id) || [];
    hits.push(index);
    at.set(exercise.id, hits);
  });
  // A group the caller named on this item. An inherited `sg` whose partner was removed is not
  // one of these: that leftover is cleared below, the way the editor's cleanupSg drops it.
  const explicit = new Array(incoming.length).fill(null);
  incoming.forEach((raw, index) => {
    if (!('superset_group' in raw)) return;
    if (raw.superset_group == null) { clearSuperset(built[index]); return; }
    built[index].sg = checkGroup(raw.superset_group, `exercises.${index}.superset_group`);
    explicit[index] = 'superset_group';
  });
  const retarget = (from, to) => { for (const exercise of built) if (exercise.sg === from) exercise.sg = to; };
  incoming.forEach((raw, index) => {
    if (!('superset_with' in raw)) return;
    if (raw.superset_with == null) { clearSuperset(built[index]); explicit[index] = null; return; }
    const target = raw.superset_with;
    const where = `exercises.${index}.superset_with`;
    const others = (typeof target === 'string' ? (at.get(target) || []) : []).filter(hit => hit !== index);
    if (typeof target !== 'string' || others.length === 0) {
      fail('superset points at an exercise that is not in this routine', where, 'bad-superset');
    }
    if (others.length > 1) fail('superset target matches more than one exercise', where, 'ambiguous-superset');
    const other = built[others[0]];
    const group = ('superset_group' in raw && raw.superset_group) || built[index].sg || other.sg
      || ('sg' + crypto.createHash('sha256').update(`${index}\0${others[0]}`).digest('hex').slice(0, 10));
    if (built[index].sg && built[index].sg !== group) retarget(built[index].sg, group);
    if (other.sg && other.sg !== group) retarget(other.sg, group);
    built[index].sg = group;
    other.sg = group;
    explicit[index] = explicit[index] || 'superset_with';
  });
  const counts = new Map();
  for (const exercise of built) if (exercise.sg) counts.set(exercise.sg, (counts.get(exercise.sg) || 0) + 1);
  built.forEach((exercise, index) => {
    if (!exercise.sg || counts.get(exercise.sg) >= 2) return;
    if (explicit[index]) {
      fail('superset points at an exercise that is not in this routine', `exercises.${index}.${explicit[index]}`, 'bad-superset');
    }
    clearSuperset(exercise);
  });
  // The app only keeps a superset whose members sit next to each other (cleanupSg). A link
  // with something between its members is dropped the next time the editor saves, so refuse it.
  const groups = new Map();
  built.forEach((exercise, index) => {
    if (!exercise.sg) return;
    const list = groups.get(exercise.sg) || [];
    list.push(index);
    groups.set(exercise.sg, list);
  });
  for (const indexes of groups.values()) {
    const together = indexes.every((value, i) => i === 0 || value === indexes[i - 1] + 1);
    if (together && indexes.length >= 2) continue;
    const offender = indexes.find(index => explicit[index]) ?? indexes[0];
    const key = explicit[offender] || 'superset_group';
    fail('superset members must be next to each other', `exercises.${offender}.${key}`, 'nonadjacent-superset');
  }
}

function buildExercises(storedList, incoming, state) {
  if (!Array.isArray(incoming) || incoming.length < 1) fail('routine must contain at least one exercise', 'exercises', 'empty-routine');
  if (incoming.length > MAX_EXERCISES) fail('too many exercises', 'exercises', 'too-many-exercises');
  const stored = Array.isArray(storedList) ? storedList : [];
  const prepared = incoming.map((raw, index) => {
    const field = `exercises.${index}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid exercise', field, 'invalid-exercise');
    rejectUnknown(raw, EX_KEYS);
    const id = checkExerciseId(raw.id, `${field}.id`);
    const info = knownExercise(state, id);
    if (!info) fail('exercise is not in the library', `${field}.id`, 'not-in-library');
    return { raw, id, info, field };
  });
  // The app has no per-slot id. Two copies of one exercise are two entries, told apart by
  // their place in the list (`position` from get_routine, 1-based). A claimed position keeps
  // that entry. An item with no position takes the next unmatched entry of the same id, in
  // stored order, so an edit that resends the copies in order keeps each copy's own fields.
  const used = new Set();
  const claimed = new Array(prepared.length).fill(null);
  prepared.forEach((item, index) => {
    if (!('position' in item.raw) || item.raw.position == null) return;
    const where = `${item.field}.position`;
    if (!isInt(item.raw.position, 1, Math.max(stored.length, 1)) || item.raw.position > stored.length) {
      fail('position does not match an exercise in this routine', where, 'bad-position');
    }
    const at = item.raw.position - 1;
    if (used.has(at)) fail('position is already used by another exercise', where, 'bad-position');
    const slot = stored[at];
    if (!slot || slot.id !== item.id) fail('position does not match an exercise in this routine', where, 'bad-position');
    used.add(at);
    claimed[index] = slot;
  });
  const takeNext = id => {
    for (let i = 0; i < stored.length; i++) {
      if (used.has(i) || !stored[i] || stored[i].id !== id) continue;
      used.add(i);
      return stored[i];
    }
    return null;
  };
  const built = prepared.map((item, index) => {
    const slot = claimed[index] || takeNext(item.id);
    // A copy, never the stored object: planning has to leave the document untouched until
    // the revision check has passed, and a superset link may set `sg` on a neighbour.
    const base = slot ? { ...slot, id: slot.id } : freshExercise(item.id, item.info);
    return applyTargets(base, item.raw, item.field, item.info);
  });
  applySupersets(built, incoming);
  return built;
}

function requireRoutines(state) {
  if (state.routines != null && !Array.isArray(state.routines)) fail('routines are unreadable', 'routines', 'unreadable');
}

/** The next routine object for an in-place edit. Does not mutate `state`. */
export function planRoutineUpdate(state, body) {
  rejectUnknown(body, UPDATE_KEYS);
  revisionOf(body);
  if (typeof body.routine_id !== 'string' || !body.routine_id || body.routine_id.length > 64 || RESERVED.has(body.routine_id)) {
    fail('no routine with that id', 'routine_id', 'unknown-routine', 404);
  }
  if (!('name' in body) && !('exercises' in body)) fail('nothing to update', null, 'nothing-to-update');
  requireRoutines(state);
  const routines = routinesOf(state);
  const index = routines.findIndex(routine => routine && routine.id === body.routine_id);
  if (index < 0) fail('no routine with that id', 'routine_id', 'unknown-routine', 404);
  const current = routines[index];
  const next = { ...current, id: current.id };
  if ('name' in body) next.name = checkName(body.name);
  if ('exercises' in body) next.ex = buildExercises(current.ex, body.exercises, state);
  return { index, routine: next };
}

/** A new routine object. Does not mutate `state`. */
export function planRoutineCreate(state, body) {
  rejectUnknown(body, CREATE_KEYS);
  revisionOf(body);
  requireRoutines(state);
  const routines = routinesOf(state);
  if (routines.length >= MAX_ROUTINES) fail('too many routines', 'name', 'too-many-routines');
  const name = checkName(body.name);
  const exercises = buildExercises([], body.exercises, state);
  const used = new Set(routines.map(routine => routine && routine.id));
  let id = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = 'r' + crypto.randomBytes(8).toString('hex');
    if (!used.has(candidate)) { id = candidate; break; }
  }
  if (!id) fail('could not assign a routine id', 'routine_id', 'unavailable', 500);
  return { id, name, ex: exercises };
}

function view(routine, revision, created) {
  return {
    ok: true,
    created,
    revision,
    routine_id: routine.id,
    name: routine.name,
    exercise_ids: (routine.ex || []).map(exercise => exercise.id)
  };
}

export function routineRoutes({ json, readBody, readSession, readState, writeState, stampState, writeLimit }) {
  const failResponse = (res, error) => json(res, error.status || 400, {
    error: error.message, code: error.reason, ...(error.field ? { field: error.field } : {})
  });
  const conflict = (res, state) => json(res, 409, { error: 'revision conflict', code: 'revision-conflict', revision: Number(state._rev) || 0 });
  const opened = (req, res) => {
    const user = readSession(req);
    if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
    const state = readState(user.id) || {};
    return { user, state };
  };
  // Validation has already succeeded and the revision still matches. Stamp the pre-image, then write.
  const save = (res, user, state, prior, routine, status) => {
    const wait = writeLimit.take(user.id);
    if (wait) return json(res, 429, { error: 'too many changes', retryAfter: wait }, { 'Retry-After': String(wait) });
    stampState(prior, state);
    writeState(user.id, state);
    json(res, status, view(routine, state._rev, status === 201));
  };

  return {
    'POST /api/routines': async (req, res) => {
      const body = await readBody(req, ROUTINE_BODY_MAX);
      const openedState = opened(req, res);
      if (!openedState) return;
      const { user, state } = openedState;
      let routine;
      try { routine = planRoutineCreate(state, body); }
      catch (error) { if (error instanceof RoutineInputError) return failResponse(res, error); throw error; }
      if ((Number(state._rev) || 0) !== body.revision) return conflict(res, state);
      const prior = structuredClone(state);
      state.routines = [...routinesOf(state), routine];
      save(res, user, state, prior, routine, 201);
    },

    'PUT /api/routines': async (req, res) => {
      const body = await readBody(req, ROUTINE_BODY_MAX);
      const openedState = opened(req, res);
      if (!openedState) return;
      const { user, state } = openedState;
      let planned;
      try { planned = planRoutineUpdate(state, body); }
      catch (error) { if (error instanceof RoutineInputError) return failResponse(res, error); throw error; }
      if ((Number(state._rev) || 0) !== body.revision) return conflict(res, state);
      const prior = structuredClone(state);
      const routines = routinesOf(state).slice();
      routines[planned.index] = planned.routine;
      state.routines = routines;
      save(res, user, state, prior, planned.routine, 200);
    }
  };
}
