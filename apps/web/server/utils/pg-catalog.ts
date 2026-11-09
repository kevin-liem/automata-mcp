import type { Sql } from 'postgres'
import type { AppInstance } from './app-db'
import type { McpScope } from './mcp-scope'

/**
 * Schema introspection for a user's Postgres connection.
 *
 * Shared by the MCP tools and by the token scope picker, so what a model can
 * see and what an owner can grant are computed by the same query. Two lists
 * that could disagree about which tables exist would be a support problem the
 * first time they did.
 *
 * **Scope is a predicate, never a post-filter.** The allowlist goes into the
 * WHERE clause, so out-of-scope names never enter this process — the same rule
 * `evolution-db.ts` follows for chat scope, and the reason `hasMore` here means
 * "more tables *you can see*" rather than "more rows we then hid from you".
 */

export interface PgTable {
  schema: string
  name: string
  qname: string
  kind: 'table' | 'partitioned table' | 'view' | 'materialized view' | 'foreign table'
  comment?: string
  /**
   * `pg_class.reltuples`, which is a planner statistic and not a count. Null
   * until the table has been analysed. Named `estimatedRows` everywhere it is
   * surfaced, because a number labelled `rows` will be quoted as a fact.
   */
  estimatedRows: number | null
}

export interface PgTablePage {
  tables: PgTable[]
  hasMore: boolean
}

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema']

/**
 * Ceiling for one page of tables. The scope picker asks for a big page because
 * it renders a checkbox list; a database with more relations than this pages,
 * and the caller is told it did.
 */
export const MAX_TABLE_PAGE = 1000

export interface ListTablesOptions {
  schema?: string
  search?: string
  limit: number
  page: number
}

export async function listPgTables(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  options: ListTablesOptions,
): Promise<PgTablePage> {
  return await withPg(instance, sql => listTablesWith(sql, scope, options))
}

async function listTablesWith(sql: Sql, scope: McpScope, options: ListTablesOptions): Promise<PgTablePage> {
  const offset = (options.page - 1) * options.limit
  const pattern = options.search ? `%${escapeLike(options.search)}%` : null

  const rows = await sql<Array<{
    schema: string
    name: string
    kind: string
    comment: string | null
    estimated_rows: string | null
  }>>`
    SELECT n.nspname AS schema,
           c.relname AS name,
           c.relkind AS kind,
           pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
           CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = ANY ('{r,p,v,m,f}')
      -- A partition is an implementation detail of its parent. Listing every
      -- child would bury the tables a caller actually addresses.
      AND NOT c.relispartition
      AND n.nspname <> ALL (${SYSTEM_SCHEMAS}::text[])
      AND n.nspname NOT LIKE 'pg\\_toast%'
      AND n.nspname NOT LIKE 'pg\\_temp%'
      -- Nothing is listed that this role could not read anyway; a name in a
      -- listing that then refuses to open is worse than an absence.
      AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
      AND (${scope.allTables}
           OR (n.nspname || '.' || c.relname) = ANY (${scope.tableNames}::text[]))
      AND (${options.schema ?? null}::text IS NULL OR n.nspname = ${options.schema ?? null})
      AND (${pattern}::text IS NULL OR c.relname ILIKE ${pattern})
    ORDER BY n.nspname, c.relname
    OFFSET ${offset}
    LIMIT ${options.limit + 1}`

  const hasMore = rows.length > options.limit

  return {
    hasMore,
    tables: rows.slice(0, options.limit).map(row => ({
      schema: row.schema,
      name: row.name,
      qname: qualifiedName(row.schema, row.name),
      kind: relkindLabel(row.kind) as PgTable['kind'],
      ...(row.comment ? { comment: row.comment } : {}),
      estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
    })),
  }
}

