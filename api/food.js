/* Food log + nutrition goal routes. Bodies are checked against a strict allowlist before
   anything reaches food-db.js; `source` is decided by how the caller authenticated, never by
   the body. Another profile's entry is answered exactly like a missing one (404). */
import { FOOD_FIELDS, GOAL_FIELDS } from './food-store.js';

export const FOOD_BODY_MAX = 16 * 1024;
export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
export const UNITS = ['g', 'ml', 'piece', 'serving', 'cup', 'tbsp', 'tsp', 'oz'];
export const LIMITS = {
  name: 120, notes: 500, quantity: 10000, calories: 20000, macro: 2000,
  rangeDays: 366, pageMax: 200, pageDefault: 100, idempotencyKey: 100
};
const NUMBER_MAX = { quantity: LIMITS.quantity, calories: LIMITS.calories, protein_g: LIMITS.macro, carbs_g: LIMITS.macro, fat_g: LIMITS.macro };
const REQUIRED = ['date', 'meal', 'name'];
const DAY_MS = 86400000;

export class FoodInputError extends Error {
  constructor(message, field) { super(message); this.field = field; }
}
const bad = (message, field) => { throw new FoodInputError(message, field); };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isIsoDate(v) {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY_RE = /^[A-Za-z0-9._:-]+$/;
// Control characters other than newline/tab in notes; none at all in a name.
const CTRL_NAME = /[\u0000-\u001f\u007f]/;
const CTRL_NOTES = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const chars = s => [...s].length;

function checkField(f, v) {
  switch (f) {
    case 'date': if (!isIsoDate(v)) bad('date must be a real YYYY-MM-DD date', f); return v;
    case 'time': if (typeof v !== 'string' || !TIME_RE.test(v)) bad('time must be HH:MM', f); return v;
    case 'meal': if (!MEALS.includes(v)) bad('meal must be one of ' + MEALS.join(', '), f); return v;
    case 'unit': if (!UNITS.includes(v)) bad('unit must be one of ' + UNITS.join(', '), f); return v;
    case 'name': {
      if (typeof v !== 'string') bad('name must be text', f);
      const s = v.trim();
      if (!s || chars(s) > LIMITS.name || CTRL_NAME.test(s)) bad(`name must be 1-${LIMITS.name} characters`, f);
      return s;
    }
    case 'notes': {
      if (typeof v !== 'string') bad('notes must be text', f);
      const s = v.trim();
      if (chars(s) > LIMITS.notes || CTRL_NOTES.test(s)) bad(`notes must be at most ${LIMITS.notes} characters`, f);
      return s || null;
    }
    default: {
      if (typeof v !== 'number' || !Number.isFinite(v)) bad(f + ' must be a number', f);
      if (f === 'quantity' ? (v <= 0 || v > NUMBER_MAX[f]) : (v < 0 || v > NUMBER_MAX[f])) {
        bad(f === 'quantity' ? `quantity must be > 0 and <= ${NUMBER_MAX[f]}` : `${f} must be between 0 and ${NUMBER_MAX[f]}`, f);
      }
      return Math.round(v * 100) / 100;
    }
  }
}

function rejectUnknown(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) bad('unknown field', k);
}

export function validateCreate(body) {
  rejectUnknown(body, [...FOOD_FIELDS, 'idempotency_key']);
  const out = {};
  for (const f of FOOD_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null) {
      if (REQUIRED.includes(f)) bad(f + ' is required', f);
      continue;
    }
    out[f] = checkField(f, v);
  }
  let key = null;
  if (body.idempotency_key !== undefined && body.idempotency_key !== null) {
    key = body.idempotency_key;
    if (typeof key !== 'string' || !key || key.length > LIMITS.idempotencyKey || !KEY_RE.test(key)) {
      bad(`idempotency_key must be 1-${LIMITS.idempotencyKey} of A-Z a-z 0-9 . _ : -`, 'idempotency_key');
    }
  }
  return { data: out, idempotencyKey: key };
}

export function validateUpdate(body) {
  rejectUnknown(body, [...FOOD_FIELDS, 'version']);
  const version = body.version;
  if (!Number.isInteger(version) || version < 1) bad('version is required (the version you last read)', 'version');
  const patch = {};
  for (const f of FOOD_FIELDS) {
    if (!Object.hasOwn(body, f)) continue;
    const v = body[f];
    if (v === null) {
      if (REQUIRED.includes(f)) bad(f + ' cannot be cleared', f);
      patch[f] = null;
    } else patch[f] = checkField(f, v);
  }
  if (!Object.keys(patch).length) bad('nothing to update', null);
  return { version, patch };
}

export function validateGoals(body) {
  rejectUnknown(body, GOAL_FIELDS);
  const out = {};
  for (const f of GOAL_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null) { out[f] = null; continue; }
    const max = f === 'calories' ? LIMITS.calories : LIMITS.macro;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) bad(`${f} must be > 0 and <= ${max}`, f);
    out[f] = Math.round(v * 10) / 10;
  }
  return out;
}

