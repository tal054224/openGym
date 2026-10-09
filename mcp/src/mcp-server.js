import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOLS } from './tools.js'
import { FOOD_TOOLS } from './food-tools.js'
import { requestContext } from './request-context.js'

const text = value => JSON.stringify(value, null, 2)
const errorResult = error => ({
  isError: true,
  content: [{ type: 'text', text: `${error.code || 'ERROR'}: ${error.message || 'request failed'}` }]
})

export function buildMcpServer(scopes = []) {
  const allowed = new Set(scopes)
  const server = new McpServer({ name: 'opengym', version: '0.2.0' })
  for (const tool of TOOLS) {
    if (!allowed.has('opengym:read')) continue
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema, annotations: { readOnlyHint: true } }, async params => {
      if (!requestContext()?.scopes?.includes('opengym:read')) return errorResult(Object.assign(new Error('read scope is required'), { code: 'INSUFFICIENT_SCOPE' }))
      try { return { content: [{ type: 'text', text: text(await tool.handler(params || {})) }] } }
      catch (error) { return errorResult(error) }
    })
  }
  for (const tool of FOOD_TOOLS) {
    if (tool.scope && !allowed.has(tool.scope)) continue
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.schema,
      annotations: tool.readOnly ? { readOnlyHint: true } : { ...(tool.destructive ? { destructiveHint: true } : {}) }
    }, async params => {
        const scope = tool.scope || 'opengym:read'
        if (!requestContext()?.scopes?.includes(scope)) return errorResult(Object.assign(new Error('required scope is missing'), { code: 'INSUFFICIENT_SCOPE' }))
        try { return { content: [{ type: 'text', text: text(await tool.handler(params || {})) }] } }
        catch (error) { return errorResult(error) }
      })
  }
  return server
}
