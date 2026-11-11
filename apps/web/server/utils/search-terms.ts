import type { PendingQuery, Row, Sql } from 'postgres'
import { escapeLike } from './sql-text'

/**
 * The words of a message search, split and bounded.
 *
 * Every term becomes one `ILIKE` pattern, through `textMatchesAll` below: its own
 * clause when it has a trigram, so the trigram index can serve it (#202 for
 * WhatsApp, #210 for Telegram). Wherever no index serves a term, it is
 * matched against every body in the account, so the cost of a search grows with
 * the number and length of its terms. Those queries run on the message pools
 * this deployment's tenants share. Uncapped, a
 * query of thousands of one-letter words ran every search to the statement
 * timeout and held the shared slots other accounts' reads and the status reads
 * wait on (GHSA-fpmx-gmx5-84vc).
 *
 * The limits are generous for anything a person or a model types to find a
 * message; a search that needs more words is better narrowed by chat or date.
 */
export const MAX_SEARCH_QUERY_LENGTH = 500
export const MAX_SEARCH_TERMS = 10
export const MAX_SEARCH_TERM_LENGTH = 100

const LIMIT_TEXT = `at most ${MAX_SEARCH_TERMS} words of at most ${MAX_SEARCH_TERM_LENGTH} characters each `
  + `(${MAX_SEARCH_QUERY_LENGTH} characters in all)`

/**
 * Split a search box the way every search splits it — on whitespace, every word
 * required — and refuse one over the limits with a 400 that names them, so a
 * model can shorten its query rather than retry it.
 */
export function splitSearchTerms(query: string, field: string): string[] {
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw createError({ statusCode: 400, message: `\`${field}\` may hold ${LIMIT_TEXT}.` })
  }
  const terms = query.split(/\s+/).filter(Boolean)
  assertSearchTerms(terms, field)
  return terms
}

/**
 * The same limits, for terms already split.
 *
 * Called again by every query that builds `ILIKE` patterns from terms, so a future
 * caller that splits for itself cannot bring the unbounded search back.
 */
export function assertSearchTerms(terms: readonly string[], field = 'query'): void {
  if (terms.length > MAX_SEARCH_TERMS || terms.some(term => term.length > MAX_SEARCH_TERM_LENGTH)) {
    throw createError({ statusCode: 400, message: `\`${field}\` may hold ${LIMIT_TEXT}.` })
  }
}

/**
 * `AND` clauses requiring every term in `expr` — an empty fragment for no terms.
 * Terms already split, not yet escaped; bounded again here. The one builder for
 * both message stores: WhatsApp's `messageBody()` (`message_body_trgm`) and
 * Telegram's `m.text` (`messages_text_trgm`, the bridge's own migration).
 *
 * **One `ILIKE` per term, never `ILIKE ALL (array)`.** Postgres matches an array
 * comparison to a GIN index only as `ANY`; `ALL` is always a filter, so the
 * trigram index would sit unused and every search would read every row of the
 * account (#202; on Telegram the index had 0 scans in production, #210).
 * Separate clauses on the same expression let one bitmap scan of the trigram
 * index intersect them. `expr` must be exactly the indexed expression, inlined in
 * the `WHERE` — an expression index is used only when the query's is identical.
 *
 * **Except a term with no trigram.** `pg_trgm` takes trigrams from runs of
 * letters and digits, so `ok`, `👍` or `?!` yield none, and an index clause
 * for one is a scan of the *whole* index — every account's messages — which
 * the planner still picked for a two-letter search on a small account,
 * costing more than the account scan it replaced. Those terms go in one
 * `ILIKE ALL`, which no index can serve, so they filter the rows the other
 * terms or the account predicate found. `TRIGRAM_RUN` is the test: three
 * letters or digits in a row always give at least one trigram. It decides only
 * whether the index may be asked; the rows matched are the same either way.
 */
export function textMatchesAll(
  sql: Sql,
  expr: PendingQuery<Row[]>,
  terms: readonly string[],
): PendingQuery<Row[]> {
  assertSearchTerms(terms)
  const like = (term: string) => `%${escapeLike(term)}%`
  const indexed = terms.filter(term => TRIGRAM_RUN.test(term))
  const filtered = terms.filter(term => !TRIGRAM_RUN.test(term))

  const clauses = indexed.map(term => sql`AND ${expr} ILIKE ${like(term)}`)
  if (filtered.length) clauses.push(sql`AND ${expr} ILIKE ALL (${filtered.map(like)}::text[])`)
  return clauses.reduce((all, clause) => sql`${all} ${clause}`, sql``)
}

/** Three letters or digits in a row: a term `pg_trgm` takes at least one trigram from. */
export const TRIGRAM_RUN = /[\p{L}\p{N}]{3}/u
