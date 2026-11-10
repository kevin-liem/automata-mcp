import type { Db, OrgLimits } from './app-db'

/**
 * Entitlements: what an organization may hold, and the checks that hold it to
 * that. The only limit enforcement in the app.
 *
 * This file knows numbers, not plans. `app.organizations.max_connections`,
 * `max_tokens` and `max_members` say how many of each an organization may
 * have; NULL is unlimited. Nothing here names a plan, a price or a payment
 * provider — the cloud service (`apps/cloud`) sells plans and writes the
 * columns, and this file only reads them. On a self-hosted deployment every
 * column is NULL, so every check here passes and nothing is limited, with no
 * setting to get right.
 *
 * Why enforcement stays in the web app even once selling plans moves out: the
 * checks run inside the app's own transactions, under the organization row
 * lock, and on every MCP request. A call to another service there would put
 * that service's outage on the auth path and turn "valid token, backend
 * down" into a refusal. Reading a column keeps the rule every auth read here
 * follows: a fault is a 503, never a refusal.
 *
 * Two behaviours, both deterministic:
 *
 * - **Adding beyond a limit is refused** with 402 `plan_limit` (`assertCanAdd`),
 *   checked under the organization row lock so two racing adds take turns.
 * - **Holding beyond a limit deletes nothing.** An organization whose limits
 *   dropped — a lapsed subscription — keeps everything. On the MCP surface only
 *   the oldest `max_tokens` live tokens on its oldest `max_connections`
 *   connections answer (`mcpLimitRefusal`); the rest get 403, never 401, and
 *   come back unchanged when the limits rise again.
 */

export type LimitedResource = 'connection' | 'token' | 'member'

export interface OrgUsage {
  connections: number
  /** Live tokens: not revoked, not expired. */
  tokens: number
  members: number
  pendingInvites: number
}

/**
 * The limits a new organization is born with, for `createOrganizationFor`'s
 * insert. None without the hosted offering. With it, the row the cloud service
 * writes at boot (`app.entitlement_defaults`) — and a 503 while that row is
 * missing, since creating the organization unlimited is the one wrong answer.
 */
export async function newOrganizationLimits(db: Db): Promise<OrgLimits & { plan_label?: string }> {
  if (!hostedMode()) return {}
  const [defaults] = await db<(OrgLimits & { plan_label?: string })[]>`
    SELECT max_connections, max_tokens, max_members, plan_label, recent_history_only
    FROM app.entitlement_defaults WHERE id = 'new_organization'
  `
  if (!defaults) {
    console.error('[entitlements] no limits for new organizations yet: the cloud service writes them when it starts. Refusing the signup.')
    throw createError({ statusCode: 503, statusMessage: 'Sign-up is briefly unavailable. Try again in a minute.' })
  }
  return defaults
}

/** Whether any limit applies at all. False for every self-hosted organization. */
export function hasLimits(limits: OrgLimits | undefined): boolean {
  return limits?.max_connections != null || limits?.max_tokens != null || limits?.max_members != null
    || limits?.recent_history_only === true
}

export async function loadOrgLimits(db: Db, orgId: string): Promise<OrgLimits | undefined> {
  const [row] = await db<OrgLimits[]>`
    SELECT max_connections, max_tokens, max_members, recent_history_only FROM app.organizations WHERE id = ${orgId}
  `
  return row
}

/**
 * Whether the organization may ask WhatsApp for an account's full history at
 * pairing. Only the flag — which connections it applies to (those on the
 * deployment's own server) is `whatsappHistoryLimited` in instances.ts.
 */
export async function orgRecentHistoryOnly(db: Db, orgId: string): Promise<boolean> {
  const [row] = await db<{ recent_history_only: boolean }[]>`
    SELECT recent_history_only FROM app.organizations WHERE id = ${orgId}
  `
  return row?.recent_history_only === true
}

/**
 * The refusal for asking for a full-history import on a plan that imports
 * recent history only. Same 402 `plan_limit` shape as `limitError`, so the UI
 * offers the Billing page the same way.
 */
export function fullHistoryLimitError() {
  return createError({
    statusCode: 402,
    statusMessage: 'Your plan imports recent WhatsApp history only. Upgrade to import an account\'s full history.',
    data: { code: 'plan_limit', resource: 'history' },
  })
}

/**
 * What an organization holds, counted. Tokens carry no `org`, so they are
 * counted through their connection's.
 */
export async function orgUsage(db: Db, orgId: string): Promise<OrgUsage> {
  const [row] = await db<OrgUsage[]>`
    SELECT
      (SELECT count(*)::int FROM app.instances WHERE org = ${orgId}) AS connections,
      (SELECT count(*)::int FROM app.mcp_tokens t JOIN app.instances i ON i.id = t.instance
        WHERE i.org = ${orgId} AND NOT t.revoked
          AND (t.expires_at IS NULL OR t.expires_at > now())) AS tokens,
      (SELECT count(*)::int FROM app.memberships WHERE org = ${orgId}) AS members,
      (SELECT count(*)::int FROM app.invitations
        WHERE org = ${orgId} AND NOT revoked AND accepted_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())) AS "pendingInvites"
  `
  return row ?? { connections: 0, tokens: 0, members: 0, pendingInvites: 0 }
}

