import type { Sql } from 'postgres'
import postgres from 'postgres'
import type { AppInstance } from './app-db'
import type { KeyedResourceSpec } from './keyed-resource'

/**
 * Every Postgres connection this app opens — a user's own database, and
 * Evolution's message database.
 *
 * Both go through `keyedPool()`, so the keyed cache, the fingerprint
 * invalidation that notices a rotated URL, the idle sweep and the LRU ceiling
 * exist once rather than twice: the address usually comes from a user, there is
 * one pool per connection row, a DSN can be rotated at any time, and a busy
 * server holds many at once. Those mechanics now live in `keyed-resource.ts`,
 * which is engine-independent; what stays here is everything that is actually
 * about Postgres — parsing a DSN, guarding and pinning the host, and the driver
 * options.
 *
 * Two flags separate the callers, both documented on `KeyedPoolOptions`:
 * `guard` — true for anything a user typed, false for this deployment's own
 * `NUXT_EVOLUTION_DATABASE_URL`, which `net-guard` would correctly refuse as our
 * own infrastructure — and `readOnly`, set by the message databases and never
 * by the Postgres connection kind.
 *
 * **The address is pinned, not merely checked.** `assertPublicTarget` resolves
 * the DSN's host and approves an address, and that address is what
 * `postgres({ host })` dials — postgres.js prefers the `host` option over the
 * URL's hostname. A hostname that answers publicly for our lookup and privately
 * for the driver's cannot exist, because the driver never performs one. This is
 * the half of the DNS-rebinding problem that the Evolution path (which goes
 * through `$fetch`, which resolves for itself) cannot close today.
 *
 * **The pin is the only host the driver ever sees, IPv6 included.** postgres.js
 * parses a DSN with its own `parseUrl`, which disagrees with the WHATWG `URL`
 * the guard reads: it takes the authority after the *first* `@` (WHATWG: the
 * last), and reads a comma in it as a multihost list. So
 * `postgres://u:pw@127.0.0.1:5432,x@[2606:4700::1111]/db` showed the guard a
 * public IPv6 literal while the driver dialled 127.0.0.1:5432. Two rules close
 * it, and neither alone is enough: every guarded pool passes the approved
 * address as an array (`driverOptions`), which postgres.js uses verbatim, and
 * `assertDriverAgrees` refuses a DSN whose authority the two parsers would split
 * differently, so the user, password and database the driver sends are the ones
 * the guard saw too.
 */

const PER_POOL_MAX = 3
const CONNECT_TIMEOUT_S = 5
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000

export interface PgTarget {
  /** Hostname as written in the DSN. Display, and TLS servername. */
  host: string
  port: number
  database: string
  /** The address `assertPublicTarget` approved. This is what gets dialled. */
  address: string
  /** `sslmode` as the DSN asked for it, if it did. */
  sslMode?: string
}

/** Split a DSN without ever logging or returning the credentials in it. */
export function describeDsn(dsn: string): { host: string, port: number, database: string, sslMode?: string } {
  let url: URL
  try {
    url = new URL(dsn)
  }
  catch {
    throw createError({ statusCode: 422, message: 'That is not a valid Postgres connection string.' })
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw createError({
      statusCode: 422,
      message: `Connection string must start with postgres:// or postgresql://, not ${url.protocol}`,
    })
  }
  if (!url.hostname) {
    throw createError({ statusCode: 422, message: 'Connection string has no host.' })
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database) {
    throw createError({ statusCode: 422, message: 'Connection string has no database name.' })
  }

  return {
    // `URL.hostname` keeps the brackets on an IPv6 literal, and `isIP('[::1]')`
    // is 0 — so without stripping them the guard tries to resolve the brackets
    // as a name and refuses every IPv6 address a user could write.
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || 5432,
    database,
    sslMode: url.searchParams.get('sslmode') ?? undefined,
  }
}

