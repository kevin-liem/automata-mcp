import { defineEventHandler, createError, setHeader } from 'h3'
import { errors } from 'oidc-provider'
import { currentSessionHash } from '../../../server/utils/session'
import { handleOAuthRequest } from './http'
import { getOAuthService, isOAuthEnabled } from './runtime'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  if (event.path.split('?')[0] === '/api/mcp-oauth/status') {
    const enabled = isOAuthEnabled()
    return enabled ? { enabled, resource: (await getOAuthService()).config.resource } : { enabled }
  }
  if (!isOAuthEnabled()) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  try {
    return await handleOAuthRequest(event, await getOAuthService(), currentSessionHash(event))
  }
  catch (error) {
    if (error instanceof errors.OIDCProviderError) {
      throw createError({ statusCode: error.statusCode, message: 'Authorization expired or was refused. Restart the connection from your agent.' })
    }
    throw error
  }
})
