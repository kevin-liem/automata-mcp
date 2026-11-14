export const AUTHORIZE_PATH = '/oauth/authorize'
export const INTERACTION_PATH = '/oauth/interaction'
export const CONNECTIONS_PATH = '/oauth/connections'
export const PROTECTED_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp'
export const MCP_SCOPE = 'mcp:use'
export const INTERACTION = /^\/oauth\/interaction\/[A-Za-z0-9_-]{16,128}$/
export const RESUME = /^\/oauth\/authorize\/[A-Za-z0-9_-]{16,128}$/
export const METADATA_PATHS = [
  PROTECTED_METADATA_PATH,
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
]

/** Login can return only to these local pages, never a caller-supplied URL. */
export function oauthReturnPath(value: unknown): string | undefined {
  return typeof value === 'string' && (INTERACTION.test(value) || value === CONNECTIONS_PATH)
    ? value : undefined
}
