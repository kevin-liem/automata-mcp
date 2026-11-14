import { randomUUID } from 'node:crypto'
import Provider, { errors } from 'oidc-provider'
import type { Sql } from 'postgres'
import type { McpAuth } from '../../../server/utils/mcp-auth'
import { AUTHORIZE_PATH, INTERACTION_PATH, MCP_SCOPE } from '../shared'
import type { OAuthConfig } from './config'
import { fetchClientMetadata } from './metadata'
import { migrateOAuth, postgresAdapter, storage } from './storage'
import { MCP_GRANT_TYPES, negotiateCimdCapabilities } from './client-metadata'

export const PROVIDER_SESSION_COOKIE = 'automata_oauth_session'
export const ACCESS_TTL = 60 * 60
export const GRANT_TTL = 30 * 24 * 60 * 60

export function isAgentCallback(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !value.includes('#')
      && (url.protocol === 'https:' || (url.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  }
  catch { return false }
}

interface Authorization {
  id: string
  user_id: string
  token_id: string
  token_hash: string
  client_id: string
  client_name: string
  resource: string
  grant_id: string
}

interface TokenChoice {
  id: string
  label: string
  connection_name: string
  kind: string
  token_hash: string
}

export async function createOAuthService(
  config: OAuthConfig,
  db: Sql,
  resolveHash: (hash: string, options?: { recordUse?: boolean }) => Promise<McpAuth | undefined>,
  fetchMetadata: typeof fetch = fetchClientMetadata,
) {
  await migrateOAuth(db)

  async function resolveAuthorization(id: string, recordUse = false): Promise<McpAuth | undefined> {
    const [row] = await storage(() => db<Authorization[]>`
      SELECT * FROM mcp_oauth.authorizations
      WHERE id = ${id} AND resource = ${config.resource} AND revoked_at IS NULL AND expires_at > now()
    `)
    if (!row) return undefined
    const auth = await resolveHash(row.token_hash, { recordUse })
    return auth?.tokenId === row.token_id && auth.user.id === row.user_id ? auth : undefined
  }

  const provider = new Provider(config.origin, {
    adapter: postgresAdapter(db, config.encryptionKey),
    jwks: config.jwks,
    cookies: {
      keys: [config.cookieKey.toString('base64url')],
      names: { session: PROVIDER_SESSION_COOKIE, interaction: 'automata_oauth_interaction', resume: 'automata_oauth_resume' },
      long: { path: `${AUTHORIZE_PATH}/`, secure: config.origin.startsWith('https:') },
      short: { secure: config.origin.startsWith('https:') },
    },
    interactions: { url: (_ctx, interaction) => `${INTERACTION_PATH}/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      registration: { enabled: true, issueRegistrationAccessToken: false },
      revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        allowFetch: () => true,
        allowClient: (_ctx, client) => client.clientAuthMethod === 'none',
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => config.resource,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== config.resource) throw new errors.InvalidTarget()
          return { audience: config.resource, scope: MCP_SCOPE, accessTokenTTL: ACCESS_TTL }
        },
      },
    },
    fetch: negotiateCimdCapabilities(fetchMetadata),
    clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post'],
    clientBasedCORS: (_ctx, origin, client) => client.clientAuthMethod === 'none'
      && client.redirectUris?.some(uri => new URL(uri).origin === origin) === true,
    clientDefaults: { grant_types: MCP_GRANT_TYPES, response_types: ['code'] },
    extraClientMetadata: {
      properties: ['redirect_uris', 'grant_types', 'response_types'],
      validator: (_ctx, name, value) => {
        if (name === 'redirect_uris' && (!Array.isArray(value) || !value.length
          || !value.every(uri => typeof uri === 'string' && isAgentCallback(uri)))) {
          throw new errors.InvalidClientMetadata('Use an HTTPS or loopback HTTP redirect URI.')
        }
        if (name === 'grant_types' && (!Array.isArray(value)
          || !value.every(grant => MCP_GRANT_TYPES.includes(grant)))) {
          throw new errors.InvalidClientMetadata('Only authorization_code and refresh_token grants are supported.')
        }
        if (name === 'response_types' && (!Array.isArray(value) || value.some(response => response !== 'code'))) {
          throw new errors.InvalidClientMetadata('Only the code response type is supported.')
        }
      },
    },
    pkce: { required: () => true },
    responseTypes: ['code'],
    scopes: ['openid', 'offline_access', MCP_SCOPE],
    routes: {
      authorization: AUTHORIZE_PATH,
      token: '/oauth/token',
      registration: '/oauth/register',
      revocation: '/oauth/revoke',
      jwks: '/oauth/jwks',
    },
    ttl: { AccessToken: ACCESS_TTL, AuthorizationCode: 120, Interaction: 600, Session: 600, Grant: GRANT_TTL, RefreshToken: GRANT_TTL },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    revokeGrantPolicy: () => true,
    expiresWithSession: () => false,
    renderError: (ctx, output) => {
      const reference = randomUUID()
      const code = typeof output.error === 'string' && /^[a-z_]{1,64}$/.test(output.error) ? output.error : 'server_error'
      const description = typeof output.error_description === 'string'
        ? output.error_description.replace(/[\r\n\t]/g, ' ').slice(0, 500)
        : 'The requesting app could not be authorized.'
      // Protocol error fields only: never log request parameters, cookies,
      // authorization codes, client secrets, or access/refresh tokens.
      console.warn('[mcp-oauth] OAuth request refused:', { reference, error: code, description })
      ctx.set('x-request-id', reference)
      ctx.type = 'text'
      ctx.body = `Authorization could not be completed.\n\n${description}\nError: ${code}\nReference: ${reference}\n\nRestart the connection from your agent.`
    },
    findAccount: async (_ctx, id) => {
      const auth = await resolveAuthorization(id)
      return auth ? { accountId: id, claims: async () => ({ sub: id }) } : undefined
    },
  })
  provider.proxy = true
  provider.on('server_error', (_ctx, error) => {
    console.error('[mcp-oauth] provider request failed:', error.message)
  })

  async function choices(userId: string) {
    const rows = await storage(() => db<TokenChoice[]>`
      SELECT t.id, t.label, t.token_hash, i.name AS connection_name, i.kind
      FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
      WHERE t.assigned_to = ${userId} AND NOT t.revoked AND (t.expires_at IS NULL OR t.expires_at > now())
      ORDER BY i.name, t.label, t.id
    `)
    const choices = await Promise.all(rows.map(async row => {
      const auth = await resolveHash(row.token_hash, { recordUse: false })
      return auth?.user.id === userId && auth.tokenId === row.id ? { row, auth } : undefined
    }))
    return choices.filter((choice): choice is NonNullable<typeof choice> => Boolean(choice))
  }

  async function approve(userId: string, tokenId: string, clientId: string, clientName: string) {
    const choice = (await choices(userId)).find(choice => choice.row.id === tokenId)
    if (!choice) throw new errors.AccessDenied('This connector token is no longer available.')
    const id = randomUUID()
    const grant = new provider.Grant({ accountId: id, clientId })
    grant.addResourceScope(config.resource, MCP_SCOPE)
    grant.addOIDCScope(`openid offline_access ${MCP_SCOPE}`)
    const grantId = await grant.save()
    await storage(() => db`
      INSERT INTO mcp_oauth.authorizations
        (id, user_id, token_id, token_hash, client_id, client_name, resource, grant_id, expires_at)
      VALUES (${id}, ${userId}, ${tokenId}, ${choice.auth.credentialHash}, ${clientId}, ${clientName},
        ${config.resource}, ${grantId}, now() + ${GRANT_TTL} * interval '1 second')
    `)
    return { id, grantId }
  }

  async function resolveAccessToken(value: string): Promise<McpAuth | undefined> {
    const access = await provider.AccessToken.find(value)
    if (!access || access.aud !== config.resource || !access.accountId || !access.grantId
      || !await provider.Grant.find(access.grantId)) return undefined
    if (!access.scopes.has(MCP_SCOPE)) throw Object.assign(new Error('insufficient_scope'), { statusCode: 403 })
    return await resolveAuthorization(access.accountId, true)
  }

  async function authorizations(userId: string) {
    const rows = await storage(() => db<(Authorization & { label: string, connection_name: string })[]>`
      SELECT a.id, a.client_id, a.client_name, a.grant_id, t.label, i.name AS connection_name
      FROM mcp_oauth.authorizations a
      JOIN app.mcp_tokens t ON t.id = a.token_id
      JOIN app.instances i ON i.id = t.instance
      WHERE a.user_id = ${userId} AND a.resource = ${config.resource} AND a.revoked_at IS NULL AND a.expires_at > now()
        AND NOT t.revoked AND t.token_hash = a.token_hash AND (t.expires_at IS NULL OR t.expires_at > now())
      ORDER BY a.created_at DESC
    `)
    const live = await Promise.all(rows.map(async row =>
      await provider.Grant.find(row.grant_id) && await resolveAuthorization(row.id) ? row : undefined,
    ))
    return live.filter((row): row is NonNullable<typeof row> => Boolean(row))
  }

  async function revoke(userId: string, id: string) {
    const [row] = await storage(() => db<{ grant_id: string }[]>`
      UPDATE mcp_oauth.authorizations SET revoked_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND resource = ${config.resource} AND revoked_at IS NULL
      RETURNING grant_id
    `)
    if (row) {
      const adapter = new (postgresAdapter(db, config.encryptionKey))('Grant')
      await adapter.destroy(row.grant_id)
      await adapter.revokeByGrantId(row.grant_id)
    }
  }

  return { config, provider, choices, approve, resolveAccessToken, authorizations, revoke }
}

export type OAuthService = Awaited<ReturnType<typeof createOAuthService>>
