import { createError, getHeader } from 'h3'
import type { H3Event } from 'h3'
import { appDb } from '../../../server/utils/app-db'
import { mcpUnauthorized, resolveMcpAuth, resolveMcpAuthHash } from '../../../server/utils/mcp-auth'
import { MCP_SCOPE, PROTECTED_METADATA_PATH } from '../shared'
import { oauthEnabled, readOAuthConfig } from './config'
import { createOAuthService } from './service'
import type { OAuthService } from './service'

let ready: Promise<OAuthService> | undefined

export function isOAuthEnabled(): boolean {
  return oauthEnabled(useRuntimeConfig().mcpOauth)
}

export function getOAuthService(): Promise<OAuthService> {
  if (!isOAuthEnabled()) throw createError({ statusCode: 404 })
  if (!ready) {
    ready = (async () => {
      const config = useRuntimeConfig()
      let settings
      try { settings = readOAuthConfig(config.mcpOauth, config.public.appUrl, import.meta.dev) }
      catch (error) {
        console.error('[mcp-oauth]', (error as Error).message)
        throw createError({ statusCode: 503, message: 'OAuth configuration is incomplete. See the server logs.' })
      }
      return await createOAuthService(settings, await appDb(), resolveMcpAuthHash)
    })().catch((error) => {
      // Retry after a brief backoff when Postgres was still starting at boot.
      setTimeout(() => { ready = undefined }, 10_000).unref?.()
      throw error
    })
  }
  return ready
}

/** Small MCP integration: native tokens first; OAuth is header-only on /mcp. */
export async function authenticateMcpRequest(event: H3Event) {
  const native = await resolveMcpAuth(event)
  if (native) return native
  if (!isOAuthEnabled()) return mcpUnauthorized()

  const service = await getOAuthService()
  let insufficientScope = false
  const header = getHeader(event, 'authorization')
  const token = /^Bearer\s+([A-Za-z0-9_-]{20,512})$/i.exec(header?.trim() ?? '')?.[1]
  if (event.path.split('?')[0] === '/mcp' && token && !token.startsWith('wamcp_')) {
    try {
      const auth = await service.resolveAccessToken(token)
      if (auth) return auth
    }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 403) throw error
      insufficientScope = true
    }
  }
  const response = mcpUnauthorized()
  response.headers.set('access-control-allow-origin', '*')
  response.headers.set('access-control-expose-headers', 'WWW-Authenticate')
  response.headers.set('www-authenticate', `Bearer resource_metadata="${service.config.origin}${PROTECTED_METADATA_PATH}", scope="${MCP_SCOPE}"${insufficientScope ? ', error="insufficient_scope"' : header ? ', error="invalid_token"' : ''}`)
  return new Response(response.body, { status: insufficientScope ? 403 : 401, headers: response.headers })
}
