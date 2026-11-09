import type { TransactionSql } from 'postgres'
import type { AppInstance } from './app-db'
import type { McpScope } from './mcp-scope'

/**
 * Running caller-supplied SQL.
 *
 * Everything a user's SQL touches goes through one of the three exported
 * functions here — read, explain, write — and all three compose the same checks
 * in the same order because all three delegate to `withGuardedStatement` —
 * which is where that order, and the reasoning for it, lives. See `pg-guard.ts`
 * for why each individual check exists and what is still open.
 */

/**
 * What Postgres calls a binary column. The only per-engine part of
 * `db-rows.ts`; everything else about serialising a cell is shared, so the two
 * SQL tool sets cannot clip or lose precision differently.
 */
const PG_SERIALISE = { binaryLabel: 'bytea' } as const

const MIB = 1024 * 1024

/**
 * Most a read or a RETURNING may hold in this process, roughly in characters.
 *
 * The process is shared by every tenant, and the row cap and cell clipping
 * both run on rows already received — so without this, `maxRows` rows of
 * `repeat('x', 32 MiB)` were all held before being clipped to 2000 characters.
 * Reads fetch in batches and stop at the first batch past it; the socket cap in
 * `pg-socket.ts` (`PG_MAX_RESPONSE_BYTES`, twice this) bounds one batch, one
 * huge row, and a server lying about lengths.
 */
const MAX_RESULT_BYTES = 8 * MIB

/**
 * Rows per FETCH, so the budget is checked before the next batch is asked for.
 * Above the tool's default page (200 + 1), which stays one round trip.
 */
const FETCH_BATCH_ROWS = 250

/** Approximate size of one row as received: what the budget counts. */
function approxRowBytes(row: Record<string, unknown>): number {
  let bytes = 0
  for (const value of Object.values(row)) {
    if (typeof value === 'string') bytes += value.length
    else if (Buffer.isBuffer(value)) bytes += value.length
    else if (value !== null && typeof value === 'object' && !(value instanceof Date)) bytes += JSON.stringify(value)?.length ?? 0
    else bytes += 8
  }
  return bytes
}

/** 413 with the way out, so the model narrows the query rather than retrying it. */
function resultTooLarge(what: string): Error {
  return createError({
    statusCode: 413,
    message: `${what} Select fewer or narrower columns, take a prefix of long values (left(col, 2000)), or ask for fewer rows.`,
  })
}

/**
 * EXPLAIN the statement and read the facts the guards need.
 *
 * One place, so the awkward cast around the toolkit-shaped response exists once
 * — both run paths were carrying their own copy of it.
 */
async function planFacts(exec: Exec, statement: string): Promise<PlanFacts> {
  // Cancellable too (through `exec`): planning alone can take seconds (a very
  // wide join, a huge IN list), and the plan check is the first thing to touch
  // user SQL.
  const explained = await exec(`EXPLAIN (FORMAT JSON, VERBOSE) ${statement}`)
  return readPlan((explained as unknown as Array<Record<string, unknown>>)[0]?.['QUERY PLAN'])
}

/**
 * The ceiling on `run-query`'s `timeoutMs`, and the number its timeout hints
 * quote, so the two cannot drift.
 *
 * Two minutes, not more, and safe at two minutes only because of two other
 * things: an abandoned request cancels its query (`cancellable`, below), and a
 * pool with a query running is never swept or evicted under it (`withPg`).
 * Without the first, a client or proxy that gives up sooner leaves the query
 * running on the customer's database and holding one of the connection's
 * three pool slots while the model retries it. Longer limits are a
 * per-connection decision, not a default.
 */
export const MAX_READ_TIMEOUT_MS = 120_000

/**
 * Await one statement, cancelling it on the database if `signal` aborts first.
 *
 * `signal` is the MCP request's (`requestAbortSignal`): it aborts when the
 * client goes away before the answer is written. `statement_timeout` is then
 * the only other thing that would stop the query, and nobody is waiting for
 * it. postgres.js's `cancel()` sends a CancelRequest on a new socket built from
 * the pool's own options, so it dials the same approved, pinned address. The
 * cancelled query rejects with 57014 "canceling statement due to user request",
 * which `isStatementTimeout` deliberately does not read as a timeout.
 *
 * Every statement of user SQL goes through it, by way of the `exec` that
 * `withGuardedStatement` hands its body — the plan, the DECLARE (which plans
 * again), the MOVE/FETCH, the write — not the catalog lookups between them,
 * which are short. An abort that lands between statements is caught here
 * before the next one is sent.
 */
