import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js'

const allowedHosts = (process.env.ALLOWED_REDIRECT_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
const maxClients = Math.max(1, Math.min(500, Number(process.env.MCP_MAX_CLIENTS) || 50))

export function createClientsStore(store, log) {
  return {
    getClient: clientId => store.getClient(clientId),
    async registerClient(client) {
      const authMethod = client.token_endpoint_auth_method || 'client_secret_post'
      if (!['none', 'client_secret_post'].includes(authMethod)) throw new InvalidClientMetadataError('only none and client_secret_post clients are supported')
      const grants = client.grant_types || ['authorization_code']
      if (!grants.length || grants.some(g => !['authorization_code', 'refresh_token'].includes(g))) {
        throw new InvalidClientMetadataError('only authorization_code and refresh_token grants are supported')
      }
      const responses = client.response_types || ['code']
      if (responses.length !== 1 || responses[0] !== 'code') throw new InvalidClientMetadataError('only the code response type is supported')
      const redirects = client.redirect_uris || []
      if (!redirects.length) throw new InvalidClientMetadataError('redirect_uris is required')
      let unlisted = false
      for (const raw of redirects) {
        let url
        try { url = new URL(raw) } catch { throw new InvalidClientMetadataError('redirect URI is invalid') }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new InvalidClientMetadataError('redirect URIs must be HTTPS without userinfo or fragments')
        if (allowedHosts.length && !allowedHosts.includes(url.hostname.toLowerCase())) throw new InvalidClientMetadataError('redirect host is not allowed')
        if (!allowedHosts.length) unlisted = true
      }
      try {
        const registered = store.registerClient({ ...client, client_name: client.client_name || 'MCP client',
          token_endpoint_auth_method: authMethod, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
          { allowedRedirectHosts: allowedHosts, max: maxClients })
        if (unlisted) log('dcr.redirect_host', registered.client_id, 'allowed-unlisted')
        return registered
      } catch (error) {
        if (error instanceof InvalidClientMetadataError) throw error
        throw new InvalidClientMetadataError(error.code === 'invalid_client_metadata' ? error.message : 'client registration was refused')
      }
    }
  }
}