// Type aliases rather than interfaces, for the reason `InstanceStatus` in
// instances.ts gives: an MCP tool handler may return `Record<string, unknown>`,
// and an interface has no implicit index signature, so `describe-table` would
// fail to typecheck on the value it returns.
export type PgColumn = {
  name: string
  type: string
  nullable: boolean
  default?: string
  identity: boolean
  comment?: string
  /**
   * The labels of the column's enum type, in declaration order, for a column
   * whose type is an enum, an array of one, or a domain over one.
   *
   * `format_type` names the type and does not enumerate it, so without this a
   * `status order_status` column reads as an opaque type and a model writes
   * `WHERE status = 'cancelled'` against a type whose only values are `open`,
   * `closed` and `void`. That query runs, returns nothing, and reads as "there
   * are no cancelled orders" — a wrong answer rather than an error, which is
   * the failure this whole tool exists to prevent.
   */
  enumValues?: string[]
}

/** One end of a foreign key, as a caller would address it. */
export type PgRelationRef = {
  schema: string
  name: string
  qname: string
  columns: string[]
}

export type PgTableDescription = {
  schema: string
  name: string
  qname: string
  kind: string
  comment?: string
  estimatedRows: number | null
  /**
   * `pg_get_viewdef` for a view or materialized view, and absent for a table.
   *
   * For a view this is the field-relationship documentation: it names the base
   * tables and the join keys, which nothing else in this description carries —
   * a view has no primary key, no foreign keys and (unless materialized) no
   * indexes, so without it a view describes as a bag of columns with no stated
   * relationship to anything.
   */
  viewDefinition?: string
  /** The definition was longer than {@link MAX_VIEW_DEFINITION} and was clipped. */
  viewDefinitionTruncated?: boolean
  columns: PgColumn[]
  primaryKey: string[]
  /** Foreign keys declared *on* this table: where its rows point. */
  foreignKeys: Array<{
    name: string
    definition: string
    columns: string[]
    references: PgRelationRef
    /**
     * Whether the referenced table is one this connector can describe and
     * query. A key may point at a table outside the token's allowlist; saying
     * so is what stops a model burning a round trip on a `describe-table` that
     * is going to refuse. The referenced name is disclosed either way, because
     * `definition` has always carried it.
     */
    reachable: boolean
  }>
  /**
   * Foreign keys declared on *other* tables that point at this one.
   *
   * Only reachable tables are listed, and the asymmetry with `foreignKeys` is
   * deliberate: an out-of-scope inbound row would be a table name this token
   * was never granted, disclosed by a description of a table that was. What is
   * reported instead is {@link PgTableDescription.referencedByOutOfScope}, a
   * count — the same trade `list-tables` already makes with `allowlistSize`,
   * and the same reason the drop is counted rather than silent: "nothing
   * references this table" and "I am not allowed to tell you what does" are
   * different answers, and only one of them is true here.
   */
  referencedBy: Array<{
    name: string
    definition: string
    from: PgRelationRef
    /** The columns *of this table* that `from.columns` point at. */
    columns: string[]
  }>
  referencedByOutOfScope?: number
  uniqueConstraints: Array<{ name: string, definition: string }>
  /**
   * CHECK constraints, which are frequently the only statement of a column's
   * value domain — `CHECK (status IN ('open','closed','void'))` on a plain
   * `text` column is the same fact an enum type would carry, and was invisible
   * here until it was asked for.
   */
  checkConstraints: Array<{ name: string, definition: string }>
  indexes: Array<{ name: string, definition: string }>
}

/**
 * Ceiling on a returned view definition. A view body is arbitrary SQL a user
 * wrote and has no natural bound, and `describe-table` is called before most
 * queries, so an unclipped one would be paid for on every call.
 */
export const MAX_VIEW_DEFINITION = 8000

/**
 * Describe one table, or answer `undefined` when it is not reachable.
 *
 * The allowlist is applied in the anchor CTE, so an out-of-scope table produces
 * no rows at all rather than a description we then discard. The caller turns
 * that into one message covering both "does not exist" and "out of scope": two
 * distinguishable answers would make this an oracle for table names the token
 * was not granted.
 */
export async function describePgTable(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  schema: string,
  name: string,
): Promise<PgTableDescription | undefined> {
  return await withPg(instance, sql => describeTableWith(sql, scope, schema, name))
}

