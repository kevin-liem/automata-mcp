import type { H3Event } from 'h3'

/**
 * A cap on failed sign-ins, per email and per client address.
 *
 * scrypt makes each guess slow, not scarce; without this the login form lets
 * anyone try passwords against an admin account for as long as they like. Only
 * failures count. A blocked attempt is refused before the account read and the
 * hash comparison, so it costs nothing.
 *
 * An attempt is counted when it is claimed (`claimPasswordAttempt`), in the same
 * synchronous step as the check, and handed back (`releasePasswordAttempt`) once
 * it turns out not to be a wrong password — a success, or an outage, which is
 * not counted. Checking first and recording after `checkPassword` let a burst
 * arriving together all pass the check before any of them was recorded: the
 * cap held for serial guesses only. Same shape as `claimAuthAttempt` in mfa.ts.
 *
 * Both keys, because each alone leaves a hole: per-address only leaves guessing
 * spread over many addresses unbounded; per-email only lets one address spray
 * every account. The per-email key has a known price — a stranger who knows an
 * address can keep it locked out with ten bad guesses every fifteen minutes.
 * Accepted: that is a nuisance, an unbounded guess rate is a breach.
 *
 * Success clears the email key, never the address key — otherwise an attacker
 * resets their own counter by signing into their own account between guesses.
 *
 * In-memory and per-process, like the invitation mail throttle. A speed bump,
 * not a lockout policy: a restart empties it and N replicas allow N times as
 * many guesses.
 */
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_FAILURE_LIMIT = 10
const MAX_TRACKED_KEYS = 10_000

const failures = new Map<string, number[]>()

function prune(now: number): void {
  for (const [key, times] of failures) {
    const recent = times.filter(at => now - at < LOGIN_WINDOW_MS)
    if (recent.length) failures.set(key, recent)
    else failures.delete(key)
  }
  // Insertion order is oldest first; a spray of made-up emails must not grow
  // this without bound.
  for (const key of failures.keys()) {
    if (failures.size <= MAX_TRACKED_KEYS) break
    failures.delete(key)
  }
}

/**
 * The client's address. The rightmost `X-Forwarded-For` entry is the one the
 * nearest proxy appended; the leftmost — what h3's `xForwardedFor: true` reads —
 * is whatever the client chose to send, and would make the per-address key free
 * to rotate.
 */
export function clientIp(event: H3Event): string {
  const forwarded = getRequestHeader(event, 'x-forwarded-for')
  const last = forwarded?.split(',').map(part => part.trim()).filter(Boolean).pop()
  return last ?? getRequestIP(event) ?? 'unknown'
}

/** The 429 every throttle here answers, with `Retry-After` for the time left. */
function throwThrottled(event: H3Event, retryInMs: number, message: string): never {
  setResponseHeader(event, 'Retry-After', Math.max(1, Math.ceil(retryInMs / 1000)))
  throw createError({ statusCode: 429, statusMessage: message })
}

function keysFor(event: H3Event, email: string): string[] {
  return [`email:${normaliseEmail(email)}`, `ip:${clientIp(event)}`]
}

/**
 * Checks both keys and, when neither is at the cap, counts this attempt against
 * both — with no `await` between the two, so concurrent attempts see each
 * other. Throws 429 otherwise. Returns the claim's timestamp, which the caller
 * passes to `releasePasswordAttempt` unless the password turned out wrong.
 */
export function claimPasswordAttempt(event: H3Event, email: string): number {
  const now = Date.now()
  prune(now)

  const keys = keysFor(event, email)
  let retryAt = 0
  for (const key of keys) {
    const times = failures.get(key) ?? []
    if (times.length >= LOGIN_FAILURE_LIMIT) {
      retryAt = Math.max(retryAt, times[times.length - LOGIN_FAILURE_LIMIT]! + LOGIN_WINDOW_MS)
    }
  }
  if (retryAt) {
    // One message for both keys: which limit hit would say whether the address
    // has an account behind it.
    throwThrottled(event, retryAt - now, 'Too many failed sign-in attempts. Try again in a few minutes.')
  }

  for (const key of keys) failures.set(key, [...(failures.get(key) ?? []), now])
  return now
}

/**
 * Hands back the attempt claimed at `at`: it was not a wrong password. Removes
 * one entry with that timestamp from each key — entries with equal timestamps
 * are interchangeable, so which one goes does not matter. A claim already
 * pruned or evicted is simply absent.
 */
export function releasePasswordAttempt(event: H3Event, email: string, at: number): void {
  for (const key of keysFor(event, email)) dropAttempt(failures, key, at)
}

/**
 * Remove one attempt timestamped `at` from `key` in a throttle's map — the
 * hand-back every claim-before-check throttle shares. Entries with equal
 * timestamps are interchangeable; one already pruned is simply absent.
 */
export function dropAttempt(attempts: Map<string, number[]>, key: string, at: number): void {
  const times = attempts.get(key)
  const index = times?.indexOf(at) ?? -1
  if (index < 0) return
  times!.splice(index, 1)
  if (!times!.length) attempts.delete(key)
}

