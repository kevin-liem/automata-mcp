import type { JWKS } from 'oidc-provider'

export interface OAuthSettings {
  enabled: boolean | string
  cookieKey: string
  encryptionKey: string
  jwks: string | JWKS
}

export interface OAuthConfig {
  origin: string
  resource: string
  cookieKey: Buffer
  encryptionKey: Buffer
  jwks: JWKS
}

export function oauthEnabled(settings: Pick<OAuthSettings, 'enabled'>): boolean {
  return settings.enabled === true || settings.enabled === 'true'
}

export function readOAuthConfig(settings: OAuthSettings, appUrl: string, development = false): OAuthConfig {
  let origin: URL
  try { origin = new URL(appUrl) }
  catch { throw new Error('Set NUXT_PUBLIC_APP_URL to the public HTTPS origin before enabling OAuth.') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(development && loopback && origin.protocol === 'http:'))) {
    throw new Error('OAuth requires an HTTPS NUXT_PUBLIC_APP_URL origin (HTTP loopback is allowed in development).')
  }
  const key = (value: string, name: string) => {
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${name} must be 32 bytes in hexadecimal. See docs/oauth.md.`)
    return Buffer.from(value, 'hex')
  }
  let jwks: JWKS
  try {
    // Nitro deserializes JSON-valued environment overrides; direct consumers
    // (and .env tooling) may still supply the original JSON string.
    jwks = typeof settings.jwks === 'string' ? JSON.parse(settings.jwks) as JWKS : settings.jwks
    if (!Array.isArray(jwks.keys) || !jwks.keys.some(k => k.kty === 'RSA' && k.d && k.kid)) throw new Error()
  }
  catch { throw new Error('NUXT_MCP_OAUTH_JWKS must contain a private RSA signing key. See docs/oauth.md.') }
  return {
    origin: origin.origin,
    resource: new URL('/mcp', origin).href,
    cookieKey: key(settings.cookieKey, 'NUXT_MCP_OAUTH_COOKIE_KEY'),
    encryptionKey: key(settings.encryptionKey, 'NUXT_MCP_OAUTH_ENCRYPTION_KEY'),
    jwks,
  }
}
