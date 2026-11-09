import { assertNever } from '#shared/connection'
import type { InstanceKind } from '#shared/connection'
import type { AppInstance } from './app-db'
import type { McpScope } from './mcp-scope'
import type { ListTablesOptions, PgTable, PgTablePage, PgTableDescription } from './pg-catalog'
import type { ExplainQueryOptions, ExplainQueryResult, ReadQueryOptions, ReadQueryResult, WriteStatementOptions, WriteStatementResult } from './pg-run'

/**
 * The one place that decides which SQL engine a connection speaks.
 *
 * Every tool in `server/mcp/tools/sql/` and the two database API routes go
 * through here and never name an engine, which is what lets one tool set serve
 * more than one kind. Adding an engine means adding an arm to each function
 * below and nothing at the call sites.
 *
 * **Dispatch functions rather than an adapter interface, deliberately.** An
 * interface would make each method's doc comment the union of every engine's
 * contract, and put the guard reasoning behind a boundary where a reader at the
 * call site can no longer see which checks ran — and `pg-guard.ts`'s header is
 * a security argument written for one engine, which cannot be written once for
 * two. The exhaustiveness is a wash (a `Record<SqlKind, …>` and a `switch …
 * assertNever` both fail to compile on a new engine); what a switch adds is
 * that an engine-specific option produces a compile error at the dispatch site
 * rather than a silently ignored field.
 *
 * `sqlKindOf` follows `alertableKind()` in `alerts.ts` — this repo already has
 * that idiom for "the kinds that share a capability".
 */

/** The kinds that are a SQL database. */
export type SqlKind = Extract<InstanceKind, 'postgres'>

export const SQL_KINDS = ['postgres'] as const satisfies readonly SqlKind[]

/**
 * The SQL kind of a connection, or `undefined` for one that is not a database.
 *
 * Reads through `instanceKind()` like everything else, so a row whose kind this
 * build does not recognise throws rather than being treated as anything.
 */
export function sqlKindOf(instance: Pick<AppInstance, 'kind'>): SqlKind | undefined {
  const kind = instanceKind(instance)
  switch (kind) {
    case 'postgres':
      return kind
    case 'whatsapp':
    case 'telegram':
    case 'imap':
      return undefined
    default:
      return assertNever(kind, 'connection kind')
  }
}

/**
 * The SQL kind of a connection, or a 500.
 *
 * For the paths that only ever run on a database — the SQL tools, whose
 * `enabled` gate already established the kind, and the routes behind
 * `requireReadableInstanceOfKinds(SQL_KINDS)`. Reaching here with a messaging
 * connection means a gate upstream is wrong, which is a bug in this build and
 * not something a caller can fix, so it is a 500 and it is logged.
 */
function requireSqlKind(instance: Pick<AppInstance, 'id' | 'kind'>): SqlKind {
  const kind = sqlKindOf(instance)
  if (!kind) {
    console.error(`[sql] connection ${instance.id} is not a database, but a database path was reached`)
    throw createError({ statusCode: 500, statusMessage: 'Not a database connection' })
  }
  return kind
}

/**
 * Shared result shapes.
 *
 * Aliased rather than redeclared while Postgres is the only engine: inventing a
 * second set of identical types now would be churn, and the one place they will
 * genuinely need widening — `PgTable.kind`, whose union names Postgres relkinds
 * another engine does not have — is better widened when there is a second
 * engine to widen it for than guessed at in advance.
 */
export type SqlTable = PgTable
export type SqlTablePage = PgTablePage
export type SqlTableDescription = PgTableDescription

// `ListTablesOptions`, `ReadQueryOptions`, `ReadQueryResult`, `ExplainQueryOptions`,
// `ExplainQueryResult`, `WriteStatementOptions` and `WriteStatementResult` are deliberately NOT re-exported under the same
// names. Nuxt auto-imports server utils by export name, so a second module
// exporting a name it already has makes the resolution order decide which one
// a call site gets — it warns, picks one, and nothing in the source says
// which. They are imported as types here and stay owned by `pg-run.ts` and
// `pg-catalog.ts` until a second engine gives them a reason to move.