export function clearLoginFailures(email: string): void {
  failures.delete(`email:${normaliseEmail(email)}`)
}

/**
 * The same cap on wrong signup codes, per client address only — there is no
 * account to key on yet. Shares the map and window with sign-in failures, under
 * its own prefix, so the two never count against each other.
 */
export function assertSignupCodeAllowed(event: H3Event): void {
  const now = Date.now()
  prune(now)

  const times = failures.get(`signup-ip:${clientIp(event)}`) ?? []
  if (times.length < LOGIN_FAILURE_LIMIT) return

  const retryAt = times[times.length - LOGIN_FAILURE_LIMIT]! + LOGIN_WINDOW_MS
  throwThrottled(event, retryAt - now, 'Too many wrong signup codes. Try again in a few minutes.')
}

export function recordSignupCodeFailure(event: H3Event): void {
  const key = `signup-ip:${clientIp(event)}`
  failures.set(key, [...(failures.get(key) ?? []), Date.now()])
}

/**
 * The same cap on wrong email-verification codes, per address being verified
 * and across every pending row for it. Each row allows five guesses, but a new
 * signup for the same address is a new row with five more, and the per-client
 * mail throttle is all that limits minting rows — so neither bound holds alone.
 * Keyed on the address only, for that reason.
 *
 * The price is the per-email login key's: a stranger can keep code entry for an
 * address locked. Only the code — the link in the mail is not throttled here, so
 * the owner still verifies with it. A refused attempt touches no row.
 */
function verifyCodeKey(email: string): string {
  return `verify-email:${normaliseEmail(email)}`
}

export function assertVerifyCodeAllowed(event: H3Event, email: string): void {
  const now = Date.now()
  prune(now)

  const times = failures.get(verifyCodeKey(email)) ?? []
  if (times.length < LOGIN_FAILURE_LIMIT) return

  const retryAt = times[times.length - LOGIN_FAILURE_LIMIT]! + LOGIN_WINDOW_MS
  throwThrottled(event, retryAt - now, 'Too many wrong codes for this address. Use the link in the email, or try again in a few minutes.')
}

export function recordVerifyCodeFailure(email: string): void {
  const key = verifyCodeKey(email)
  failures.set(key, [...(failures.get(key) ?? []), Date.now()])
}

/**
 * Wrong password-reset codes, capped per address and per client, across every
 * reset row. A right code is an account, so this is tighter than the signup
 * code: ten per fifteen minutes on each key, as everywhere here, and also
 * thirty per day per address. Each row allows five guesses, but asking again
 * mints a new row with five more, and only the mail throttle limits that — so
 * the per-row cap alone bounds nothing. At thirty guesses a day a six-digit code
 * holds for decades rather than months.
 *
 * Keyed on the address whether or not it has an account, and counted for codes
 * that matched no row, so the answer never says which addresses are real. The
 * price is the per-email login key's: a stranger can keep code entry for an
 * address locked. Only the code — the mailed link is not throttled here, so the
 * owner still resets with it. Checked before any row is touched.
 */
const RESET_DAY_MS = 24 * 60 * 60_000
const RESET_DAILY_LIMIT = 30
const resetDaily = new Map<string, number[]>()

function resetCodeKeys(event: H3Event, email: string): string[] {
  return [`reset-code:${normaliseEmail(email)}`, `reset-code-ip:${clientIp(event)}`]
}

export function assertResetCodeAllowed(event: H3Event, email: string): void {
  const now = Date.now()
  prune(now)
  for (const [key, times] of resetDaily) {
    const recent = times.filter(at => now - at < RESET_DAY_MS)
    if (recent.length) resetDaily.set(key, recent)
    else resetDaily.delete(key)
  }
  for (const key of resetDaily.keys()) {
    if (resetDaily.size <= MAX_TRACKED_KEYS) break
    resetDaily.delete(key)
  }

  let retryAt = 0
  for (const key of resetCodeKeys(event, email)) {
    const times = failures.get(key) ?? []
    if (times.length >= LOGIN_FAILURE_LIMIT) {
      retryAt = Math.max(retryAt, times[times.length - LOGIN_FAILURE_LIMIT]! + LOGIN_WINDOW_MS)
    }
  }
  const daily = resetDaily.get(normaliseEmail(email)) ?? []
  if (daily.length >= RESET_DAILY_LIMIT) {
    retryAt = Math.max(retryAt, daily[daily.length - RESET_DAILY_LIMIT]! + RESET_DAY_MS)
  }
  if (retryAt) {
    throwThrottled(event, retryAt - now, 'Too many wrong codes. Use the link in the email, or try again later.')
  }
}

export function recordResetCodeFailure(event: H3Event, email: string): void {
  const now = Date.now()
  for (const key of resetCodeKeys(event, email)) failures.set(key, [...(failures.get(key) ?? []), now])
  const address = normaliseEmail(email)
  resetDaily.set(address, [...(resetDaily.get(address) ?? []), now])
}