/** Whether an organization holds more than its limits allow. */
export function overLimit(limits: OrgLimits | undefined, usage: OrgUsage): boolean {
  const over = (limit: number | undefined, used: number) => limit != null && used > limit
  return over(limits?.max_connections, usage.connections)
    || over(limits?.max_tokens, usage.tokens)
    || over(limits?.max_members, usage.members)
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The refusal. 402 with `data.code = 'plan_limit'`, which the UI keys on to
 * offer the Billing page rather than show a bare error. Worded around the
 * number, not a plan name, since this file does not know plan names.
 */
function limitError(what: LimitedResource, limit: number) {
  const message = what === 'connection'
    ? `Your plan includes ${plural(limit, 'connection', 'connections')}. Upgrade to add more.`
    : what === 'token'
      ? `Your plan includes ${plural(limit, 'connector token', 'connector tokens')}. Revoke one, or upgrade for more.`
      : `Your plan includes ${plural(limit, 'user', 'users')}. Upgrade to invite more people.`
  return createError({
    statusCode: 402,
    statusMessage: message,
    data: { code: 'plan_limit', resource: what },
  })
}

/**
 * Refuse to add one more of something the organization has no room for.
 *
 * Takes `Db` so it runs inside the caller's transaction — the insert it guards
 * stands or falls with it. The organization row is locked `FOR UPDATE` while
 * its limits are read, so two racing adds take turns and the second one counts
 * the first. With the relevant limit NULL — always, on a self-hosted
 * deployment — it returns after that one read.
 *
 * `includePendingInvites` is for creating an invitation: a pending invitation
 * is a seat already promised, so inviting is refused while one is outstanding
 * even though the member count alone would allow it.
 */
export async function assertCanAdd(
  db: Db,
  orgId: string,
  what: LimitedResource,
  options: { includePendingInvites?: boolean } = {},
): Promise<void> {
  const [limits] = await db<OrgLimits[]>`
    SELECT max_connections, max_tokens, max_members
    FROM app.organizations WHERE id = ${orgId} FOR UPDATE
  `
  const limit = what === 'connection'
    ? limits?.max_connections
    : what === 'token' ? limits?.max_tokens : limits?.max_members
  if (limit == null) return

  const usage = await orgUsage(db, orgId)
  const used = what === 'connection'
    ? usage.connections
    : what === 'token'
      ? usage.tokens
      : usage.members + (options.includePendingInvites ? usage.pendingInvites : 0)

  if (used >= limit) throw limitError(what, limit)
}

/**
 * Whether one connector token may answer on the MCP surface under its
 * organization's limits, or the refusal to send instead.
 *
 * `limits` arrive on the MCP auth facts — the same query `resolveMcpAuth` already
 * runs — so an organization with none (every self-hosted one) costs nothing
 * extra here. With limits, the tokens that may answer are the oldest
 * `max_tokens` live tokens on the oldest `max_connections` connections: within
 * the limits that is every token, and over them — a lapsed subscription, or two
 * creates that raced past `assertCanAdd` — it is a deterministic choice, so the
 * same connectors keep working on every request and the owner can tell which.
 *
 * The refusal is **403, never 401**. A 401 tells an MCP client its credential
 * is bad and invites it to throw the token away; this one comes back to life
 * the moment the limits rise, with nothing to reconfigure.
 *
 * A read failure is a 503 like every other auth read — never a refusal.
 */
export async function mcpLimitRefusal(
  orgId: string | undefined,
  tokenId: string,
  limits: Pick<OrgLimits, 'max_connections' | 'max_tokens'> | undefined,
): Promise<Response | undefined> {
  if (!orgId || (limits?.max_connections == null && limits?.max_tokens == null)) return undefined

  let allowed = false
  try {
    const sql = await appDb()
    // LIMIT NULL is LIMIT ALL, so an absent limit on one axis does not narrow it.
    const [row] = await sql<{ allowed: boolean }[]>`
      WITH conns AS (
        SELECT id FROM app.instances WHERE org = ${orgId}
        ORDER BY created, id LIMIT ${limits.max_connections ?? null}
      ), toks AS (
        SELECT t.id FROM app.mcp_tokens t
        WHERE t.instance IN (SELECT id FROM conns)
          AND NOT t.revoked AND (t.expires_at IS NULL OR t.expires_at > now())
        ORDER BY t.created, t.id LIMIT ${limits.max_tokens ?? null}
      )
      SELECT EXISTS (SELECT 1 FROM toks WHERE id = ${tokenId}) AS allowed
    `
    allowed = Boolean(row?.allowed)
  }
  catch (error) {
    console.error('[entitlements] could not read the limits for an MCP request:', error)
    throw appDbUnavailable(error)
  }
  if (allowed) return undefined

  // A handled refusal is invisible to Nitro; say which token and why, since
  // "my connector stopped working" is the first thing a lapsed owner reports.
  console.warn(`[entitlements] token ${tokenId} refused: organization ${orgId} is over its limits and this token is beyond them`)

  const appUrl = String(useRuntimeConfig().public.appUrl ?? '').replace(/\/+$/, '')
  const where = appUrl ? ` Upgrade at ${appUrl}/billing to use it again.` : ' An admin can upgrade on the Billing page to use it again.'
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32002,
        message: 'This organization\'s plan covers fewer connectors than it holds, and this one is beyond the limit.' + where,
      },
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
}
