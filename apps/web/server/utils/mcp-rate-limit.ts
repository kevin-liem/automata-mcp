import type Redis from 'ioredis'
import type { McpAuth } from './mcp-auth'
import { decideBuckets, type BucketCharge, type BucketState } from './token-bucket'
import { REDIS_KEY_PREFIX, logRedisError, readyRedis } from './redis'
import { rememberBounded } from './lookup-cache'
import { isExpensiveCall } from './mcp-kind-tool'

/**
 * Per-minute budgets on `/mcp`, so one runaway agent loop cannot hammer
 * Evolution's database, a user's Postgres or an IMAP server and slow every
 * other organization on the shared backends (#170).
 *
 * Three token buckets, each "N per minute, up to N at once" (token-bucket.ts):
 *
 * | scope | key | charged | env (default) |
 * |---|---|---|---|
 * | `token` | `tok:<token id>` | every POST, cost = max(1, tools/call in body) | `NUXT_MCP_RATE_TOKEN_PER_MINUTE` (120) |
 * | `organization` | `org:<org id>` | same | `NUXT_MCP_RATE_ORG_PER_MINUTE` (600) |
 * | `connection` | `exp:<instance id>` | each call to a tool marked `expensive` | `NUXT_MCP_RATE_EXPENSIVE_PER_MINUTE` (30) |
 *
 * `0` turns that bucket off. The expensive budget is per connection rather
 * than per token, since what it protects is that connection's backend — one
 * Evolution account, one DSN, one mailbox — however many tokens reach it.
 *
 * Rules easy to undo:
 *
 * - **All or nothing.** A request either fits every bucket or takes from none,
 *   so a token over its own budget never drains its organization's.
 * - **429 with `Retry-After`, never 401.** A 401 tells an MCP client to throw
 *   the token away; this one works again in seconds.
 * - **State in Redis when `NUXT_REDIS_URL` is set (hosted), else in-process.**
 *   A Redis failure falls back to in-process for that request and is logged at
 *   most once a minute — never a 503: losing the limiter's shared state must
 *   not take every connector down with it. In-process means N replicas allow N
 *   times the budget; docs/self-hosting.md says so.
 * - **Checked after auth, the limit refusal and the body read, before the
 *   client capture** (server/mcp/index.ts), so a throttled request writes
 *   nothing and a caller without a token never reaches a bucket.
 * - Buckets are counts and nothing else: no tool arguments, no reason, no
 *   client text reaches Redis or the log — ids only.
 */

type RateScope = 'token' | 'organization' | 'connection'

interface Limits { token: number, organization: number, connection: number }

const DEFAULTS: Limits = { token: 120, organization: 600, connection: 30 }

/** In-process buckets: bounded, oldest touched evicted first. */
const MAX_LOCAL_BUCKETS = 50_000
const local = new Map<string, BucketState>()

/** Refusal log lines: one per bucket per minute. Handled 429s are invisible to Nitro. */
const LOG_EVERY_MS = 60_000
const MAX_LOGGED_KEYS = 10_000
const lastLogged = new Map<string, number>()

let limits: Limits | undefined

function perMinute(value: unknown, fallback: number): number {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.floor(parsed))
}

/** The configured budgets, read once. */
function mcpRateLimits(): Limits {
  if (!limits) {
    const config = useRuntimeConfig()
    limits = {
      token: perMinute(config.mcpRateTokenPerMinute, DEFAULTS.token),
      organization: perMinute(config.mcpRateOrgPerMinute, DEFAULTS.organization),
      connection: perMinute(config.mcpRateExpensivePerMinute, DEFAULTS.connection),
    }
  }
  return limits
}

/** One `tools/call` in a request body. */
interface ToolCallInBody {
  name: string
  args: Record<string, unknown>
}

/**
 * The tool calls a JSON-RPC body asks for — one object or a batch. Substring
 * test first so `initialize` and `tools/list` bodies are not parsed here.
 * Anything unreadable is `[]`; the toolkit answers it with its own error.
 */
export function toolCallsIn(raw: string | undefined): ToolCallInBody[] {
  if (!raw || !raw.includes('tools/call')) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return []
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  const calls: ToolCallInBody[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const { method, params } = message as { method?: unknown, params?: unknown }
    if (method !== 'tools/call' || !params || typeof params !== 'object') continue
    const { name, arguments: args } = params as { name?: unknown, arguments?: unknown }
    if (typeof name !== 'string') continue
    calls.push({
      name,
      args: args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {},
    })
  }
  return calls
}

interface ScopedCharge extends BucketCharge { scope: RateScope }

/** The buckets this request is charged against, leaving out any turned off. */
export function chargesFor(auth: Pick<McpAuth, 'tokenId' | 'instance'>, calls: readonly ToolCallInBody[]): ScopedCharge[] {
  const budget = mcpRateLimits()
  const cost = Math.max(1, calls.length)
  const expensive = calls.filter(call => isExpensiveCall(call.name, call.args)).length

  const charges: ScopedCharge[] = []
  if (budget.token) charges.push({ scope: 'token', key: `tok:${auth.tokenId}`, perMinute: budget.token, cost })
  if (budget.organization && auth.instance.org) {
    charges.push({ scope: 'organization', key: `org:${auth.instance.org}`, perMinute: budget.organization, cost })
  }
  if (budget.connection && expensive) {
    charges.push({ scope: 'connection', key: `exp:${auth.instance.id}`, perMinute: budget.connection, cost: expensive })
  }
  return charges
}

