import { z } from 'zod'

/**
 * The one write tool.
 *
 * `destructiveHint: true`, unlike `send-text-message`, which is deliberately
 * `false` because sending adds a message rather than replacing one. An UPDATE
 * or DELETE replaces and removes, so this is the opposite case — do not "fix"
 * the asymmetry for consistency.
 *
 * Deliberately not in the default token selection for a new Postgres connection.
 */
export default defineKindTool({
  name: 'run-statement',
  kind: ['postgres'],
  group: 'sql',
  title: 'Run a data-modifying SQL statement',
  description:
    'Run one INSERT, UPDATE, DELETE or MERGE and report how many rows it changed. '
    + 'Exactly one statement; DDL, TRUNCATE, COPY and CREATE TABLE AS are refused. '
    + 'Every table it reads or writes must be inside this connector\'s allowlist. '
    + 'It runs inside a transaction with a row cap: if the statement turns out to '
    + 'affect more rows than `maxRows`, the whole transaction is rolled back and '
    + 'NOTHING changes — so set `maxRows` to what you actually intend to change, '
    + 'and read a cap error as "my WHERE clause was wider than I thought" rather '
    + 'than as a limit to raise blindly. An UPDATE or DELETE with no WHERE clause '
    + 'is refused unless you pass `allowWholeTable: true`, which is deliberately '
    + 'a separate decision from the SQL. Add RETURNING when you need to see what '
    + 'changed; returned cells are clipped at 2000 characters unless you pass '
    + '`fullValues: true`. This tool cannot see '
    + 'inside triggers: a write to an allowed table may cascade to tables outside '
    + 'the allowlist, and the allowlist cannot stop that. Confirm destructive '
    + 'changes with the user before calling this.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    sql: z.string().min(1).max(20_000).describe('One INSERT, UPDATE, DELETE or MERGE statement'),
    maxRows: z.number().int().min(1).default(100).describe('Roll the whole statement back if it would affect more rows than this'),
    timeoutMs: z.number().int().min(500).max(60_000).default(15_000).describe('Server-side statement timeout, in milliseconds'),
    allowWholeTable: z.boolean().default(false).describe(
      'Permit an UPDATE or DELETE with no WHERE clause. Off by default: a missing '
      + 'WHERE is far more often a mistake than an intention. `maxRows` still applies.',
    ),
    fullValues: z.boolean().default(false).describe(
      'Return every cell whole instead of clipping each at 2000 characters. Set it '
      + 'only when you need a long text or JSON value in full: a page of large cells '
      + 'can make a very large response.',
    ),
  },
  handler: async ({ sql, maxRows, timeoutMs, allowWholeTable, fullValues }) => {
    const { instance, scope } = useMcpAuth()

    const result = await runSqlWrite(instance, scope, sql.trim(), { maxRows, timeoutMs, allowWholeTable, fullValues, signal: requestAbortSignal() })

    return {
      command: result.command,
      rowCount: result.rowCount,
      maxRows,
      elapsedMs: result.elapsedMs,
      ...(result.returning.length > 0 && { returning: result.returning }),
      ...(result.truncatedValues > 0 && {
        truncatedValues: result.truncatedValues,
        truncatedValuesNote: 'Some returned values were clipped at 2000 characters and end with an ellipsis. Pass fullValues: true to get them whole.',
      }),
      ...(!scope.allTables && { scopedToAllowlist: true }),
    }
  },
})
