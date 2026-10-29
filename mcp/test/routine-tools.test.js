import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('../src/api-client.js', () => ({ apiCall: vi.fn() }))
import { apiCall } from '../src/api-client.js'
import { buildMcpServer } from '../src/mcp-server.js'
import { runRequestContext } from '../src/request-context.js'

async function connected(scopes, options) {
  const server = buildMcpServer(scopes, options)
  const client = new Client({ name: 'routine-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}
afterEach(() => vi.clearAllMocks())

const context = { profileId: 'profile-a', profileName: 'A', scopes: ['opengym:read', 'routines:write'], state: { routines: [], workouts: [], _rev: 4 } }

describe('MCP routine tools', () => {
  it('hides routine writes without routines:write and keeps them off local stdio', async () => {
    const read = await connected(['opengym:read'])
    const names = (await read.client.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('list_routines')
    expect(names).not.toContain('create_routine')
    expect(names).not.toContain('update_routine')
    await read.client.close(); await read.server.close()

    const local = await connected(['opengym:read', 'routines:write'], { local: true })
    const localNames = (await local.client.listTools()).tools.map(tool => tool.name)
    expect(localNames).toContain('list_routines')
    expect(localNames).not.toContain('create_routine')
    expect(localNames).not.toContain('update_routine')
    await local.client.close(); await local.server.close()
  })

  it('forwards create and update with the profile and rejects unknown fields before the API', async () => {
    apiCall.mockResolvedValue({ ok: true, revision: 5, routine_id: 'push', exercise_ids: ['0001'] })
    const { client, server } = await connected(['opengym:read', 'routines:write'])
    await runRequestContext(context, async () => {
      const created = await client.callTool({ name: 'create_routine', arguments: { revision: 4, name: 'Push', exercises: [{ id: '0001', sets: 3, reps: 8 }] } })
      expect(created.isError).toBeFalsy()
      expect(apiCall).toHaveBeenCalledWith('profile-a', '/api/routines', { method: 'POST', body: { revision: 4, name: 'Push', exercises: [{ id: '0001', sets: 3, reps: 8 }] } })
      apiCall.mockClear()
      const updated = await client.callTool({ name: 'update_routine', arguments: { routine_id: 'push', revision: 5, exercises: [{ id: '0001', sets: 4, pyramid: [12, 10, 'max'] }] } })
      expect(updated.isError).toBeFalsy()
      expect(apiCall).toHaveBeenCalledWith('profile-a', '/api/routines', { method: 'PUT', body: { routine_id: 'push', revision: 5, exercises: [{ id: '0001', sets: 4, pyramid: [12, 10, 'max'] }] } })
      apiCall.mockClear()
      const copies = await client.callTool({ name: 'update_routine', arguments: {
        routine_id: 'push', revision: 5, exercises: [{ id: '0001', position: 2 }, { id: '0001', position: 1, sets: 4 }]
      } })
      expect(copies.isError).toBeFalsy()
      expect(apiCall).toHaveBeenCalledWith('profile-a', '/api/routines', { method: 'PUT', body: {
        routine_id: 'push', revision: 5, exercises: [{ id: '0001', position: 2 }, { id: '0001', position: 1, sets: 4 }]
      } })
      apiCall.mockClear()
      for (const args of [
        { routine_id: 'push', revision: 5, name: 'Push', workouts: [] },
        { routine_id: 'push', revision: 5, exercises: [] },
        { routine_id: 'push', revision: 5, exercises: [{ id: '0001', pyramid: [12, 0, 8] }] },
        { revision: 5, name: 'Push', exercises: [{ id: '0001' }], routine_id: 'nope' }
      ]) {
        const invalid = await client.callTool({ name: args.routine_id === 'nope' ? 'create_routine' : 'update_routine', arguments: args })
        expect(invalid.isError).toBe(true)
      }
      expect(apiCall).not.toHaveBeenCalled()
    })
    await runRequestContext({ ...context, scopes: ['opengym:read'] }, async () => {
      const denied = await client.callTool({ name: 'update_routine', arguments: { routine_id: 'push', revision: 5, name: 'Nope' } })
      expect(denied.isError).toBe(true)
      expect(denied.content[0].text).toContain('INSUFFICIENT_SCOPE')
      expect(apiCall).not.toHaveBeenCalled()
    })
    await client.close(); await server.close()
  })
})