/**
 * Refuse a DSN that postgres.js's own `parseUrl` would read differently from
 * `describeDsn`.
 *
 * Mirrors the driver's split verbatim — authority = everything after `://` up
 * to the first `/` or `?` — and refuses each shape where the two disagree:
 *
 * - more than one `@`: the driver's userinfo ends at the first, WHATWG's at the
 *   last, so the "host" each one sees is a different string;
 * - a `,`: the driver reads a multihost list and dials every entry in turn;
 * - a `#`: WHATWG ends the authority there, the driver does not;
 * - a `%` in the host half: the driver `decodeURIComponent`s it (so `%2C`
 *   becomes a multihost comma), WHATWG keeps a non-special scheme's host opaque.
 *
 * Only for guarded (user-supplied) DSNs. Our own configured URLs are not run
 * through the guard and may use whatever postgres.js accepts.
 */
function assertDriverAgrees(dsn: string): void {
  const authority = dsn.slice(dsn.indexOf('://') + 3).split(/[?/]/)[0] ?? ''
  const at = authority.lastIndexOf('@')
  const userinfo = at === -1 ? '' : authority.slice(0, at)
  const host = authority.slice(at + 1)

  if (userinfo.includes('@')) {
    throw createError({
      statusCode: 422,
      message: 'Connection string has more than one @. Percent-encode an @ in the user name or password as %40.',
    })
  }
  if (authority.includes(',')) {
    throw createError({ statusCode: 422, message: 'Connection string names more than one host; only one is supported.' })
  }
  if (authority.includes('#')) {
    throw createError({
      statusCode: 422,
      message: 'Connection string has a # before its database name. Percent-encode a # in the user name or password as %23.',
    })
  }
  if (host.includes('%')) {
    throw createError({ statusCode: 422, message: 'Connection string host must not be percent-encoded.' })
  }
}

/** Parse, then run the host guard. Throws 422 with something a person can act on. */
export async function resolvePgTarget(dsn: string): Promise<PgTarget> {
  assertDriverAgrees(dsn)
  const parsed = describeDsn(dsn)
  const approved = await assertPublicTarget(parsed.host, parsed.port, 'Database host')
  return { ...parsed, address: approved.address }
}

/**
 * TLS settings for a pinned address.
 *
 * Dialling an IP would otherwise blank the TLS servername (postgres.js derives
 * it from the host it connects to), so a certificate issued for the hostname
 * would fail to verify — or, worse, verification would be skipped. Carry the
 * original hostname through as `servername` so pinning does not weaken TLS.
 */
function sslFor(target: PgTarget): postgres.Options<Record<string, never>>['ssl'] {
  const mode = target.sslMode
  if (!mode || mode === 'disable') return undefined
  if (mode === 'verify-full' || mode === 'verify-ca') {
    return { servername: target.host, rejectUnauthorized: true }
  }
  // `require` and `prefer` encrypt without asserting the certificate chain,
  // which is what libpq does for those modes. Named here rather than implied.
  return { servername: target.host, rejectUnauthorized: false }
}

/**
 * Driver options shared by the pool and the throwaway probe.
 *
 * The probe is the connection that *decides whether a DSN is accepted*, so it
 * has to behave exactly like the pool that will then use it. Keeping a second
 * hand-written copy of these options meant a change to the pin, to `onnotice`
 * or to `prepare` could silently apply to one and not the other.
 */
