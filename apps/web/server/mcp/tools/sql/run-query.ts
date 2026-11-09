import { z } from 'zod'

/**
 * Read tool for caller-written SQL.
 *
 * Four gates, in `pg-run.ts` and `pg-guard.ts`: the extended protocol (one
 * statement), the plan walk against the table allowlist, the function gate, and
 * a read-only transaction. `DECLARE CURSOR` does the statement-kind check by
 * Postgres's own grammar, and the same cursor gives the row cap (FETCH) and
 * paging (MOVE) without ever wrapping the statement.
 *
 * `explain: true` returns the plan that cursor would run instead of its rows —
 * through the same guards, see `explainReadQuery`. A flag rather than its own
 * tool: anyone allowed to run a query is allowed to see its plan, so a separate
 * tool would only add a scope choice with no meaning, and every token already
 * granted `run-query` by name gets it without re-scoping. The answer has a
 * different shape and no `rows` key on purpose — a plan must never read as an
 * empty result.
 */
export default defineKindTool({
  name: 'run-query',
  kind: ['postgres'],
  group: 'sql',
  title: 'Run a read-only SQL query',
  description:
    'Run one read-only SQL statement and return its rows. Exactly one statement — '
    + 'a second one after a semicolon is rejected by the database, not silently '
    + 'run. It executes inside a read-only transaction with a statement timeout, '
    + 'so nothing it does can change data, and every table it touches must be '
    + 'inside this connector\'s allowlist: the planner is asked which relations '
    + 'the query resolves to, through views and CTEs included, before a single row '
    + 'is read, and a query that reaches outside is refused with the offending '
    + 'table named. Functions this connector cannot see inside — anything outside '
    + 'pg_catalog — are refused too, so a query calling a helper function must be '
    + 'rewritten against the tables directly. Prefer describe-table over SELECT * '
    + 'on a wide table. The result is ONE PAGE of at most `maxRows` rows: when '
    + '`hasMore` is true you have NOT seen the whole result — call again with '
    + '`page: nextPage`. Each page re-runs the query, so pages only line up when '
    + 'it has an ORDER BY on a unique column; add one before paging. For very deep '
    + 'results a keyset predicate (WHERE id > <last id>) is cheaper than a high '
    + 'page number. Long cells are clipped at 2000 characters unless you pass '
    + '`fullValues: true`. Never summarise a `hasMore: true` result as if it were '
    + 'the full answer. Pass `explain: true` to get the query plan instead of rows '
    + '— nothing is executed — when a query timed out or you need to know why it is '
    + 'slow; its row figures are planner estimates, never counts.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    // Repeatable, but not guaranteed to give the same rows twice — the hint
    // describes the call, and the data underneath it moves.
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    sql: z.string().min(1).max(20_000).describe('One SQL query: SELECT, WITH … SELECT, VALUES or TABLE. Not a write.'),
    maxRows: z.number().int().min(1).max(1000).default(200).describe(
      'Rows per page, at most 1000. For more rows, keep this and walk `page` with nextPage '
      + '— add an ORDER BY on a unique column first so the pages line up. The query is '
      + 'stopped at this many rather than truncated afterwards.',
    ),
    page: z.number().int().min(1).default(1).describe(
      '1-based page of `maxRows` rows. Walk it up with nextPage while hasMore is true; '
      + 'pages are consistent only under an ORDER BY on a unique column.',
    ),
    timeoutMs: z.number().int().min(500).max(MAX_READ_TIMEOUT_MS).default(10_000).describe('Server-side statement timeout, in milliseconds'),
    fullValues: z.boolean().default(false).describe(
      'Return every cell whole instead of clipping each at 2000 characters. Set it '
      + 'only when you need a long text or JSON value in full: a page of large cells '
      + 'can make a very large response.',
    ),
    explain: z.boolean().default(false).describe(
      'Return the plan this query would run instead of its rows. The query is planned, '
      + 'not executed, so it costs about as much as the planning alone. Use it after a '
      + 'timeout, or to find out why a query is slow — a Seq Scan over a large table or '
      + 'a join with no usable index — before rewriting it. maxRows, page and fullValues '
      + 'are ignored. The row figures in a plan are estimates from table statistics: '
      + 'never report them as how many rows match.',
    ),
  },
  handler: async ({ sql, maxRows, page, timeoutMs, fullValues, explain }) => {
    const { instance, scope } = useMcpAuth()
    // The query is cancelled on the database if the client goes away first.
    const signal = requestAbortSignal()

    if (explain) {
      const result = await explainSqlRead(instance, scope, sql.trim(), { timeoutMs, signal })
      return {
        explain: true,
        plan: result.plan,
        ...(result.planTruncated && { planTruncated: true }),
        ...(result.estimatedRows !== undefined && { estimatedRows: result.estimatedRows }),
        elapsedMs: result.elapsedMs,
        note: 'This is the plan run-query would use for this sql; the query was not run and no rows were read. '
          + 'rows= and cost= in it are planner estimates from table statistics, and estimatedRows is the top one — '
          + 'never report them as how many rows match. Call run-query without explain to get the rows.'
          + (result.planTruncated ? ' The plan was too long and its last lines were dropped.' : ''),
        ...(!scope.allTables && { scopedToAllowlist: true }),
      }
    }

    const result = await runSqlRead(instance, scope, sql.trim(), { maxRows, page, timeoutMs, fullValues, signal })

    return {
      columns: result.columns,
      rowCount: result.rowCount,
      // Same rule as read-messages: wrong only in the safe direction. A page
      // that came back full reports true even when it happened to be the last.
      hasMore: result.hasMore,
      ...(result.hasMore && { nextPage: page + 1 }),
      page,
      maxRows,
      elapsedMs: result.elapsedMs,
      ...(result.hasMore && {
        note: `Page ${page} of at most ${maxRows} rows; there is at least one more row. `
          + 'Call again with page: nextPage. Pages line up only if the query has an ORDER BY on a unique column — '
          + 'without one, rows can repeat or be skipped between pages.',
      }),
      // A second kind of truncation needs a second announcement: a clipped cell
      // that says nothing reads as the real value.
      ...(result.truncatedValues > 0 && {
        truncatedValues: result.truncatedValues,
        truncatedValuesNote: 'Some values were clipped at 2000 characters and end with an ellipsis. Pass fullValues: true to get them whole, or select a substring or an aggregate.',
      }),
      ...(!scope.allTables && { scopedToAllowlist: true }),
      rows: result.rows,
    }
  },
})