async function cancellable<T>(query: PromiseLike<T> & { cancel: () => void }, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await query
  if (signal.aborted) {
    query.cancel()
    throw clientGone()
  }
  const onAbort = () => query.cancel()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await query
  }
  finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** One statement of user SQL in the guarded transaction, cancelled if the request goes away. */
type Exec = (text: string) => Promise<Awaited<ReturnType<typeof unsafeSingle>>>

/** Nobody reads this answer; it exists so the transaction rolls back and the lease is released. */
function clientGone() {
  return createError({ statusCode: 499, message: 'The client closed the request before the query finished; it was cancelled.' })
}

/**
 * The cursor `runReadQuery` opens, in one place: the explain path must plan
 * exactly the statement the read path runs, or it explains a different query.
 */
function declareCursor(statement: string): string {
  return `DECLARE _mcp NO SCROLL CURSOR FOR ${statement}`
}

export interface ReadQueryOptions {
  maxRows: number
  /** 1-based page of `maxRows` rows. */
  page: number
  timeoutMs: number
  /** Cancels the query when it aborts — the MCP request's `requestAbortSignal()`. */
  signal?: AbortSignal
  /** Return every cell whole instead of clipping at `MAX_CELL_CHARS`. */
  fullValues: boolean
}

export interface ReadQueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  hasMore: boolean
  truncatedValues: number
  elapsedMs: number
}

export interface ExplainQueryOptions {
  timeoutMs: number
  signal?: AbortSignal
}

export interface ExplainQueryResult {
  /** Postgres's own text rendering, one line per row of EXPLAIN output. */
  plan: string
  /** Lines were dropped from the end to stay under `MAX_PLAN_CHARS`. */
  planTruncated: boolean
  /** The root node's `rows=` estimate. A planner statistic, never a count. */
  estimatedRows?: number
  elapsedMs: number
}

/**
 * Cap on the plan text. A plan is one line per node plus a few detail lines
 * each, so this is hundreds of nodes — reached only by a very wide UNION or a
 * deeply nested view, where the top of the plan is the useful part anyway.
 */
const MAX_PLAN_CHARS = 20_000

/**
 * Postgres's error for a statement cut off by `statement_timeout`.
 *
 * 57014 alone is not enough: it is `query_canceled`, also raised by
 * `pg_cancel_backend` and by a client-side cancel, where advice about making
 * the query cheaper would be wrong. The message is Postgres's fixed wording.
 */
export function isStatementTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown, message?: unknown }
  return code === '57014' && typeof message === 'string' && message.includes('statement timeout')
}

/**
 * `SET LOCAL`, as bind parameters.
 *
 * `set_config(name, value, is_local := true)` is exactly `SET LOCAL`, and its
 * `value` is a plain `text` parameter — so nothing here is interpolated into
 * SQL text and there is no quoting for us to get wrong. A literal
 * `SET LOCAL search_path = <scope-derived string>` would be string-built DDL on
 * a path derived from user-chosen schema names.
 */
async function applySessionGuards(tx: TransactionSql, scope: McpScope, timeoutMs: number): Promise<void> {
  await tx`SELECT
    set_config('search_path',                         ${searchPathFor(scope)}, true),
    set_config('statement_timeout',                   ${String(timeoutMs)},    true),
    set_config('lock_timeout',                        ${'3000'},               true),
    set_config('idle_in_transaction_session_timeout', ${'15000'},              true),
    -- JIT compilation on a one-shot analytical query costs more than it saves,
    -- and its planning time counts against statement_timeout.
    set_config('jit',                                 ${'off'},                true)`
}