function driverOptions(target: PgTarget, options: { guard: boolean, max: number, statementTimeoutMs: number, readOnly?: boolean, jit?: boolean }) {
  const ssl = sslFor(target)

  if (options.guard && !target.address) {
    // Never fall back to letting the driver parse the host of a guarded DSN:
    // that is the parser differential `assertDriverAgrees` documents.
    throw createError({ statusCode: 500, message: 'Database host was not approved.' })
  }

  return {
    // The pin. postgres.js prefers this over the URL's hostname — and over its
    // own multihost parse of the URL, which is what makes it the pin.
    //
    // **Arrays, never strings.** A string `host` goes through postgres.js's
    // `host.split(',').map(x => x.split(':')[0])`, so `2606:4700::6810:85e5`
    // would dial host "2606" on port 4700; this pin used to be skipped for IPv6
    // for that reason, which handed the DSN back to the driver's own parser.
    // An array is used verbatim (`Array.isArray(host) ? host : …`, likewise
    // `port`), and `net.connect` takes an unbracketed IPv6 literal, so every
    // approved address is pinned, whatever its family.
    ...(options.guard && pinTo(target)),
    // Only when there is one: an explicit `ssl: undefined` still counts as
    // present to postgres.js's `k in o ? o[k] : query[k]`, which would override
    // a DSN's own `?ssl=true` or `?sslrootcert=…` and silently connect in the
    // clear.
    ...(options.guard && ssl !== undefined && { ssl }),
    max: options.max,
    // 5s, not the 30s default. A bad DSN has to fail the MCP call quickly; a
    // tool that hangs for half a minute reads to a client as a hung server.
    connect_timeout: CONNECT_TIMEOUT_S,
    // Pointing at a transaction-mode pooler (Supabase, Neon, pgbouncer) is the
    // common case, and a named prepared statement does not survive one.
    prepare: false,
    // A NOTICE payload can carry row data — a RAISE NOTICE in a trigger — and
    // would land in the process log, which is the one place this must not leak
    // to. `mcp.logging` is off for the same reason.
    onnotice: () => {},
    connection: {
      application_name: 'claude-mcp-connector',
      statement_timeout: options.statementTimeoutMs,
      ...(options.readOnly && { default_transaction_read_only: true }),
      ...(options.jit === false && { jit: 'off' }),
    },
  }
}

/**
 * The pin, as the one-element arrays postgres.js uses verbatim. See `driverOptions`.
 *
 * The cast is the driver's typings, not ours: `parseOptions` accepts an array
 * for both (`Array.isArray(host) ? host : …`) and dials `host[i]` / `port[i]`,
 * but `Options` declares `host: string` and `port: number`. Same situation as
 * the `simple` flag `unsafeSingle()` casts for. Re-verify on a postgres.js bump.
 */
function pinTo(target: PgTarget): { host: string, port: number } {
  return {
    host: [target.address] as unknown as string,
    port: [target.port] as unknown as number,
  }
}

export interface KeyedPoolOptions {
  /**
   * Run the host guard and dial the address it approved.
   *
   * **True for anything a user typed, false only for a value that came from
   * runtimeConfig — and the asymmetry is deliberate.** This deployment's own
   * `NUXT_EVOLUTION_DATABASE_URL` legitimately sits on a private compose
   * network, and `net-guard.ts` lists it as our own infrastructure, so guarding
   * it would correctly refuse it. Guarding a user-supplied URL is what stops one
   * pointing at that same database.
   */
  guard: boolean
  max?: number
  statementTimeoutMs?: number
  /**
   * Open every session with `default_transaction_read_only`, so a write fails
   * with 25006 whatever the role behind the URL may do.
   *
   * **A backstop, not a boundary.** The message databases are read with the
   * superuser URL in the default Railway deployment, and a superuser can turn
   * this off — but only through SQL, and the modules that pass it
   * (`evolution-db.ts`, `telegram-db.ts`) issue nothing but parameterised
   * SELECTs they wrote themselves. What it buys is that a mistake in one of
   * those modules fails instead of writing. Never set for the Postgres
   * connection kind: `run-statement` must write.
   */
  readOnly?: boolean
  /**
   * `false` opens every session with `jit = off`.
   *
   * For a pool whose queries are one-shot scans that finish in seconds: JIT
   * compiles dozens of functions per query and does not earn that back. The chat
   * listing measured 3.0 s with it and 2.3 s without on an 840k-message account.
   * Sent as a startup parameter like `statement_timeout` above, so a pooler that
   * refuses one refuses both.
   */
  jit?: boolean
  /**
   * Destroy a connection once one answer passes this many bytes, before the
   * driver has buffered the rest. See `pg-socket.ts`. Set by `withPg` only.
   */
  maxResponseBytes?: number
}