export interface BudgetRefusal {
  retryAfterMs: number
  scope: RateScope
  perMinute: number
}

/**
 * Take this request's cost from every bucket, or from none. `undefined` = go
 * ahead; otherwise how long until it would fit, and which budget is short.
 */
export async function takeMcpBudget(charges: readonly ScopedCharge[]): Promise<BudgetRefusal | undefined> {
  if (!charges.length) return undefined

  let result: { waitMs: number, limiting?: number } | undefined
  const redis = readyRedis()
  if (redis) {
    try {
      result = await takeFromRedis(redis, charges)
    }
    catch (error) {
      logRedisError('rate limit', error)
    }
  }
  result ??= takeLocally(charges, Date.now())

  if (!result.waitMs) return undefined
  const limiting = charges[result.limiting ?? 0]!
  logRefusal(limiting)
  return { retryAfterMs: result.waitMs, scope: limiting.scope, perMinute: limiting.perMinute }
}

/** Same arithmetic as the Lua, synchronous so concurrent requests see each other. */
function takeLocally(charges: readonly BucketCharge[], now: number): { waitMs: number, limiting?: number } {
  const decision = decideBuckets(charges.map(charge => local.get(charge.key)), charges, now)
  decision.next?.forEach((state, i) => rememberBounded(local, charges[i]!.key, state, MAX_LOCAL_BUCKETS))
  return decision
}

/**
 * token-bucket.ts's `decideBuckets`, restated for Redis so check and take are one
 * atomic step across replicas. The clock is Redis's own `TIME`, so replicas
 * whose clocks disagree still agree on the bucket. ARGV holds per-minute and
 * cost for each key in turn. Returns `{ waitMs, limiting (1-based, 0 = none) }`.
 * A refused request writes nothing. Each key expires after a minute untouched —
 * the time an empty bucket takes to fill, so an expired key reads as full and
 * is right.
 */
const RATE_LIMIT_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local avail = {}
local wait = 0
local limiting = 0
for i = 1, #KEYS do
  local cap = tonumber(ARGV[2 * i - 1])
  local cost = math.min(tonumber(ARGV[2 * i]), cap)
  local v = redis.call('HMGET', KEYS[i], 't', 'a')
  local tokens = cap
  if v[1] and v[2] then
    local elapsed = math.max(0, now - tonumber(v[2]))
    tokens = math.min(cap, tonumber(v[1]) + elapsed * cap / 60000)
  end
  avail[i] = tokens
  local short = cost - tokens
  if short > 0 then
    local w = math.ceil(short * 60000 / cap)
    if w > wait then
      wait = w
      limiting = i
    end
  end
end
if wait == 0 then
  for i = 1, #KEYS do
    local cap = tonumber(ARGV[2 * i - 1])
    local cost = math.min(tonumber(ARGV[2 * i]), cap)
    redis.call('HSET', KEYS[i], 't', tostring(avail[i] - cost), 'a', tostring(now))
    redis.call('PEXPIRE', KEYS[i], 60000)
  end
end
return { wait, limiting }
`

type RedisWithRateLimit = Redis & {
  automataRateLimit(numKeys: number, ...args: (string | number)[]): Promise<[number, number]>
}

async function takeFromRedis(redis: Redis, charges: readonly BucketCharge[]): Promise<{ waitMs: number, limiting?: number }> {
  const client = redis as RedisWithRateLimit
  if (typeof client.automataRateLimit !== 'function') {
    // EVALSHA, falling back to EVAL once per connection when the script cache is empty.
    redis.defineCommand('automataRateLimit', { lua: RATE_LIMIT_SCRIPT })
  }
  const keys = charges.map(charge => `${REDIS_KEY_PREFIX}rl:${charge.key}`)
  const args = charges.flatMap(charge => [charge.perMinute, charge.cost])
  const [waitMs, limiting] = await client.automataRateLimit(keys.length, ...keys, ...args)
  return { waitMs: Number(waitMs) || 0, limiting: limiting ? Number(limiting) - 1 : undefined }
}

function logRefusal(charge: ScopedCharge): void {
  const now = Date.now()
  if (now - (lastLogged.get(charge.key) ?? 0) < LOG_EVERY_MS) return
  rememberBounded(lastLogged, charge.key, now, MAX_LOGGED_KEYS)
  // Ids only: the key names a token, an organization or a connection.
  console.warn(`[mcp-rate-limit] ${charge.scope} budget of ${charge.perMinute}/min spent (${charge.key}); answering 429`)
}

const SCOPE_WORDING: Record<RateScope, string> = {
  token: 'This connector has used its request budget',
  organization: 'This organization\'s connectors have used their shared request budget',
  connection: 'Searches and queries on this connection have used their budget',
}

/**
 * 429 with `Retry-After`, JSON-RPC shaped like every other refusal on this
 * surface. Never 401: the token is fine and works again in seconds.
 */
export function mcpRateLimited(refusal: BudgetRefusal): Response {
  const retryAfter = Math.max(1, Math.ceil(refusal.retryAfterMs / 1000))
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32003,
        message: `${SCOPE_WORDING[refusal.scope]} (${refusal.perMinute} per minute). Retry in ${retryAfter} s.`,
        data: { retryAfter, scope: refusal.scope, perMinute: refusal.perMinute },
      },
    }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) } },
  )
}