async function describeTableWith(
  sql: Sql,
  scope: McpScope,
  schema: string,
  name: string,
): Promise<PgTableDescription | undefined> {
  const qname = qualifiedName(schema, name)

  const [target] = await sql<Array<{
    oid: number
    kind: string
    comment: string | null
    estimated_rows: string | null
    view_definition: string | null
  }>>`
    SELECT c.oid,
           c.relkind AS kind,
           pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
           CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
           -- Only for a view or matview. pg_get_viewdef errors on anything
           -- else, so the relkind test is the guard and not a filter.
           CASE WHEN c.relkind = ANY ('{v,m}')
                THEN pg_catalog.pg_get_viewdef(c.oid, true) END AS view_definition
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema}
      AND c.relname = ${name}
      AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
      AND (${scope.allTables} OR ${qname} = ANY (${scope.tableNames}::text[]))`

  if (!target) return undefined

  // The four below depend only on `target.oid` and on nothing else, so they go
  // out together rather than in series. `describe-table` is a tool the
  // instructions tell the model to call before querying anything it has not
  // seen, so sequential round trips to a managed database were the dominant
  // cost of using it — which is also why reading both directions of the
  // foreign keys costs nothing beyond the one query it adds.
  const [columns, constraints, foreignKeyEdges, indexes] = await Promise.all([
    sql<Array<{
    name: string
    type: string
    nullable: boolean
    default: string | null
    identity: boolean
    comment: string | null
    enum_values: string[] | null
  }>>`
    SELECT a.attname AS name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default,
           a.attidentity <> '' AS identity,
           pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
           labels.values AS enum_values
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    -- Three hops, because a column's enum can be wrapped: the type itself, the
    -- element type of an array of it, or the base type of a domain over it. A
    -- column typed order_status[] is as much an enumerated column as a bare
    -- one, and reading only atttypid would report neither.
    LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_type el ON el.oid = NULLIF(t.typelem, 0)
    LEFT JOIN pg_catalog.pg_type bt ON bt.oid = NULLIF(t.typbasetype, 0)
    LEFT JOIN LATERAL (
      SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
      FROM pg_catalog.pg_enum e
      WHERE e.enumtypid = COALESCE(
        CASE WHEN t.typtype = 'e' THEN t.oid END,
        CASE WHEN el.typtype = 'e' THEN el.oid END,
        CASE WHEN bt.typtype = 'e' THEN bt.oid END)
    ) labels ON true
    WHERE a.attrelid = ${target.oid}
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum`,

    // Foreign keys are not read here — they need both endpoints resolved, and
    // both directions, which is the query below.
    sql<Array<{ name: string, type: string, definition: string }>>`
    SELECT con.conname AS name,
           con.contype::text AS type,
           pg_catalog.pg_get_constraintdef(con.oid) AS definition
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = ${target.oid}
      AND con.contype = ANY ('{p,u,c}')
    ORDER BY con.contype, con.conname`,

    /*
     * Both directions of every foreign key touching this table, in one pass.
     *
     * `conrelid = oid` is a key this table declares; `confrelid = oid` is one
     * pointing at it, which nothing here used to read at all — so describing
     * `customers` said nothing about `orders.customer_id`, and a model asked
     * to join had to describe every table to find the edge, or guess it.
     *
     * A self-referencing key satisfies both predicates and is reported once,
     * as outbound, with itself as the other end — which is what it is.
     *
     * `reachable` is computed against the same predicate as the anchor CTE, so
     * one rule decides what this token can address. `has_table_privilege` is
     * part of it because a granted allowlist entry the role cannot SELECT is
     * still not reachable.
     */
    sql<Array<{
    name: string
    outbound: boolean
    definition: string
    other_schema: string
    other_name: string
    reachable: boolean
    referencing_columns: string[] | null
    referenced_columns: string[] | null
  }>>`
    SELECT con.conname AS name,
           (con.conrelid = ${target.oid}) AS outbound,
           pg_catalog.pg_get_constraintdef(con.oid) AS definition,
           n.nspname AS other_schema,
           other.relname AS other_name,
           (${scope.allTables}
            OR (n.nspname || '.' || other.relname) = ANY (${scope.tableNames}::text[]))
             AND pg_catalog.has_table_privilege(other.oid, 'SELECT') AS reachable,
           (SELECT array_agg(att.attname ORDER BY k.ord)
              FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_catalog.pg_attribute att
                ON att.attrelid = con.conrelid AND att.attnum = k.attnum) AS referencing_columns,
           (SELECT array_agg(att.attname ORDER BY k.ord)
              FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_catalog.pg_attribute att
                ON att.attrelid = con.confrelid AND att.attnum = k.attnum) AS referenced_columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class other
      ON other.oid = CASE WHEN con.conrelid = ${target.oid} THEN con.confrelid ELSE con.conrelid END
    JOIN pg_catalog.pg_namespace n ON n.oid = other.relnamespace
    WHERE con.contype = 'f'
      AND (con.conrelid = ${target.oid} OR con.confrelid = ${target.oid})
    ORDER BY n.nspname, other.relname, con.conname`,

    sql<Array<{ name: string, definition: string }>>`
    SELECT c.relname AS name, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = ${target.oid}
    ORDER BY c.relname`,
  ])

  const primary = constraints.find(c => c.type === 'p')

  const inbound = foreignKeyEdges.filter(edge => !edge.outbound)
  const reachableInbound = inbound.filter(edge => edge.reachable)

  const viewDefinition = target.view_definition ?? undefined
  const viewTruncated = viewDefinition !== undefined && viewDefinition.length > MAX_VIEW_DEFINITION

  return {
    schema,
    name,
    qname,
    kind: relkindLabel(target.kind),
    ...(target.comment ? { comment: target.comment } : {}),
    estimatedRows: target.estimated_rows === null ? null : Number(target.estimated_rows),
    ...(viewDefinition !== undefined && {
      viewDefinition: viewTruncated ? viewDefinition.slice(0, MAX_VIEW_DEFINITION) : viewDefinition,
    }),
    ...(viewTruncated && { viewDefinitionTruncated: true }),
    columns: columns.map(column => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      ...(column.default ? { default: column.default } : {}),
      identity: column.identity,
      ...(column.comment ? { comment: column.comment } : {}),
      ...(column.enum_values?.length ? { enumValues: column.enum_values } : {}),
    })),
    primaryKey: primary ? parseKeyColumns(primary.definition) : [],
    foreignKeys: foreignKeyEdges.filter(edge => edge.outbound).map(edge => ({
      name: edge.name,
      definition: edge.definition,
      columns: edge.referencing_columns ?? [],
      references: relationRef(edge.other_schema, edge.other_name, edge.referenced_columns),
      reachable: edge.reachable,
    })),
    referencedBy: reachableInbound.map(edge => ({
      name: edge.name,
      definition: edge.definition,
      from: relationRef(edge.other_schema, edge.other_name, edge.referencing_columns),
      columns: edge.referenced_columns ?? [],
    })),
    ...(inbound.length > reachableInbound.length && {
      referencedByOutOfScope: inbound.length - reachableInbound.length,
    }),
    uniqueConstraints: constraints.filter(c => c.type === 'u').map(({ name, definition }) => ({ name, definition })),
    checkConstraints: constraints.filter(c => c.type === 'c').map(({ name, definition }) => ({ name, definition })),
    indexes: indexes.map(({ name, definition }) => ({ name, definition })),
  }
}

function relationRef(schema: string, name: string, columns: string[] | null): PgRelationRef {
  return { schema, name, qname: qualifiedName(schema, name), columns: columns ?? [] }
}

function relkindLabel(relkind: string): string {
  switch (relkind) {
    case 'r': return 'table'
    case 'p': return 'partitioned table'
    case 'v': return 'view'
    case 'm': return 'materialized view'
    case 'f': return 'foreign table'
    default: return relkind
  }
}

/** `PRIMARY KEY (a, b)` -> `['a', 'b']`. The definition is kept alongside anyway. */
function parseKeyColumns(definition: string): string[] {
  const inner = /\(([^)]*)\)/.exec(definition)?.[1]
  if (!inner) return []
  return inner.split(',').map(part => part.trim().replace(/^"|"$/g, '')).filter(Boolean)
}