/**
 * The Postgres pool for one `key`, building it if needed.
 *
 * The caching, fingerprinting, re-approval timer and eviction are
 * `keyedResource`'s; this supplies the three Postgres-shaped pieces — how to
 * open a pool, how to close one, and how to re-check the host. `key`
 * namespaces the caller (`pg:<id>`, `evo:<id>`, `evo:default`) so two purposes
 * cannot collide on one instance id.
 */
export async function keyedPool(key: string, dsn: string, options: KeyedPoolOptions): Promise<Sql> {
  return keyedResource<Sql>(key, dsn, poolSpec(key, dsn, options))
}

/**
 * `keyedPool`, leased for as long as `fn` runs, so the pool is not swept,
 * evicted or drained under a query still running on it. See `withKeyedResource`.
 */
export async function withKeyedPool<R>(key: string, dsn: string, options: KeyedPoolOptions, fn: (sql: Sql) => Promise<R>): Promise<R> {
  return withKeyedResource<Sql, R>(key, dsn, poolSpec(key, dsn, options), fn)
}

function poolSpec(key: string, dsn: string, options: KeyedPoolOptions): KeyedResourceSpec<Sql> {
  return {
    build: async () => {
      // Unguarded means unpinned: with no approved address there is nothing to
      // substitute for the hostname, so postgres.js resolves it as usual.
      const target = options.guard
        ? await resolvePgTarget(dsn)
        : { ...describeDsn(dsn), address: '' }

      return postgres(dsn, {
        ...driverOptions(target, {
          guard: options.guard,
          max: options.max ?? PER_POOL_MAX,
          statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
          readOnly: options.readOnly,
          jit: options.jit,
        }),
        idle_timeout: 30,
        max_lifetime: 60 * 30,
        ...(options.maxResponseBytes && { socket: cappedSocketFactory(key, options.maxResponseBytes) }),
      })
    },
    destroy: sql => sql.end({ timeout: 5 }),
    // Only a user-supplied address is re-approved; omitting this for our own
    // configured URL is the `guard` asymmetry above, expressed as the absence
    // of a callback rather than as a flag `keyed-resource.ts` would have to
    // understand. `resolvePgTarget` throws if the host has since been
    // re-pointed somewhere it may not go.
    ...(options.guard && { reguard: async () => { await resolvePgTarget(dsn) } }),
  }
}

/**
 * A pool several connections share, as the message pools for this deployment's
 * own Evolution server and Telegram bridge are. Callers get `query`, never the
 * `Sql` itself, so every statement goes through the per-connection gate and a
 * new query cannot skip it by using a handle already in scope.
 *
 * **Why.** Those pools hold `PER_POOL_MAX` connections for every tenant on the
 * deployment, and postgres.js queues a statement for a free one with no timeout
 * of its own. A slow statement is cheap to cause — a scan of a large account, a
 * search — so one connection with a few in flight held every slot, and every
 * other account's reads waited behind it (GHSA-fpmx-gmx5-84vc). `query` lets each
 * connection have `SHARED_POOL_SLOTS_PER_CONNECTION` statement in flight on the
 * shared pool; the rest of its statements wait *here*, in a per-connection queue
 * of at most `SHARED_POOL_QUEUE_PER_CONNECTION`, and past that are refused with
 * 429 rather than parked without bound.
 *
 * A pool of the connection's own (a user-supplied URL) gets a pass-through
 * `query`: nobody else's reads are behind it.
 *
 * `build` must return one statement and await nothing that takes another slot
 * — a callback awaiting a second `query` for the same connection would wait on
 * itself. Fragments (`sql\`...\``) built from its `sql` are fine: postgres.js
 * runs nothing until the statement is awaited.
 */
