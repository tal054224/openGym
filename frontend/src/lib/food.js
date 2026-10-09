import { api } from './api.js'

const MACROS = ['calories', 'protein_g', 'carbs_g', 'fat_g']

const query = values => new URLSearchParams(values).toString()
export const listFood = ({ from, to, limit = 100, cursor } = {}) =>
  api('/api/food?' + query({ from, to, limit, ...(cursor == null ? {} : { cursor }) }))
export const foodSummary = ({ from, to } = {}) => api('/api/food/summary?' + query({ from, to }))
export const getFood = id => api('/api/food/' + encodeURIComponent(id))
export const createFood = body => api('/api/food', { method: 'POST', body: JSON.stringify(body) })
export const updateFood = (id, body) => api('/api/food/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) })
export const deleteFood = (id, version) => api('/api/food/' + encodeURIComponent(id) + (version == null ? '' : '?version=' + encodeURIComponent(version)), { method: 'DELETE' })
export const saveFoodGoals = goals => api('/api/food/goals', { method: 'PUT', body: JSON.stringify(goals) })

export function totalsOf(entries = []) {
  const totals = { entries: 0, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, entries_missing_calories: 0 }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    totals.entries++
    if (entry.calories == null) totals.entries_missing_calories++
    for (const key of MACROS) if (typeof entry[key] === 'number' && Number.isFinite(entry[key])) totals[key] += entry[key]
  }
  for (const key of MACROS) totals[key] = Math.round(totals[key] * 10) / 10
  return totals
}

export function goalProgress(total, goal) {
  const n = Number(total) || 0
  const target = Number(goal)
  return {
    total: Math.round(n * 10) / 10,
    goal: Number.isFinite(target) && target > 0 ? target : null,
    fraction: Number.isFinite(target) && target > 0 ? Math.min(1, n / target) : null,
    exceeded: Number.isFinite(target) && target > 0 && n > target
  }
}

export function groupMeals(entries = []) {
  const order = ['breakfast', 'lunch', 'dinner', 'snack']
  const groups = new Map(order.map(meal => [meal, []]))
  for (const entry of entries) if (groups.has(entry?.meal)) groups.get(entry.meal).push(entry)
  return order.map(meal => ({ meal, entries: groups.get(meal) })).filter(x => x.entries.length)
}

export const FOOD_MACROS = MACROS
