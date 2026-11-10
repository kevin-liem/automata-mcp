import type { AppMcpToolCall } from './app-db'
import type { McpAuth } from './mcp-auth'

/**
 * Which tools each connector token called, and why — the one module that reads
 * or writes `app.mcp_tool_calls`.
 *
 * **Recorded only while the organization records.** `record_tool_calls` is the
 * organization's own switch, off by default on every plan. It rides on
 * `resolveMcpAuth`'s existing organization join, so an
 * organization that records nothing pays nothing here.
 *
 * **`reason` is the model's own one-line account of why it called the tool** —
 * the closest thing to the user's prompt MCP lets a server see, and still not
 * the prompt. Every tool accepts it (`defineKindTool` injects it and removes it
 * before the tool's handler runs). It is model-written free text that prompt
 * injection can steer, and it can quote what the user asked about, so:
 *
 * - it is stored here and nowhere else: never in `app.hosted_events`, the usage
 *   rollup, the process log or any analytics;
 * - it is never returned over MCP, so one model's self-report never becomes the
 *   next one's instructions;
 * - it is rendered as text, never HTML, and never used to authorize, bill or
 *   rate-limit anything;
 * - rows are deleted after `RETENTION` by the `mcp:prune-tool-calls` task.
 *
 * **Best-effort.** Same rule as `last_used_at` and the client capture: a failed
 * write never fails, delays or changes the tool call it describes.
 */

/** Stored length of a reason, in code points. Matches the column's CHECK. */
export const MAX_REASON = 300

/**
 * What a client may send. Far above `MAX_REASON` on purpose: an over-long
 * reason is clipped, not refused, since refusing would fail the real call over
 * a field that only exists for bookkeeping. The bound only caps request size.
 */
export const MAX_REASON_INPUT = 2000

/** How long a call stays recorded. */
export const RETENTION = '30 days'

/** Rows per page in the activity dialog. */
const PAGE_SIZE = 50

/** What the activity dialog shows, per call. */
export interface PublicToolCall {
  id: string
  tool: string
  ok: boolean
  /** Model-written, self-reported. Absent when the model gave none. */
  reason?: string
  userAgent?: string
  at: string
}

/**
 * A reason as stored: whitespace runs (newlines included) collapsed to one
 * space, control characters removed, clipped by code point. Empty → undefined.
 */
export function cleanReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return clipClientText(value.replace(/\s+/g, ' '), MAX_REASON) || undefined
}

/**
 * Record one call if the caller's organization records them. Synchronous and
 * never throws: the write is not awaited, and a failure is logged by token id
 * only — never the reason, never the arguments, never the URL.
 */
export function recordToolCall(
  auth: McpAuth,
  call: { tool: string, ok: boolean, reason?: string, userAgent?: string },
): void {
  if (!auth.recordToolCalls) return

  const reason = cleanReason(call.reason)
  const userAgent = clipUserAgent(call.userAgent)
  const { tokenId } = auth
  const instanceId = auth.instance.id

  void appDb()
    .then(sql => sql`
      INSERT INTO app.mcp_tool_calls (token_id, instance, tool, ok, reason, user_agent)
      VALUES (${tokenId}, ${instanceId}, ${call.tool}, ${call.ok}, ${reason ?? null}, ${userAgent ?? null})
    `)
    .catch((error) => {
      console.error(`[tool-calls] could not record a ${call.tool} call for token ${tokenId}:`, (error as Error)?.message ?? error)
    })
}

/**
 * One page of a token's calls, newest first. The caller has already decided the
 * actor may see this token (`resolveTokenForActor`), which is the whole
 * visibility rule: a member reaches only their own tokens, an admin every token
 * in the organization.
 *
 * `hasMore` from fetching one row beyond the page, never from a count.
 */
export async function listToolCalls(
  tokenId: string,
  page: number,
): Promise<{ calls: PublicToolCall[], hasMore: boolean }> {
  const sql = await appDb()
  const rows = await sql<AppMcpToolCall[]>`
    SELECT id, tool, ok, reason, user_agent, at
    FROM app.mcp_tool_calls
    WHERE token_id = ${tokenId}
    ORDER BY at DESC, id DESC
    LIMIT ${PAGE_SIZE + 1} OFFSET ${(page - 1) * PAGE_SIZE}
  `
  return {
    calls: rows.slice(0, PAGE_SIZE).map(row => ({
      id: row.id,
      tool: row.tool,
      ok: row.ok,
      reason: row.reason,
      userAgent: row.user_agent,
      at: row.at,
    })),
    hasMore: rows.length > PAGE_SIZE,
  }
}

/** Whether an organization records tool calls. */
export interface ToolCallSetting {
  /** Calls are being recorded now. */
  recording: boolean
  /** Kept for clients of the organization and token activity endpoints. */
  required: boolean
}

export async function loadToolCallSetting(orgId: string): Promise<ToolCallSetting> {
  const sql = await appDb()
  const [row] = await sql<{ record_tool_calls: boolean }[]>`
    SELECT record_tool_calls FROM app.organizations WHERE id = ${orgId}
  `
  return { recording: row?.record_tool_calls ?? false, required: false }
}

/** Update the organization's recording preference. */
export async function setToolCallRecording(orgId: string, on: boolean): Promise<ToolCallSetting> {
  const sql = await appDb()
  const [row] = await sql<{ record_tool_calls: boolean }[]>`
    UPDATE app.organizations SET record_tool_calls = ${on}
    WHERE id = ${orgId}
    RETURNING record_tool_calls
  `
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Organization not found' })
  }
  return { recording: row.record_tool_calls, required: false }
}

/** Delete calls older than `RETENTION`. Idempotent, so safe on every replica. */
export async function pruneToolCalls(): Promise<number> {
  const sql = await appDb()
  const result = await sql`
    DELETE FROM app.mcp_tool_calls WHERE at < now() - ${RETENTION}::interval
  `
  return result.count
}
