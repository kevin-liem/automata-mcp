/**
 * The words of a message search, split and bounded.
 *
 * Every term becomes one `ILIKE` pattern in an `ILIKE ALL (...)` predicate run
 * against every body in the account (`evolution-db.ts`, `telegram-db.ts`), so the
 * cost of a search grows with the number and length of its terms — and those
 * queries run on the message pools this deployment's tenants share. Uncapped, a
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
 * Called again by every query that builds an `ILIKE ALL` from terms, so a future
 * caller that splits for itself cannot bring the unbounded search back.
 */
export function assertSearchTerms(terms: readonly string[], field = 'query'): void {
  if (terms.length > MAX_SEARCH_TERMS || terms.some(term => term.length > MAX_SEARCH_TERM_LENGTH)) {
    throw createError({ statusCode: 400, message: `\`${field}\` may hold ${LIMIT_TEXT}.` })
  }
}