export interface SharedPool {
  query: <T>(build: (sql: Sql) => Promise<T>) => Promise<T>
}

const SHARED_POOL_SLOTS_PER_CONNECTION = 1
const SHARED_POOL_QUEUE_PER_CONNECTION = 8

const connectionSlots = new Map<string, { active: number, waiting: Array<() => void> }>()

export function sharedPoolFor(sql: Sql, shared: boolean, connectionKey: string): SharedPool {
  if (!shared) return { query: build => build(sql) }
  return { query: build => withConnectionSlot(connectionKey, () => build(sql)) }
}

async function withConnectionSlot<T>(key: string, statement: () => Promise<T>): Promise<T> {
  let slots = connectionSlots.get(key)
  if (!slots) {
    slots = { active: 0, waiting: [] }
    connectionSlots.set(key, slots)
  }

  if (slots.active < SHARED_POOL_SLOTS_PER_CONNECTION) {
    slots.active++
  }
  else {
    if (slots.waiting.length >= SHARED_POOL_QUEUE_PER_CONNECTION) {
      throw createError({
        statusCode: 429,
        statusMessage: 'Too many reads are already running for this connection. Wait for them to finish and try again.',
      })
    }
    // Handed the slot by whoever finishes; `active` stays as it was.
    await new Promise<void>(resolve => slots.waiting.push(resolve))
  }

  try {
    return await statement()
  }
  finally {
    const next = slots.waiting.shift()
    if (next) next()
    else if (--slots.active === 0) connectionSlots.delete(key)
  }
}

/** Drop one pool by key. */
export function closeKeyedPool(key: string): Promise<void> {
  return closeKeyedResource(key)
}

/**
 * Run `fn` with the pool for a Postgres *connection* — the kind a user
 * configured as one — leased for as long as `fn` runs.
 *
 * Every Postgres-kind read and write goes through this, not a bare pool: a
 * user's query can run for minutes (`MAX_READ_TIMEOUT_MS`), and an unleased
 * pool looks idle for all of them.
 */
export async function withPg<R>(instance: Pick<AppInstance, 'id' | 'dsn'>, fn: (sql: Sql) => Promise<R>): Promise<R> {
  const dsn = instance.dsn
  if (!dsn) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This database connection has no connection string.',
    })
  }
  return withKeyedPool(`pg:${instance.id}`, dsn, { guard: true, maxResponseBytes: PG_MAX_RESPONSE_BYTES }, fn)
}

/**
 * Per answer from a user's database: twice `pg-run.ts`'s result budget, so a
 * result that merely overruns that budget gets its own clear refusal, and this
 * catches the single huge row or the server lying about lengths.
 */
export const PG_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** True when `withPg(instanceId)`'s pool hit `PG_MAX_RESPONSE_BYTES` at or after `since`. */
export function pgResponseCapTripped(instanceId: string, since: number): boolean {
  return responseCapTripped(`pg:${instanceId}`, since)
}

export function closePgPool(instanceId: string): Promise<void> {
  return closeKeyedPool(`pg:${instanceId}`)
}


/**
 * What a connection says about itself. One query, three callers: the probe at
 * save time, the dashboard's health check and `get-database-info`.
 *
 * The privilege half is read live rather than remembered from the probe: a
 * role can be granted superuser after its DSN was accepted, and a warning
 * stored at save time would then say nothing.
 */
export interface PgIdentity {
  serverVersion: string
  currentUser: string
  database: string
  superuser: boolean
  bypassRls: boolean
  canReadServerFiles: boolean
}

