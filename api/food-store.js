/* Food records are server-managed fields in the app's existing state-<profile>.json document.
   They are hidden from whole-state client sync and changed only through food routes, so a stale
   workout push cannot overwrite them. The injected write callback uses the normal atomic writer. */
import crypto from 'node:crypto';

export const FOOD_FIELDS = ['date', 'time', 'meal', 'name', 'quantity', 'unit', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'notes'];
export const GOAL_FIELDS = ['calories', 'protein_g', 'carbs_g', 'fat_g'];
const MACROS = ['calories', 'protein_g', 'carbs_g', 'fat_g'];
const clone = v => JSON.parse(JSON.stringify(v));
const round1 = v => Math.round((v || 0) * 10) / 10;
const entryHash = data => crypto.createHash('sha256')
  .update(JSON.stringify(FOOD_FIELDS.map(f => data[f] ?? null))).digest('hex');

export function createFoodStore({ readState, writeState }) {
  function stateOf(profileId) {
    const state = readState(profileId);
    if (state === undefined || state === null) return { foodLogs: [], nutritionGoals: null };
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('profile state is unreadable');
    if (!Array.isArray(state.foodLogs)) state.foodLogs = [];
    return state;
  }
  const itemOf = row => {
    if (!row || typeof row !== 'object') return null;
    const out = {};
    for (const k of ['id', ...FOOD_FIELDS, 'source', 'created_at', 'updated_at', 'version', 'idempotency_key']) {
      if (row[k] !== undefined) out[k] = row[k];
    }
    for (const k of ['time', 'quantity', 'unit', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'notes', 'idempotency_key']) {
      if (!(k in out)) out[k] = null;
    }
    return out;
  };
  const find = (s, id) => s.foodLogs.find(x => x && x.id === id);

  return {
    get(profileId, id) { return itemOf(find(stateOf(profileId), id)); },

    list(profileId, { from, to, limit, offset }) {
      const rows = stateOf(profileId).foodLogs.filter(x => x && x.date >= from && x.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')) ||
          String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id));
      const items = rows.slice(offset, offset + limit).map(itemOf);
      return { items, next_cursor: offset + limit < rows.length ? String(offset + limit) : null };
    },

    create(profileId, data, { source, idempotencyKey = null, now = new Date() }) {
      const state = stateOf(profileId);
      const hash = idempotencyKey ? entryHash(data) : null;
      if (idempotencyKey) {
        const prior = state.foodLogs.find(x => x?.idempotency_key === idempotencyKey);
        if (prior) return prior.idempotency_hash === hash ? { item: itemOf(prior), replay: true } : { conflict: 'idempotency' };
      }
      const stamp = now.toISOString();
      const row = { id: crypto.randomUUID(), ...clone(data), source, created_at: stamp, updated_at: stamp,
        version: 1, idempotency_key: idempotencyKey, ...(hash ? { idempotency_hash: hash } : {}) };
      state.foodLogs.push(row);
      writeState(profileId, state);
      return { item: itemOf(row), replay: false };
    },

    update(profileId, id, version, patch, now = new Date()) {
      const state = stateOf(profileId), row = find(state, id);
      if (!row) return { missing: true };
      if (row.version !== version) return { conflict: itemOf(row) };
      for (const [key, value] of Object.entries(patch)) row[key] = value;
      row.updated_at = now.toISOString();
      row.version++;
      writeState(profileId, state);
      return { item: itemOf(row) };
    },

    remove(profileId, id, version = null) {
      const state = stateOf(profileId), row = find(state, id);
      if (!row) return 'missing';
      if (version != null && row.version !== version) return { conflict: itemOf(row) };
      state.foodLogs = state.foodLogs.filter(x => x?.id !== id);
      writeState(profileId, state);
      return 'deleted';
    },

    summary(profileId, from, to) {
      const rows = stateOf(profileId).foodLogs.filter(x => x && x.date >= from && x.date <= to);
      const byDate = new Map();
      for (const row of rows) {
        let day = byDate.get(row.date);
        if (!day) byDate.set(row.date, day = { date: row.date, entries: 0, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, entries_missing_calories: 0 });
        day.entries++;
        if (row.calories == null) day.entries_missing_calories++;
        for (const m of MACROS) if (row[m] != null) day[m] += row[m];
      }
      const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
        ...d, calories: round1(d.calories), protein_g: round1(d.protein_g), carbs_g: round1(d.carbs_g), fat_g: round1(d.fat_g)
      }));
      const totals = { entries: 0, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
      for (const day of days) { totals.entries += day.entries; for (const m of MACROS) totals[m] = round1(totals[m] + day[m]); }
      return { from, to, days_logged: days.length, totals, days, goals: this.getGoals(profileId) };
    },

    getGoals(profileId) {
      const goals = stateOf(profileId).nutritionGoals;
      if (!goals || typeof goals !== 'object' || Array.isArray(goals)) return null;
      return { ...goals };
    },

    setGoals(profileId, goals, now = new Date()) {
      const state = stateOf(profileId);
      state.nutritionGoals = { ...goals, updated_at: now.toISOString() };
      writeState(profileId, state);
      return this.getGoals(profileId);
    },

    deleteProfile(profileId) {
      const state = stateOf(profileId);
      delete state.foodLogs;
      delete state.nutritionGoals;
      writeState(profileId, state);
    }
  };
}
