import crypto from 'node:crypto'
import { z } from 'zod'
import { apiCall } from './api-client.js'
import { requestContext } from './request-context.js'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const [y, m, d] = v.split('-').map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  return y >= 2000 && y <= 2100 && parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
}, 'must be a real date (2000-2100)')
const meal = z.enum(['breakfast', 'lunch', 'dinner', 'snack'])
const unit = z.enum(['g', 'ml', 'piece', 'serving', 'cup', 'tbsp', 'tsp', 'oz'])
const quantity = z.number().finite().gt(0).max(10000)
const calorie = z.number().finite().min(0).max(20000)
const macro = z.number().finite().min(0).max(2000)
const key = z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/)
const profile = () => {
  const ctx = requestContext()
  if (!ctx?.profileId) throw Object.assign(new Error('request context unavailable'), { code: 'UNAVAILABLE' })
  return ctx.profileId
}

const foodFields = {
  date,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  meal,
  name: z.string().trim().min(1).max(120),
  quantity: quantity.optional(),
  unit: unit.optional(),
  calories: calorie.optional(),
  protein_g: macro.optional(),
  carbs_g: macro.optional(),
  fat_g: macro.optional(),
  notes: z.string().max(500).optional()
}

export const FOOD_TOOLS = [
  {
    name: 'list_food_logs',
    description: 'List food entries for a local date range, oldest first. Ranges are limited to 366 days; pages contain at most 200 entries.',
    schema: z.object({ from: date, to: date, limit: z.number().int().min(1).max(200).optional(), cursor: z.number().int().min(0).max(100000).optional() }).strict(),
    scope: 'opengym:read',
    readOnly: true,
    handler: ({ from, to, limit = 100, cursor = 0 }) => apiCall(profile(), `/api/food?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}&cursor=${cursor}`)
  },
  {
    name: 'get_food_log',
    description: 'Get one food entry belonging to the authorized openGym profile.',
    schema: z.object({ id: z.string().uuid() }).strict(),
    scope: 'opengym:read',
    readOnly: true,
    handler: ({ id }) => apiCall(profile(), `/api/food/${encodeURIComponent(id)}`)
  },
  {
    name: 'get_nutrition_summary',
    description: 'Get per-day and range calorie and macronutrient totals, missing-calorie counts, and the profile nutrition goals.',
    schema: z.object({ from: date, to: date }).strict(),
    scope: 'opengym:read',
    readOnly: true,
    handler: ({ from, to }) => apiCall(profile(), `/api/food/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  },
  {
    name: 'create_food_log',
    description: 'Manually create a food entry for a local date. Specify any known calories/macros; all nutrition fields are optional.',
    schema: z.object({ ...foodFields, idempotency_key: key.optional() }).strict(),
    scope: 'food:write',
    handler: input => {
      const { idempotency_key, ...data } = input
      return apiCall(profile(), '/api/food', { method: 'POST', body: { ...data, idempotency_key: idempotency_key || crypto.randomUUID() } })
    }
  },
  {
    name: 'update_food_log',
    description: 'Update one food entry using the version from its last read. Send null to clear an optional value.',
    schema: z.object({
      id: z.string().uuid(), version: z.number().int().min(1),
      date: date.optional(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
      meal: meal.optional(), name: z.string().trim().min(1).max(120).optional(),
      quantity: quantity.nullable().optional(), unit: unit.nullable().optional(),
      calories: calorie.nullable().optional(), protein_g: macro.nullable().optional(),
      carbs_g: macro.nullable().optional(), fat_g: macro.nullable().optional(), notes: z.string().max(500).nullable().optional()
    }).strict(),
    scope: 'food:write',
    handler: ({ id, version, ...patch }) => apiCall(profile(), `/api/food/${encodeURIComponent(id)}`, { method: 'PUT', body: { version, ...patch } })
  },
  {
    name: 'delete_food_log',
    description: 'Delete one food entry. This cannot be undone.',
    schema: z.object({ id: z.string().uuid(), version: z.number().int().min(1).optional() }).strict(),
    scope: 'food:write',
    destructive: true,
    handler: ({ id, version }) => apiCall(profile(), `/api/food/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`, { method: 'DELETE' })
  }
]