export async function pgIdentity(sql: Sql): Promise<PgIdentity | undefined> {
  const [row] = await sql<Array<{
    version: string
    current_user: string
    database: string
    superuser: boolean
    bypass_rls: boolean
    can_read_files: boolean
  }>>`
    SELECT current_setting('server_version') AS version,
           current_user,
           current_database() AS database,
           r.rolsuper       AS superuser,
           r.rolbypassrls   AS bypass_rls,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_roles m
             WHERE m.rolname = 'pg_read_server_files'
               AND pg_catalog.pg_has_role(current_user, m.oid, 'MEMBER')
           ) AS can_read_files
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = current_user`
  if (!row) return undefined
  return {
    serverVersion: row.version,
    currentUser: row.current_user,
    database: row.database,
    superuser: row.superuser,
    bypassRls: row.bypass_rls,
    canReadServerFiles: row.can_read_files,
  }
}

/**
 * Privileges that make the per-token table allowlist best-effort, in words for
 * the dashboard, or `undefined` when the role has none of them.
 */
export function pgPrivilegeWarning(identity: PgIdentity): string | undefined {
  const reasons = [
    identity.superuser && 'is a superuser',
    identity.bypassRls && 'bypasses row-level security',
    identity.canReadServerFiles && 'can read files on the database server',
  ].filter(Boolean)
  if (!reasons.length) return undefined
  return `The role ${identity.currentUser} ${reasons.join(', ')}. `
    + 'Table scoping on tokens for this connection is then best-effort: a query can reach data '
    + 'the plan check cannot see. Connect with a role granted only the tables you mean to share.'
}

export type PgProbe = PgIdentity

const TIMEOUT_HINT = 'The server did not answer in time. A firewall may be dropping the connection, or the server only accepts connections from an allowlist.'
const untrustedCertificate = (what: string) =>
  `The server's certificate ${what}, which sslmode=verify-full refuses. Use sslmode=require, or install a trusted certificate.`

/**
 * What the commonest probe failures mean, in words a person can act on.
 *
 * Only for the probe, whose target `net-guard` already approved — so naming
 * which of these happened tells the user about their own server, not about
 * this deployment's network. Keyed on the driver's `code`: a SQLSTATE from the
 * server, or Node's socket / TLS error code. Anything unlisted keeps the
 * generic advice, with its code still shown.
 */
const PROBE_FAILURE_HINTS: Record<string, string> = {
  '28P01': 'The server rejected the user name or password.',
  '28000': 'The server refused this user. Check the user name, and that the server allows connections from this app (pg_hba.conf, or an IP allowlist).',
  '3D000': 'That database does not exist on the server. Check the database name.',
  '53300': 'The server has no free connections. Try again, or connect through its pooler.',
  '57P03': 'The server is starting up or shutting down. Try again in a moment.',
  'ECONNREFUSED': 'Nothing accepted the connection on that host and port. Check the port, and that the server is running.',
  'CONNECT_TIMEOUT': TIMEOUT_HINT,
  'ETIMEDOUT': TIMEOUT_HINT,
  'EHOSTUNREACH': 'That host cannot be reached from this server.',
  'ENETUNREACH': 'That host cannot be reached from this server. If it has only an IPv6 address, this server may have no IPv6 route.',
  'EAFNOSUPPORT': 'That host has only an IPv6 address, and this server has no IPv6 networking.',
  'ECONNRESET': 'The server closed the connection before it was ready. If it requires SSL, add ?sslmode=require to the connection string.',
  'DEPTH_ZERO_SELF_SIGNED_CERT': untrustedCertificate('is self-signed'),
  'SELF_SIGNED_CERT_IN_CHAIN': untrustedCertificate('chain is not trusted'),
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE': untrustedCertificate('could not be verified'),
  'ERR_TLS_CERT_ALTNAME_INVALID': 'The server\'s certificate is not issued for this host name. Connect by the name on the certificate, or use sslmode=require.',
}

/**
 * `PROBE_FAILURE_HINTS`, with one case that the code alone cannot name.
 *
 * Supabase's direct host, `db.<ref>.supabase.co`, resolves only to IPv6, so on
 * a server with no outbound IPv6 — Railway among them, production included —
 * it fails with ENETUNREACH. The generic "may have no IPv6 route" is true, but
 * the fix is Supabase-specific: its Session pooler string, which is IPv4.
 * Keyed on the hostname as written, never the resolved address.
 */