function rangeOf(url, allowed) {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) bad('unknown parameter', k);
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!isIsoDate(from)) bad('from must be a real YYYY-MM-DD date', 'from');
  if (!isIsoDate(to)) bad('to must be a real YYYY-MM-DD date', 'to');
  const span = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS;
  if (span < 0) bad('to must not be before from', 'to');
  if (span + 1 > LIMITS.rangeDays) bad(`a range covers at most ${LIMITS.rangeDays} days`, 'to');
  return { from, to };
}

function intParam(url, name, { min, max, dflt }) {
  const raw = url.searchParams.get(name);
  if (raw === null) return dflt;
  if (!/^\d{1,6}$/.test(raw) || +raw < min || +raw > max) bad(`${name} must be an integer between ${min} and ${max}`, name);
  return +raw;
}

/**
 * The route table entries, keyed like server.js's. `{id}` routes get req.foodId from the
 * dispatcher. `writeLimit` is a rate-limit.js window keyed per profile.
 */
export function foodRoutes({ json, readBody, readSession, food, writeLimit }) {
  const urlOf = req => new URL(req.url, 'http://x');
  const sourceOf = req => (req.service ? 'mcp' : 'ui');
  const fail = (res, e) => {
    if (e instanceof FoodInputError) return json(res, 400, { error: e.message, ...(e.field ? { field: e.field } : {}) });
    throw e;
  };
  const authed = (req, res) => {
    const user = readSession(req);
    if (!user) json(res, 401, { error: 'not signed in' });
    return user;
  };
  const throttled = (res, user) => {
    const wait = writeLimit.take(user.id);
    if (wait) json(res, 429, { error: 'too many changes, try again later', code: 'locked', retryAfter: wait }, { 'Retry-After': String(wait) });
    return wait > 0;
  };
  const conflict = (res, current) => json(res, 409, { error: 'version conflict', code: 'version-conflict', current });

  return {
    'GET /api/food': async (req, res) => {
      const user = authed(req, res); if (!user) return;
      try {
        const url = urlOf(req);
        const { from, to } = rangeOf(url, ['from', 'to', 'limit', 'cursor']);
        const limit = intParam(url, 'limit', { min: 1, max: LIMITS.pageMax, dflt: LIMITS.pageDefault });
        const offset = intParam(url, 'cursor', { min: 0, max: 100000, dflt: 0 });
        json(res, 200, food.list(user.id, { from, to, limit, offset }));
      } catch (e) { fail(res, e); }
    },

    'POST /api/food': async (req, res) => {
      const user = authed(req, res); if (!user) return;
      const body = await readBody(req, FOOD_BODY_MAX);
      let input;
      try { input = validateCreate(body); } catch (e) { return fail(res, e); }
      if (throttled(res, user)) return;
      const r = food.create(user.id, input.data, { source: sourceOf(req), idempotencyKey: input.idempotencyKey });
      if (r.conflict) return json(res, 409, { error: 'idempotency key already used for a different entry', code: 'idempotency-key-reuse' });
      json(res, r.replay ? 200 : 201, r.item);
    },

    'GET /api/food/summary': async (req, res) => {
      const user = authed(req, res); if (!user) return;
      try {
        const { from, to } = rangeOf(urlOf(req), ['from', 'to']);
        json(res, 200, food.summary(user.id, from, to));
      } catch (e) { fail(res, e); }
    },

    'GET /api/food/goals': async (req, res) => {
      const user = authed(req, res); if (!user) return;
      json(res, 200, { goals: food.getGoals(user.id) });
    },

    'PUT /api/food/goals': async (req, res) => {
      const user = authed(req, res); if (!user) return;
      const body = await readBody(req, FOOD_BODY_MAX);
      let goals;
      try { goals = validateGoals(body); } catch (e) { return fail(res, e); }
      if (throttled(res, user)) return;
      json(res, 200, { goals: food.setGoals(user.id, goals) });
    },

    'GET /api/food/{id}': async (req, res) => {
      const user = authed(req, res); if (!user) return;
      const item = food.get(user.id, req.foodId);
      if (!item) return json(res, 404, { error: 'not found' });
      json(res, 200, item);
    },

    'PUT /api/food/{id}': async (req, res) => {
      const user = authed(req, res); if (!user) return;
      const body = await readBody(req, FOOD_BODY_MAX);
      let input;
      try { input = validateUpdate(body); } catch (e) { return fail(res, e); }
      if (throttled(res, user)) return;
      const r = food.update(user.id, req.foodId, input.version, input.patch);
      if (r.missing) return json(res, 404, { error: 'not found' });
      if (r.conflict) return conflict(res, r.conflict);
      json(res, 200, r.item);
    },

    'DELETE /api/food/{id}': async (req, res) => {
      const user = authed(req, res); if (!user) return;
      let version = null;
      try {
        const url = urlOf(req);
        for (const k of url.searchParams.keys()) if (k !== 'version') bad('unknown parameter', k);
        if (url.searchParams.has('version')) version = intParam(url, 'version', { min: 1, max: 999999, dflt: null });
      } catch (e) { return fail(res, e); }
      if (throttled(res, user)) return;
      const r = food.remove(user.id, req.foodId, version);
      if (r === 'missing') return json(res, 404, { error: 'not found' });
      if (r.conflict) return conflict(res, r.conflict);
      json(res, 200, { ok: true });
    }
  };
}
