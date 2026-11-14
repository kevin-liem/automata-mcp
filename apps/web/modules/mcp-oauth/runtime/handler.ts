import { defineEventHandler, createError, setHeader } from 'h3'
import { errors } from 'oidc-provider'
import { currentSessionHash } from '../../../server/utils/session'
import { handleOAuthRequest } from './http'
import { page } from './pages'
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
      // Keep expected OAuth errors out of Nuxt's error hydration, which uses
      // the redacted diagnostic URL as the browser's new location.
      return page(event, 'Authorization could not be completed', `<section>
        <p>This authorization request could not be completed.</p>
        <p>Restart the connection from your agent to request access again.</p></section>`, error.statusCode)
    }
    throw error
  }
})
