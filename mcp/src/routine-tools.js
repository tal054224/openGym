/* Remote routine edits. The API writes state-<uid>.json in place; this process never does. */
import { z } from 'zod'
import { apiCall } from './api-client.js'
import { requestContext } from './request-context.js'

const profile = () => {
  const ctx = requestContext()
  if (!ctx?.profileId) throw Object.assign(new Error('request context unavailable'), { code: 'UNAVAILABLE' })
  return ctx.profileId
}

const exerciseId = z.string().trim().min(1).max(64)
const pyramidTarget = z.union([z.number().int().min(1).max(100), z.literal('max')])
const exercise = z.object({
  id: exerciseId,
  mode: z.enum(['reps', 'time', 'cardio']).optional(),
  sets: z.number().int().min(1).max(30).optional(),
  reps: z.number().int().min(1).max(100).optional(),
  weight: z.number().finite().min(0).max(2000).optional(),
  pyramid: z.array(pyramidTarget).min(1).max(10).nullable().optional(),
  pyramid_rest_sec: z.array(z.number().int().min(0).max(900)).max(10).nullable().optional(),
  pyramid_weight: z.array(z.number().finite().min(0).max(2000)).max(10).nullable().optional(),
  sec: z.number().int().min(1).max(3600).optional(),
  min: z.number().int().min(1).max(240).optional(),
  speed: z.number().finite().gt(0).max(60).optional(),
  rest_sec: z.number().int().min(0).max(900).nullable().optional(),
  superset_group: z.string().trim().min(1).max(20).nullable().optional(),
  superset_with: exerciseId.nullable().optional(),
  // 1-based slot from get_routine. The same catalogue id may occupy two slots; position tells them apart.
  position: z.number().int().min(1).max(200).optional()
}).strict()
const name = z.string().trim().min(1).max(80)
const revision = z.number().int().min(0)

export const ROUTINE_TOOLS = [
  {
    name: 'create_routine',
    description: 'Create a workout routine on the authorized profile. Requires routines:write and the current revision from list_routines or get_routine. The server assigns routine_id. exercises is the full list (at least one); the same catalogue id may appear more than once, as two slots. Each id must be a catalogue exercise or one of the profile\'s custom exercises. Do not send position. A stale revision returns a conflict and writes nothing. Does not schedule the routine onto the week.',
    schema: z.object({ revision, name, exercises: z.array(exercise).min(1).max(40) }).strict(),
    scope: 'routines:write',
    handler: input => apiCall(profile(), '/api/routines', { method: 'POST', body: input })
  },
  {
    name: 'update_routine',
    description: 'Edit one routine in place by routine_id. Requires routines:write and the current revision from list_routines or get_routine; a stale revision returns a conflict and writes nothing. The routine keeps its id. Send name to rename. Send exercises as the full new list to add, remove or reorder. The same catalogue id may appear twice: the app stores those as separate slots, with no id of their own, and get_routine numbers them with position (1-based). Pass that position to keep a specific slot; id must still be the exercise in that slot. Omit position and the item takes the next unmatched slot with the same id, in current order, so resending the copies in order keeps each copy\'s own fields (sets, notes, warm-ups, rest). A slot you never match is removed. An exercise already matched keeps any target you omit. Omitting exercises leaves every exercise untouched. Removing a superset partner clears the leftover member\'s superset, including its name and rest. Superset members must be next to each other in the list; a link with an exercise between them is rejected and field names that input. superset_with must name one other entry in this list; a missing or ambiguous target is rejected the same way. A superset_group you set on only one exercise is rejected the same way. Sending pyramid: null, or switching the exercise to time or cardio, removes the pyramid. There is no way to delete the routine.',
    schema: z.object({
      routine_id: z.string().min(1).max(64),
      revision,
      name: name.optional(),
      exercises: z.array(exercise).min(1).max(40).optional()
    }).strict(),
    scope: 'routines:write',
    handler: input => apiCall(profile(), '/api/routines', { method: 'PUT', body: input })
  }
]