export interface SqlIdentity {
  /** e.g. `PostgreSQL 16.4`. Engine included, because the caller no longer knows it. */
  server: string
  database: string
  currentUser: string
  /** Whether the role bypasses every grant, so table scoping is best-effort. */
  superuser: boolean
  /** Why table scoping is best-effort on this role, in words; absent when it is not. */
  privilegeWarning?: string
}

export async function listSqlTables(
  instance: Pick<AppInstance, 'id' | 'kind' | 'dsn'>,
  scope: McpScope,
  options: ListTablesOptions,
): Promise<SqlTablePage> {
  const kind = requireSqlKind(instance)
  switch (kind) {
    case 'postgres':
      return listPgTables(instance, scope, options)
    default:
      return assertNever(kind, 'SQL kind')
  }
}

export async function describeSqlTable(
  instance: Pick<AppInstance, 'id' | 'kind' | 'dsn'>,
  scope: McpScope,
  schema: string,
  name: string,
): Promise<SqlTableDescription | undefined> {
  const kind = requireSqlKind(instance)
  switch (kind) {
    case 'postgres':
      return describePgTable(instance, scope, schema, name)
    default:
      return assertNever(kind, 'SQL kind')
  }
}

export async function runSqlRead(
  instance: Pick<AppInstance, 'id' | 'kind' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: ReadQueryOptions,
): Promise<ReadQueryResult> {
  const kind = requireSqlKind(instance)
  switch (kind) {
    case 'postgres':
      return runReadQuery(instance, scope, statement, options)
    default:
      return assertNever(kind, 'SQL kind')
  }
}

/**
 * The plan `runSqlRead` would run, without running it. A second engine owes
 * the same promise — the plan it would actually execute, through the same
 * guards — or should refuse; the plan text itself is the engine's own.
 */
export async function explainSqlRead(
  instance: Pick<AppInstance, 'id' | 'kind' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: ExplainQueryOptions,
): Promise<ExplainQueryResult> {
  const kind = requireSqlKind(instance)
  switch (kind) {
    case 'postgres':
      return explainReadQuery(instance, scope, statement, options)
    default:
      return assertNever(kind, 'SQL kind')
  }
}

export async function runSqlWrite(
  instance: Pick<AppInstance, 'id' | 'kind' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: WriteStatementOptions,
): Promise<WriteStatementResult> {
  const kind = requireSqlKind(instance)
  switch (kind) {
    case 'postgres':
      return runWriteStatement(instance, scope, statement, options)
    default:
      return assertNever(kind, 'SQL kind')
  }
}

/**
 * What the connection says about itself, in one shape for every engine.
 *
 * `server` carries the engine's own name because the caller no longer knows
 * which engine answered — `get-database-info` used to write "PostgreSQL"
 * itself, which would have been a lie on any other connection.
 */
export async function sqlIdentity(
  instance: Pick<AppInstance, 'id' | 'kind' | 'dsn'>,
): Promise<SqlIdentity | undefined> {
  const kind = requireSqlKind(instance)
  switch (kind) {
    case 'postgres': {
      const identity = await withPg(instance, pgIdentity)
      if (!identity) return undefined
      return {
        server: `PostgreSQL ${identity.serverVersion}`,
        database: identity.database,
        currentUser: identity.currentUser,
        superuser: identity.superuser,
        privilegeWarning: pgPrivilegeWarning(identity),
      }
    }
    default:
      return assertNever(kind, 'SQL kind')
  }
}

/** Drop this connection's pool, so a rotated DSN takes effect now. */
export async function closeSqlPool(instance: Pick<AppInstance, 'id' | 'kind'>): Promise<void> {
  const kind = requireSqlKind(instance)
  switch (kind) {
    case 'postgres':
      return closePgPool(instance.id)
    default:
      return assertNever(kind, 'SQL kind')
  }
}