/**
 * Open a transaction, apply every guard, then run the statement inside it.
 *
 * **The order below is the whole security argument, and it is here exactly once.**
 * Both entry points used to carry their own copy of it, kept in step by hand
 * while this module's header claimed they "compose the same checks in the same
 * order" — a claim a reader had to verify by diffing two functions. Now the only
 * thing each one chooses is the transaction mode, the statement-kind gate, and
 * what it does once the checks have passed.
 *
 * **One transaction, not two.** The plan check and the execution share it, so
 * the `AccessShareLock` that EXPLAIN takes is still held while the statement
 * runs — which is what stops a concurrent `CREATE OR REPLACE VIEW` repointing a
 * view between the check and the execution — and both run under one
 * `SET LOCAL`, so the same text provably resolves to the same objects in both.
 */
async function withGuardedStatement<T>(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: {
    /** `sql.begin('read only')`. A `CREATE TEMP TABLE` inside it fails 25006. */
    readOnly: boolean
    timeoutMs: number
    /** `assertNoWrites` or `assertIsModify` — the only difference between the two callers. */
    assertKind: (facts: PlanFacts) => void
    signal?: AbortSignal
  },
  body: (exec: Exec, startedAt: number) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()

  const guarded = async (tx: TransactionSql): Promise<T> => {
    const exec: Exec = text => cancellable(unsafeSingle(tx, text), options.signal)
    await applySessionGuards(tx, scope, options.timeoutMs)

    // Before the EXPLAIN, not after: Postgres folds an IMMUTABLE function with
    // constant arguments *during* planning, so a plan that came back has already
    // run it and no longer names it. See `functionNamesInText`.
    await assertFunctionsSafe(tx, functionNamesInText(statement))

    const facts = await planFacts(exec, statement)

    options.assertKind(facts)
    // Again from the plan, which catches what the text cannot — a function
    // reached through a view.
    await assertFunctionsSafe(tx, facts.functions)
    await assertRelationsInScope(tx, facts, scope)

    return await body(exec, startedAt)
  }

  // Leased, so the pool is not swept or evicted under a query that runs for
  // minutes. See `withPg`.
  try {
    return await withPg(instance, async sql => options.readOnly
      ? await sql.begin('read only', guarded) as T
      : await sql.begin(guarded) as T)
  }
  catch (error) {
    // The socket cap closed the connection mid-answer; the driver only says
    // CONNECTION_CLOSED. Closing it aborted the transaction, so a write was
    // rolled back by the server.
    if (pgResponseCapTripped(instance.id, startedAt)) {
      throw resultTooLarge(`The database sent more than ${PG_MAX_RESPONSE_BYTES / MIB} MiB in one answer, `
        + 'so the connection was closed: nothing was returned, and a write was rolled back.')
    }
    throw error
  }
}

export async function runReadQuery(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: ReadQueryOptions,
): Promise<ReadQueryResult> {
  // Postgres's own "canceling statement due to statement timeout" tells the
  // model nothing it can act on, and the usual next move is to retry the same
  // query with a bigger timeout. The plan is the thing that says why.
  return await timeoutAs504(
    guardedRead(instance, scope, statement, options),
    `The query was stopped by the ${options.timeoutMs} ms statement timeout and returned no rows. `
    + 'Call run-query again with the same sql and explain: true to see the plan it would run, without running it: '
    + 'a Seq Scan over a large table, or a join with no usable index, is the usual cause. '
    + `Then add a selective WHERE clause on an indexed column, aggregate instead of listing, or raise timeoutMs (at most ${MAX_READ_TIMEOUT_MS}).`
    + (options.page > 1
      ? ` Page ${options.page} also re-reads every row of the pages before it; a keyset predicate (WHERE id > <last id>) avoids that.`
      : ''),
  )
}

/** A statement timeout answered as a 504 that says what to do next; anything else as thrown. */
async function timeoutAs504<T>(work: Promise<T>, message: string): Promise<T> {
  try {
    return await work
  }
  catch (error) {
    if (!isStatementTimeout(error)) throw error
    throw createError({ statusCode: 504, message })
  }
}

