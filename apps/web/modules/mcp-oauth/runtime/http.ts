import { errors } from 'oidc-provider'
import { callNodeListener, createError, getHeader, readBody, readRawBody, sendRedirect, setHeader } from 'h3'
import type { H3Event } from 'h3'
import type { AppUser } from '../../../server/utils/app-db'
import { AUTHORIZE_PATH, CONNECTIONS_PATH, INTERACTION, MCP_SCOPE, METADATA_PATHS, PROTECTED_METADATA_PATH, RESUME } from '../shared'
import { csrfToken, matchesToken } from './crypto'
import { connectionTitle, escapeHtml, page, toolsSummary } from './pages'
import { PROVIDER_SESSION_COOKIE } from './service'
import type { OAuthService } from './service'

const PROVIDER_ROUTES = new Set([
  AUTHORIZE_PATH, '/oauth/token', '/oauth/register', '/oauth/revoke', '/oauth/jwks',
  '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration',
])

function unavailableApproval(event: H3Event) {
  return page(event, 'Approval is no longer available', `<section>
    <p>This approval link is no longer active in this browser.</p>
    <p>Restart the connection from your agent to request access again.</p></section>`, 400)
}

export async function handleOAuthRequest(event: H3Event, service: OAuthService, sessionHash?: string) {
  const { config, provider } = service
  const path = event.path.split('?')[0]!
  // Apply before interactionDetails/createContext too: these set secure cookies
  // behind the same TLS-terminating proxy as the provider endpoints.
  const origin = new URL(config.origin)
  event.node.req.headers['x-forwarded-host'] = origin.host
  event.node.req.headers['x-forwarded-proto'] = origin.protocol.slice(0, -1)
  setHeader(event, 'cache-control', 'no-store')
  // no-referrer makes browser form navigations send Origin: null, which fails
  // the CSRF origin check. Keep same-origin forms verifiable without sending
  // approval URLs to the agent's external callback.
  setHeader(event, 'referrer-policy', 'same-origin')
  setHeader(event, 'x-content-type-options', 'nosniff')

  if (path === PROTECTED_METADATA_PATH || path === '/.well-known/oauth-protected-resource') {
    if (event.method !== 'GET' && event.method !== 'OPTIONS') throw createError({ statusCode: 405 })
    setHeader(event, 'access-control-allow-origin', '*')
    return {
      resource: config.resource, authorization_servers: [config.origin],
      bearer_methods_supported: ['header'], scopes_supported: [MCP_SCOPE], resource_name: 'DOPE MCP',
    }
  }

  if (path === CONNECTIONS_PATH || INTERACTION.test(path)) {
    const user = event.context.user as AppUser | undefined
    if (!user || !sessionHash) {
      if (event.method === 'GET') return sendRedirect(event, `/login?oauth_return=${encodeURIComponent(path)}`, 303)
      throw createError({ statusCode: 401, message: 'Sign in again before approving access.' })
    }
    if (event.method !== 'GET' && event.method !== 'POST') throw createError({ statusCode: 405 })
    const form = event.method === 'POST' ? await readBody<Record<string, unknown>>(event) : undefined
    const csrf = (...context: string[]) => csrfToken(config.cookieKey, sessionHash, ...context)
    const validForm = (...context: string[]) => {
      const origin = getHeader(event, 'origin')
      return (origin === undefined || origin === config.origin) && matchesToken(form?.csrf, csrf(...context))
    }

    if (path === CONNECTIONS_PATH) {
      if (form) {
        if (typeof form.id !== 'string' || !validForm('revoke', form.id)) throw createError({ statusCode: 403, message: 'The form expired. Reload this page.' })
        await service.revoke(user.id, form.id)
        return sendRedirect(event, CONNECTIONS_PATH, 303)
      }
      const authorizations = await service.authorizations(user.id)
      const entries = authorizations.map(row => `<section><h2>${escapeHtml(row.client_name)}</h2>
        <p>${escapeHtml(connectionTitle(row.kind, row.connection_name))}<br>Connector name: ${escapeHtml(row.label.trim() || 'Unnamed connector')}</p>
        <small>Client: ${escapeHtml(row.client_id)}</small>
        <form method="post" action="${CONNECTIONS_PATH}">
          <input type="hidden" name="id" value="${escapeHtml(row.id)}"><input type="hidden" name="csrf" value="${csrf('revoke', row.id)}">
          <button type="submit">Revoke agent access</button>
        </form></section>`).join('')
      return page(event, 'Connected agents', `<p>Signed in as ${escapeHtml(user.email)}. Revoking an agent stops its OAuth access and refresh tokens.</p>
        ${entries || '<section><p>No active agent authorizations.</p></section>'}`)
    }

    const uid = path.slice(path.lastIndexOf('/') + 1)
    if (form && (!validForm('consent', uid) || !['allow', 'deny'].includes(String(form.decision)))) {
      return page(event, 'Approval could not be verified', `<section>
        <p>Reload the approval page and try again. If you signed in again in another tab, restart the connection from your agent.</p>
        <p><a href="${path}">Reload approval page</a></p></section>`, 403)
    }
    // The GET validates the provider cookie before exposing a session-bound
    // CSRF proof. The POST needs that proof even if the provider cookie was lost.
    const details = await (form ? provider.Interaction.find(uid) : provider.interactionDetails(event.node.req, event.node.res)).catch((error) => {
      if (error instanceof errors.SessionNotFound) return undefined
      throw error
    })
    if (!details || details.uid !== uid || details.result || (form && details.session)) {
      return unavailableApproval(event)
    }
    const { client_id: clientId, redirect_uri: redirectUri } = details.params
    if (typeof clientId !== 'string' || typeof redirectUri !== 'string') throw new errors.InvalidRequest('Invalid client request.')
    const client = await provider.Client.find(clientId)
    if (!client) throw new errors.InvalidClient('Unknown client.')
    const clientName = (client.clientName || 'Registered MCP client').slice(0, 120)

    if (form) {
      let authorization: { id: string, grantId: string } | undefined
      if (form.decision === 'deny') details.result = { error: 'access_denied' }
      else {
        if (typeof form.token !== 'string') throw new errors.AccessDenied('Choose an available connector token.')
        authorization = await service.approve(user.id, form.token, clientId, clientName)
        details.result = { login: { accountId: authorization.id, remember: false }, consent: { grantId: authorization.grantId } }
      }
      try { await details.persist() }
      catch (error) {
        // A simultaneous submission may have consumed this interaction first.
        // Do not leave a second, never-approved authorization in the user's list.
        if (authorization) await service.revoke(user.id, authorization.id)
        if (error instanceof errors.SessionNotFound) return unavailableApproval(event)
        throw error
      }
      const resumePath = `${AUTHORIZE_PATH}/${uid}`
      provider.createContext(event.node.req, event.node.res).cookies.set(provider.cookieName('resume'), uid, {
        httpOnly: true, sameSite: 'lax', secure: config.origin.startsWith('https:'),
        path: resumePath, expires: new Date(details.exp * 1000), signed: true,
      })
      setHeader(event, 'refresh', `0; url=${resumePath}`)
      return page(event, 'Returning to your agent', `<p><a href="${resumePath}">Continue to your agent</a></p>`)
    }

    const choices = await service.choices(user.id)
    const deadline = new Date(details.exp * 1000)
    const options = choices.map(({ row, auth }, index) => `<label><input type="radio" name="token" value="${escapeHtml(row.id)}" ${index === 0 ? 'checked' : ''} required>
      <strong>${escapeHtml(connectionTitle(row.kind, row.connection_name))}</strong><br>
      <small>Connector name: ${escapeHtml(row.label.trim() || 'Unnamed connector')}</small><br>
      <small>${escapeHtml(toolsSummary(auth))}</small></label>`).join('')
    return page(event, 'Authorize agent access', `<section><p><strong>${escapeHtml(clientName)}</strong> is requesting access to one connection.</p>
      <p>Signed in as <strong>${escapeHtml(user.email)}</strong>.<br>Returns to <strong>${escapeHtml(new URL(redirectUri).host)}</strong>.</p>
      <p>Approve only if you started this connection from that app. Access follows the selected token’s permissions and expiry.</p>
      <p><small>This approval link expires at <time datetime="${deadline.toISOString()}">${deadline.toUTCString()}</time>.</small></p>
      <form method="post" action="${path}"><input type="hidden" name="csrf" value="${csrf('consent', uid)}">
      ${choices.length ? `<fieldset><legend>Choose a connector token</legend>${options}</fieldset><button type="submit" name="decision" value="allow">Allow access</button>`
        : '<p>No eligible connector tokens. Ask an organization admin to issue a token to your account, then restart from your agent.</p>'}
      <button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Deny</button></form></section>`)
  }

  if (!PROVIDER_ROUTES.has(path) && !RESUME.test(path)) throw createError({ statusCode: 404 })
  if (METADATA_PATHS.includes(path)) setHeader(event, 'access-control-allow-origin', '*')

  // Canonical external origin, independent of untrusted Host/Forwarded headers.
  if (path === AUTHORIZE_PATH) {
    if (event.method !== 'GET') throw createError({ statusCode: 405 })
    // Force a DOPE login/consent check for each new authorization, rather
    // than accepting an old provider session's selected connection.
    delete event.node.req.headers.cookie
    const url = new URL(event.node.req.url!, config.origin)
    if (!url.searchParams.get('scope')) url.searchParams.set('scope', MCP_SCOPE)
    event.node.req.url = url.pathname + url.search
  }
  if (RESUME.test(path)) {
    event.node.req.headers.cookie = event.node.req.headers.cookie?.split(';').filter(part => {
      const name = part.trimStart().split('=')[0]
      return name !== PROVIDER_SESSION_COOKIE && name !== `${PROVIDER_SESSION_COOKIE}.sig`
    }).join(';')
  }
  // 00-body-limit already consumed the stream into H3's bounded cache. Pass
  // that buffer through the provider's supported req.body fallback; never ask
  // its Node parser to read the exhausted stream a second time.
  if (event.method === 'POST') {
    const raw = await readRawBody(event, false)
    if (raw && raw.length > 56 * 1024) throw createError({ statusCode: 413 })
    Object.assign(event.node.req, { body: raw ?? Buffer.alloc(0) })
  }
  await callNodeListener(provider.callback(), event.node.req, event.node.res)
}
