import crypto from 'node:crypto'
import { z } from 'zod'
import { apiCall } from './api-client.js'
import { requestContext } from './request-context.js'
import { BODY_MEASUREMENT_KEYS } from '../../api/body-model.js'

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
    name: 'set_body_goals',
    description: 'Update weight, waist, neck, hip and body-fat goals. Requires body:write and the current revision from get_body_measurements. Circumferences are centimetres; weight is in the profile weight unit. Omitted goals are retained, null clears a goal.',
    schema: z.object({ revision: z.number().int().min(0), weight: z.number().finite().positive().max(2200).nullable().optional(),
      waist: z.number().finite().positive().max(500).nullable().optional(), neck: z.number().finite().positive().max(500).nullable().optional(),
      hips: z.number().finite().positive().max(500).nullable().optional(), bodyFat: z.number().finite().positive().max(100).nullable().optional() }).strict(),
    scope: 'body:write',
    handler: input => apiCall(profile(), '/api/body/goals', { method: 'PUT', body: input })
  },
  {
    name: 'log_body_weight',
    description: 'Log or update a weigh-in on a local date, optionally with a US Navy body-fat estimate. Weight uses the profile weight unit. Requires body:write and the current revision from get_body_measurements; a stale revision returns a conflict. Existing Navy data is retained when omitted.',
    schema: z.object({ revision: z.number().int().min(0), date, weight: z.number().finite().positive().max(2200),
      navy: z.object({ sex: z.enum(['male', 'female']), unit: z.enum(['cm', 'in']), height: z.number().finite().positive().max(500),
        waist: z.number().finite().positive().max(500), neck: z.number().finite().positive().max(500), hip: z.number().finite().positive().max(500).optional() }).strict().optional() }).strict(),
    scope: 'body:write',
    handler: input => apiCall(profile(), '/api/body/weight', { method: 'POST', body: input })
  },
  {
    name: 'log_body_measurements',
    description: 'Log or update named body measurements for a local date. Circumferences are centimetres; bodyFat is a percentage. Omitted fields retain previous readings; null clears a field. Requires body:write and the revision from get_body_measurements.',
    schema: z.object({ revision: z.number().int().min(0), date,
      other: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), value: z.number().finite().positive().max(500).nullable() }).strict()).max(50).optional(),
      ...Object.fromEntries(BODY_MEASUREMENT_KEYS.map(key => [key, z.number().finite().positive().max(key === 'bodyFat' ? 100 : 500).nullable().optional()])) }).strict(),
    scope: 'body:write',
    handler: input => apiCall(profile(), '/api/body/measurements', { method: 'POST', body: input })
  },
  {
    name: 'set_body_measurement_options',
    description: 'Choose built-in fields and optionally replace the custom measurement definitions. An empty enabled list disables built-in fields without deleting history. Custom fields need a stable id, name and enabled flag. Requires body:write and the revision from get_body_measurements.',
    schema: z.object({ revision: z.number().int().min(0), enabled: z.array(z.enum(BODY_MEASUREMENT_KEYS)).max(BODY_MEASUREMENT_KEYS.length),
      custom: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: z.string().trim().min(1).max(60), enabled: z.boolean() }).strict()).max(50).optional() }).strict(),
    scope: 'body:write',
    handler: input => apiCall(profile(), '/api/body/options', { method: 'PUT', body: input })
  },
  {
    name: 'get_nutrition_goals',
    description: 'Get the authorized profile daily calorie, protein, carbohydrate, and fat goals.',
    schema: z.object({}).strict(),
    scope: 'opengym:read',
    readOnly: true,
    handler: () => apiCall(profile(), '/api/food/goals')
  },
  {
    name: 'set_nutrition_goals',
    description: 'Replace all four daily nutrition goals for the authorized profile. Null or omitted fields clear that goal; include every goal you want to retain.',
    schema: z.object({ calories: calorie.nullable().optional(), protein_g: macro.nullable().optional(), carbs_g: macro.nullable().optional(), fat_g: macro.nullable().optional() }).strict(),
    scope: 'food:write',
    handler: input => apiCall(profile(), '/api/food/goals', { method: 'PUT', body: input })
  },
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
