import { BODY_MEASUREMENT_KEYS as MEASUREMENT_KEYS, estimateNavyBodyFat } from './body-model.js';

const fail = message => { throw Object.assign(new Error(message), { bodyInput: true }); };
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
  if (Object.keys(value).some(key => !keys.includes(key))) fail('unknown field');
};
const number = (value, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) fail('invalid measurement');
  return value;
};
const dateOf = value => {
  if (typeof value !== 'string' || !/^20\d\d-\d{2}-\d{2}$/.test(value)) fail('invalid date');
  const parsed = new Date(value + 'T12:00:00');
  const today = new Date();
  if (!Number.isFinite(parsed.getTime()) || parsed.getFullYear() !== Number(value.slice(0, 4)) || parsed.getMonth() + 1 !== Number(value.slice(5, 7)) || parsed.getDate() !== Number(value.slice(8, 10)) || parsed > today && value !== `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`) fail('invalid date');
  return value;
};

export function bodyRoutes({ json, readBody, readSession, readState, writeState, stampState, writeLimit }) {
  const route = (keys, mutate) => async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req, 16384);
    try {
      object(body, ['revision', ...keys]);
      if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail('revision is required');
      const wait = writeLimit.take(user.id);
      if (wait) return json(res, 429, { error: 'too many changes', retryAfter: wait }, { 'Retry-After': String(wait) });
      const state = readState(user.id) || {};
      if ((Number(state._rev) || 0) !== body.revision) return json(res, 409, { error: 'revision conflict', revision: Number(state._rev) || 0 });
      const prior = structuredClone(state);
      mutate(state, body);
      stampState(prior, state);
      writeState(user.id, state);
      json(res, 200, { ok: true, revision: state._rev });
    } catch (error) {
      if (error.bodyInput) return json(res, 400, { error: error.message });
      throw error;
    }
  };
  return {
    'PUT /api/body/goals': route(['weight', 'waist', 'neck', 'hips', 'bodyFat'], (state, body) => {
      const goals = { ...state.measurementGoals };
      for (const key of ['waist', 'neck', 'hips', 'bodyFat']) if (key in body) goals[key] = body[key] == null ? null : number(body[key], key === 'bodyFat' ? 100 : 500);
      state.measurementGoals = goals;
      if ('weight' in body) state.targetW = body.weight == null ? null : number(body.weight, state.unit === 'lb' ? 2200 : 1000);
    }),
    'POST /api/body/weight': route(['date', 'weight', 'navy'], (state, body) => {
      const date = dateOf(body.date);
      const weight = number(body.weight, state.unit === 'lb' ? 2200 : 1000);
      let navy;
      if (body.navy != null) {
        object(body.navy, ['sex', 'unit', 'height', 'waist', 'neck', 'hip']);
        for (const key of ['height', 'waist', 'neck']) number(body.navy[key], 500);
        if (body.navy.sex === 'female' || 'hip' in body.navy) number(body.navy.hip, 500);
        const bodyFat = estimateNavyBodyFat(body.navy);
        if (bodyFat == null) fail('invalid Navy measurements');
        navy = { ...body.navy, method: 'us_navy', bodyFat };
      }
      state.bodyweight = [...(state.bodyweight || [])];
      const prior = state.bodyweight.find(entry => entry.d === date);
      const entry = { ...prior, d: date, w: weight, t: Date.now(), ...(navy ? { navy } : {}) };
      state.bodyweight = [...state.bodyweight.filter(item => item.d !== date), entry].sort((left, right) => left.d.localeCompare(right.d));
    }),
    'POST /api/body/measurements': route(['date', 'other', ...MEASUREMENT_KEYS], (state, body) => {
      const date = dateOf(body.date);
      const values = {};
      for (const key of MEASUREMENT_KEYS) if (key in body) values[key] = body[key] == null ? null : number(body[key], key === 'bodyFat' ? 100 : 500);
      if (!Object.keys(values).length && !body.other?.length) fail('at least one measurement is required');
      const measurements = state.measurements || [];
      const prior = measurements.find(entry => entry.d === date);
      const defaults = Object.fromEntries(MEASUREMENT_KEYS.map(key => [key, null]));
      const other = new Map((prior?.other || []).map(field => [field.id, { ...field }]));
      if ('other' in body) {
        if (!Array.isArray(body.other) || body.other.length > 50) fail('invalid custom measurements');
        const ids = new Set();
        for (const field of body.other) {
          object(field, ['id', 'value']);
          const definition = (state.customMeasurements || []).find(item => item.id === field.id);
          if (!definition || ids.has(field.id) || !('value' in field)) fail('invalid custom measurement');
          ids.add(field.id);
          other.set(field.id, { id: field.id, name: definition.name, value: field.value == null ? null : number(field.value, 500) });
        }
      }
      state.measurements = [...measurements.filter(entry => entry.d !== date), { ...defaults, ...prior, other: [...other.values()], ...values, d: date, t: Date.now() }].sort((left, right) => left.d.localeCompare(right.d));
    }),
    'PUT /api/body/options': route(['enabled', 'custom'], (state, body) => {
      if (!Array.isArray(body.enabled) || body.enabled.length > MEASUREMENT_KEYS.length || body.enabled.some(key => !MEASUREMENT_KEYS.includes(key))) fail('invalid measurement options');
      state.measurementEnabled = [...new Set(body.enabled)];
      if ('custom' in body) {
        if (!Array.isArray(body.custom) || body.custom.length > 50) fail('invalid custom measurement options');
        const ids = new Set();
        state.customMeasurements = body.custom.map(field => {
          object(field, ['id', 'name', 'enabled']);
          if (typeof field.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(field.id) || ids.has(field.id) || typeof field.name !== 'string' || !field.name.trim() || field.name.length > 60 || typeof field.enabled !== 'boolean') fail('invalid custom measurement option');
          ids.add(field.id);
          return { id: field.id, name: field.name.trim(), enabled: field.enabled };
        });
      }
    }),
  };
}