function probeFailureHint(code: string | undefined, host: string): string | undefined {
  if (!code) return undefined
  // Railway answers ENETUNREACH (IPv6 stack, no route); a host with no IPv6
  // stack at all answers EAFNOSUPPORT. Same cause, same fix.
  const unreachable = code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EAFNOSUPPORT'
  if (unreachable && /\.supabase\.co$/i.test(host)) {
    return 'Supabase direct connections are IPv6-only, and this server has no IPv6 route to them. '
      + 'Use the Session pooler connection string instead (in Supabase: Connect, then Session pooler).'
  }
  return PROBE_FAILURE_HINTS[code]
}

/**
 * Open a throwaway connection to prove a DSN works, and report what is behind
 * it. Used when a connection is created, so a broken DSN fails the create
 * rather than becoming a row that fails every later tool call.
 *
 * The privilege report is not decoration. A superuser DSN makes the per-token
 * table allowlist best-effort — a superuser can read anything through a
 * function the planner cannot see into — so the UI has to be able to say so.
 * The dashboard reads it again on every health check (`pgIdentity`), not from
 * here.
 */
export async function probePgConnection(dsn: string, options: {
  /**
   * A table that must exist and be readable, as `pg_catalog.has_table_privilege`
   * spells it — e.g. `"Message"` for an Evolution database.
   *
   * Connecting is not the same as pointing at the right database. A URL with the
   * right host, user and password but the wrong database name connects happily
   * and then matches no rows, which reads as an account with no messages: the
   * exact silent-empty failure the caller is trying to remove. Naming the table
   * turns that into a refusal at save time.
   */
  requireTable?: string
} = {}): Promise<PgProbe> {
  const target = await resolvePgTarget(dsn)

  // Same options as the pool that will use this DSN, so acceptance and use
  // cannot disagree.
  const sql = postgres(dsn, driverOptions(target, { guard: true, max: 1, statementTimeoutMs: 5000 }))

  try {
    const row = await pgIdentity(sql)

    if (!row) {
      throw createError({ statusCode: 502, message: 'The database did not identify itself.' })
    }

    if (options.requireTable) {
      const [check] = await sql<Array<{ readable: boolean | null }>>`
        SELECT pg_catalog.has_table_privilege(${options.requireTable}, 'SELECT') AS readable`
        // A missing relation raises 42P01 rather than answering false.
        .catch(() => [{ readable: null }])

      if (!check?.readable) {
        throw createError({
          statusCode: 422,
          message: `Connected to ${target.host}:${target.port}/${row.database}, but its `
            + `${options.requireTable} table is not there or not readable by ${row.currentUser}. `
            + 'Check that this is the right database and that the role has SELECT on it.',
        })
      }
    }

    return row
  }
  catch (cause) {
    if ((cause as { statusCode?: number })?.statusCode) throw cause
    // The DSN carries a password; never let the driver's message, which may
    // echo connection parameters, reach the client verbatim.
    console.error(`[pg] probe failed for ${target.host}:${target.port}/${target.database}`, cause)
    const reason = (cause as { code?: unknown })?.code
    const code = typeof reason === 'string' ? reason : undefined
    const hint = probeFailureHint(code, target.host)
    throw createError({
      statusCode: 422,
      message: `Could not connect to ${target.host}:${target.port}/${target.database}. `
        + (hint ?? 'Check the host, port, database, user and password, and that this server is allowed to reach it.')
        + ` (${code ?? 'connection failed'})`,
      // Machine-readable for the error toast's Details. The code alone, never
      // the driver's message, for the reason above.
      data: { code: 'pg_connect_failed', ...(code && { reason: code }) },
    })
  }
  finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}