async function guardedRead(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: ReadQueryOptions,
): Promise<ReadQueryResult> {
  return await withGuardedStatement(instance, scope, statement, {
    readOnly: true,
    timeoutMs: options.timeoutMs,
    assertKind: assertNoWrites,
    signal: options.signal,
  }, async (exec, startedAt) => {
    // The statement-kind gate, enforced by Postgres's own grammar rather than by
    // parsing: DECLARE CURSOR refuses INSERT/UPDATE/DELETE/CREATE TABLE AS
    // outright, refuses SELECT ... INTO by name, and answers 0A000 for a
    // data-modifying WITH. Two of those — CTAS and SELECT INTO — plan to a bare
    // Result node with no target relation, so the relation check above cannot
    // see them at all.
    await exec(declareCursor(statement))

    // Paging moves the same cursor, never wraps the statement in OFFSET: a wrap
    // would reopen everything DECLARE CURSOR closes above. Each page is its own
    // transaction and re-runs the query, so pages line up only under an ORDER BY
    // on a unique key, and MOVE still reads every row it skips.
    if (options.page > 1) {
      await exec(`MOVE FORWARD ${(options.page - 1) * options.maxRows} FROM _mcp`)
    }

    // One row past the cap, so `hasMore` is "the page came back full" rather
    // than a count that could be wrong — the same rule as MessagePage. Fetched
    // in batches from the same cursor, so the byte budget is checked before the
    // next batch is held rather than after the whole page is.
    const want = options.maxRows + 1
    const raw: Array<Record<string, unknown>> = []
    let columns: string[] | undefined
    let bytes = 0
    while (raw.length < want) {
      const ask = Math.min(FETCH_BATCH_ROWS, want - raw.length)
      // The FETCH is where the query actually runs — DECLARE only plans it —
      // so it is what a client disconnect cancels.
      const batch = await exec(`FETCH FORWARD ${ask} FROM _mcp`) as unknown as Array<Record<string, unknown>> & { columns?: Array<{ name: string }> }
      columns ??= batch.columns?.map(c => c.name)
      for (const row of batch) {
        bytes += approxRowBytes(row)
        raw.push(row)
      }
      if (bytes > MAX_RESULT_BYTES) throw resultTooLarge(`This page of the result is more than ${MAX_RESULT_BYTES / MIB} MiB, so no rows were returned.`)
      if (batch.length < ask) break
    }

    const hasMore = raw.length > options.maxRows
    const kept = raw.slice(0, options.maxRows)

    const { rows, truncatedValues } = serialiseRows(kept, { ...PG_SERIALISE, fullValues: options.fullValues })

    return {
      columns: columns ?? Object.keys(kept[0] ?? {}),
      rows,
      rowCount: rows.length,
      hasMore,
      truncatedValues,
      elapsedMs: Date.now() - startedAt,
    }
  })
}

/**
 * The plan `runReadQuery` would run for this statement, without running it.
 *
 * **Same guards, same order, nothing new reaches the database.** It goes
 * through `withGuardedStatement` like the read path, so the text-level function
 * check runs before any planning (planning folds IMMUTABLE functions), and the
 * relation and function gates have passed before a line of plan comes back: a
 * plan this returns can only name relations the token may read, plus the
 * catalogs. The guard already EXPLAINs every statement; this is the one path
 * that shows the caller a plan.
 *
 * **`EXPLAIN DECLARE`, not `EXPLAIN <statement>`.** `runReadQuery` executes
 * through a cursor, and Postgres plans a cursor differently — for fast start
 * (`cursor_tuple_fraction`), and never in parallel. Verified on Postgres 16: the
 * same `ORDER BY` planned to a parallel sort as a bare EXPLAIN and to an index
 * scan as a cursor. Explaining the bare statement would show a plan run-query
 * never runs. `EXPLAIN DECLARE` without ANALYZE opens no cursor, and it is
 * refused for exactly what `DECLARE` refuses — INSERT/UPDATE/DELETE by grammar,
 * `SELECT … INTO` by name, a data-modifying WITH with 0A000 — so it is also the
 * statement-kind gate here, the same one the read path relies on.
 *
 * **The options are ours, never the caller's.** The caller sends a query, not
 * EXPLAIN text, so `ANALYZE` — which executes the statement, triggers included
 * — cannot be asked for, nor `SETTINGS`, which would disclose the server's
 * non-default configuration. Text format, costs on, not VERBOSE: VERBOSE's
 * per-node `Output` lists are most of its bulk and the least of its use.
 */
