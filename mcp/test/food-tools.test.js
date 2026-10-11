import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('../src/api-client.js', () => ({ apiCall: vi.fn() }))
import { apiCall } from '../src/api-client.js'
import { buildMcpServer } from '../src/mcp-server.js'
import { runRequestContext } from '../src/request-context.js'

async function connected(scopes, options) {
  const server = buildMcpServer(scopes, options)
  const client = new Client({ name: 'food-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}
afterEach(() => vi.clearAllMocks())

const context = { profileId: 'profile-a', profileName: 'A', scopes: ['opengym:read', 'food:write'], state: { routines: [], workouts: [] } }

describe('MCP food tools', () => {
  it('exposes body writes only with body:write and rejects arbitrary profile fields', async () => {
    const { client, server } = await connected(['body:write'])
    const names = (await client.listTools()).tools.map(tool => tool.name)
    expect(names.sort()).toEqual(['log_body_measurements', 'log_body_weight', 'set_body_goals', 'set_body_measurement_options'].sort())
    await runRequestContext({ ...context, scopes: ['body:write'] }, async () => {
      apiCall.mockResolvedValue({ ok: true, revision: 4 })
      const result = await client.callTool({ name: 'set_body_goals', arguments: { revision: 3, waist: 82 } })
      expect(result.isError).toBeFalsy()
      expect(apiCall).toHaveBeenCalledWith('profile-a', '/api/body/goals', { method: 'PUT', body: { revision: 3, waist: 82 } })
      apiCall.mockClear()
      expect((await client.callTool({ name: 'set_body_goals', arguments: { revision: 4, workouts: [] } })).isError).toBe(true)
      expect(apiCall).not.toHaveBeenCalled()
    })
    await runRequestContext(context, async () => {
      expect((await client.callTool({ name: 'set_body_goals', arguments: { revision: 4, waist: 81 } })).isError).toBe(true)
      expect(apiCall).not.toHaveBeenCalled()
    })
    await client.close(); await server.close()
  })
  it('serves local calculations without OAuth context and keeps API food tools remote-only', async () => {
    const { client, server } = await connected(['opengym:read'], { local: true })
    const names = (await client.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('get_body_measurements')
    expect(names).not.toContain('get_nutrition_goals')
    const result = await client.callTool({ name: 'calculate_navy_body_fat', arguments: { sex: 'male', unit: 'in', height: 72, waist: 34, neck: 16 } })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0].text).body_fat_percent).toBe(14.6)
    await client.close(); await server.close()
  })
  it('exposes read tools to read scope and no write tools without food:write', async () => {
    const { client, server } = await connected(['opengym:read'])
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).toContain('list_food_logs')
    expect(names).toContain('get_nutrition_summary')
    expect(names).not.toContain('create_food_log')
    expect(names).not.toContain('update_food_log')
    expect(names).not.toContain('delete_food_log')
    expect(names).not.toContain('set_nutrition_goals')
    expect(names).toContain('get_body_measurements')
    expect(names).toContain('calculate_navy_body_fat')
    expect(names.filter(n => /create|update|delete/.test(n))).toEqual([])
    await client.close(); await server.close()
  })

  it('exposes only food writes for food:write scope and annotates reads/deletes', async () => {
    const { client, server } = await connected(['food:write'])
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['create_food_log', 'update_food_log', 'delete_food_log']))
    expect(names).toContain('set_nutrition_goals')
    expect(names).not.toContain('list_routines')
    expect(names).not.toContain('list_food_logs')
    await client.close(); await server.close()

    const both = await connected(['opengym:read', 'food:write'])
    const tools = (await both.client.listTools()).tools
    expect(tools.find(t => t.name === 'list_food_logs').annotations.readOnlyHint).toBe(true)
    expect(tools.find(t => t.name === 'get_nutrition_summary').annotations.readOnlyHint).toBe(true)
    expect(tools.find(t => t.name === 'delete_food_log').annotations.destructiveHint).toBe(true)
    await both.client.close(); await both.server.close()
  })

  it('forwards reads/writes only with the request-scoped profile and strict arguments', async () => {
    apiCall.mockResolvedValue({ items: [] })
    const { client, server } = await connected(['opengym:read', 'food:write'])
    await runRequestContext(context, async () => {
      const result = await client.callTool({ name: 'list_food_logs', arguments: { from: '2026-10-01', to: '2026-10-31' } })
      expect(result.isError).toBeFalsy()
      expect(apiCall).toHaveBeenCalledWith('profile-a', '/api/food?from=2026-10-01&to=2026-10-31&limit=100&cursor=0')
      await client.callTool({ name: 'create_food_log', arguments: { date: '2026-10-09', meal: 'breakfast', name: 'Oats', calories: 300 } })
      const [profile, endpoint, options] = apiCall.mock.calls.at(-1)
      expect(profile).toBe('profile-a')
      expect(endpoint).toBe('/api/food')
      expect(options.method).toBe('POST')
      expect(options.body.source).toBeUndefined()
      expect(options.body.idempotency_key).toMatch(/^[A-Za-z0-9-]+$/)
      const invalid = await client.callTool({ name: 'create_food_log', arguments: { date: '2026-10-09', meal: 'brunch', name: 'Oats' } })
      expect(invalid.isError).toBe(true)
    })
    await client.close(); await server.close()
  })

  it('saves nutrition goals with profile isolation and rejects unknown or unbounded values', async () => {
    apiCall.mockResolvedValue({ goals: { calories: 2200 } })
    const { client, server } = await connected(['opengym:read', 'food:write'])
    await runRequestContext(context, async () => {
      const result = await client.callTool({ name: 'set_nutrition_goals', arguments: { calories: 2200, protein_g: null } })
      expect(result.isError).toBeFalsy()
      expect(apiCall).toHaveBeenCalledWith('profile-a', '/api/food/goals', { method: 'PUT', body: { calories: 2200, protein_g: null } })
      apiCall.mockClear()
      for (const args of [{ calories: 20001 }, { profile_id: 'profile-b', calories: 2200 }]) {
        const invalid = await client.callTool({ name: 'set_nutrition_goals', arguments: args })
        expect(invalid.isError).toBe(true)
      }
      expect(apiCall).not.toHaveBeenCalled()
      const estimate = await client.callTool({ name: 'calculate_navy_body_fat', arguments: { sex: 'male', unit: 'in', height: 72, waist: 34, neck: 16 } })
      expect(JSON.parse(estimate.content[0].text).body_fat_percent).toBe(14.6)
      const measurements = await client.callTool({ name: 'get_body_measurements', arguments: {} })
      expect(JSON.parse(measurements.content[0].text).measurement_unit).toBe('cm')
    })
    await client.close(); await server.close()
  })
})
