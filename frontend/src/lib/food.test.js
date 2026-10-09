import { describe, expect, it, vi, afterEach } from 'vitest'

vi.mock('./api.js', () => ({ api: vi.fn() }))
import { api } from './api.js'
import { createFood, deleteFood, foodSummary, goalProgress, groupMeals, listFood, saveFoodGoals, totalsOf, updateFood } from './food.js'

afterEach(() => vi.clearAllMocks())

describe('food API helpers', () => {
  it('encodes dates and calls the authenticated food routes', async () => {
    api.mockResolvedValue({ items: [] })
    await listFood({ from: '2026-10-01', to: '2026-10-09', limit: 25, cursor: '25' })
    expect(api).toHaveBeenCalledWith('/api/food?from=2026-10-01&to=2026-10-09&limit=25&cursor=25')
    await foodSummary({ from: '2026-10-01', to: '2026-10-09' })
    expect(api).toHaveBeenCalledWith('/api/food/summary?from=2026-10-01&to=2026-10-09')
    await createFood({ name: 'Oats' })
    expect(api).toHaveBeenCalledWith('/api/food', { method: 'POST', body: '{"name":"Oats"}' })
    await updateFood('id /', { version: 1 })
    expect(api).toHaveBeenLastCalledWith('/api/food/id%20%2F', { method: 'PUT', body: '{"version":1}' })
    await deleteFood('id', 2)
    expect(api).toHaveBeenLastCalledWith('/api/food/id?version=2', { method: 'DELETE' })
    await saveFoodGoals({ calories: 2200 })
    expect(api).toHaveBeenLastCalledWith('/api/food/goals', { method: 'PUT', body: '{"calories":2200}' })
  })
})

describe('food calculations', () => {
  it('totals known macros and counts missing calorie data', () => {
    expect(totalsOf([
      { calories: 100, protein_g: 10, carbs_g: 20, fat_g: 5 },
      { calories: null, protein_g: 2.25, carbs_g: null }
    ])).toEqual({ entries: 2, calories: 100, protein_g: 12.3, carbs_g: 20, fat_g: 5, entries_missing_calories: 1 })
  })

  it('clamps goal bars but keeps totals and over-goal state accurate', () => {
    expect(goalProgress(1200, 2400)).toEqual({ total: 1200, goal: 2400, fraction: 0.5, exceeded: false })
    expect(goalProgress(2600, 2400)).toEqual({ total: 2600, goal: 2400, fraction: 1, exceeded: true })
    expect(goalProgress(0, null)).toEqual({ total: 0, goal: null, fraction: null, exceeded: false })
  })

  it('groups in meal order and omits empty meals', () => {
    expect(groupMeals([{ meal: 'snack' }, { meal: 'breakfast' }, { meal: 'snack' }, { meal: 'other' }]))
      .toEqual([{ meal: 'breakfast', entries: [{ meal: 'breakfast' }] }, { meal: 'snack', entries: [{ meal: 'snack' }, { meal: 'snack' }] }])
  })
})