export async function explainReadQuery(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: ExplainQueryOptions,
): Promise<ExplainQueryResult> {
  const explaining = withGuardedStatement(instance, scope, statement, {
    readOnly: true,
    timeoutMs: options.timeoutMs,
    assertKind: assertNoWrites,
    signal: options.signal,
  }, async (exec, startedAt) => {
    const explained = await exec(`EXPLAIN (FORMAT TEXT, COSTS) ${declareCursor(statement)}`)
    const lines = (explained as unknown as Array<Record<string, unknown>>)
      .map(row => row['QUERY PLAN'])
      .filter((line): line is string => typeof line === 'string')

    // Whole lines only: a node cut mid-line reads as a different node.
    const kept: string[] = []
    let length = 0
    for (const line of lines) {
      if (length + line.length + 1 > MAX_PLAN_CHARS) break
      kept.push(line)
      length += line.length + 1
    }

    // The root line is always `<node>  (cost=a..b rows=N width=W)` with costs
    // on. Read from the cursor plan rather than the guard's JSON plan, which
    // is planned without cursor options and can be a different shape.
    const rows = /\brows=(\d+)\b/.exec(lines[0] ?? '')?.[1]

    return {
      plan: kept.join('\n'),
      planTruncated: kept.length < lines.length,
      ...(rows !== undefined && { estimatedRows: Number(rows) }),
      elapsedMs: Date.now() - startedAt,
    }
  })

  return await timeoutAs504(
    explaining,
    `Planning the query alone took longer than the ${options.timeoutMs} ms statement timeout, so there is no plan to show. `
    + `Raise timeoutMs (at most ${MAX_READ_TIMEOUT_MS}), or split the query: very many joined tables or a large IN list are the usual causes.`,
  )
}

export interface WriteStatementResult {
  command: string
  rowCount: number
  returning: Array<Record<string, unknown>>
  /** Cells clipped at the length cap, so a shortened value is never silent. */
  truncatedValues: number
  elapsedMs: number
}

export interface WriteStatementOptions {
  maxRows: number
  timeoutMs: number
  /** Return every cell whole instead of clipping at `MAX_CELL_CHARS`. */
  fullValues: boolean
  allowWholeTable?: boolean
  /** Cancels the statement when it aborts; the transaction then rolls back. */
  signal?: AbortSignal
}

export async function runWriteStatement(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: WriteStatementOptions,
): Promise<WriteStatementResult> {
  return await withGuardedStatement(instance, scope, statement, {
    readOnly: false,
    timeoutMs: options.timeoutMs,
    // The kind gate for writes. CTAS and SELECT INTO plan to a bare Result and
    // REFRESH answers "Utility Statement" — none of them has a ModifyTable root,
    // so requiring one refuses all three as well as a plain SELECT sent here by
    // mistake.
    assertKind: facts => assertIsModify(facts, options.allowWholeTable),
    signal: options.signal,
  }, async (exec, startedAt) => {
    // A cancelled write rejects, so the transaction rolls back: nothing changed.
    const result = await exec(statement)
    const rows = result as unknown as Array<Record<string, unknown>> & { count: number, command: string }

    // A hard cap, not a report. Throwing here rolls the transaction back, so a
    // statement whose WHERE clause turned out to be wider than the caller
    // intended changes nothing at all — which is the only version of this cap
    // worth having.
    if (rows.count > options.maxRows) {
      throw createError({
        statusCode: 409,
        message: `That statement would have changed ${rows.count.toLocaleString('en-US')} rows but maxRows was ${options.maxRows}, so nothing was changed. `
          + 'Narrow the WHERE clause, or raise maxRows if that number is what you meant.',
      })
    }

    // Same budget as a read, and the same consequence as the row cap: throwing
    // rolls the statement back. The socket cap has already bounded what arrived.
    if (rows.reduce((sum, row) => sum + approxRowBytes(row), 0) > MAX_RESULT_BYTES) {
      throw resultTooLarge(`The RETURNING rows are more than ${MAX_RESULT_BYTES / MIB} MiB, so the statement was rolled back and nothing was changed.`)
    }

    const serialised = serialiseRows([...rows], { ...PG_SERIALISE, fullValues: options.fullValues })

    return {
      command: rows.command,
      rowCount: rows.count,
      returning: serialised.rows,
      truncatedValues: serialised.truncatedValues,
      elapsedMs: Date.now() - startedAt,
    }
  })
}

