import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import { MAX_REASON_INPUT, recordToolCall } from './tool-calls'
import type { InstanceKind } from './mcp-scope'
import type { McpAuth } from './mcp-auth'

/**
 * The toolkit's tool definition, taken from `defineMcpTool` itself rather than
 * imported: the type lives at a deep path that is not in the package's
 * `exports` map, and naming that path here would be a second fragile dependency
 * on the toolkit's internal layout (see `modules/mcp-token-route.ts`).
 */
type ToolDefinition<I extends ZodRawShape | undefined, O extends ZodRawShape>
  = Parameters<typeof defineMcpTool<I, O>>[0]

/**
 * Which connection kinds each tool serves, by tool name.
 *
 * **This registry is the answer to a question the toolkit cannot answer for
 * us.** A tool's `group` used to double as "which kind this belongs to", which
 * worked only while the two were the same string. They are not any more: the
 * SQL tools sit in `tools/sql/` and serve every SQL kind, so `group` is `'sql'`
 * and names no kind at all.
 *
 * `api/instances/[id]/mcp-tools.get.ts` needs the mapping to render the scope
 * picker, and reading it off the toolkit's own definition meant an untyped cast
 * through `group ?? _meta.group` — which did not typecheck, and which would
 * have silently returned an empty catalogue the moment `group` stopped being a
 * kind. A picker that offers no tools mints a token that can call nothing.
 *
 * Populated as each tool module evaluates. Every tool module is imported by the
 * toolkit's generated `tools.mjs`, and the route imports that, so by the time
 * any request is served every `defineKindTool` call has run.
 */
const TOOL_KINDS = new Map<string, readonly InstanceKind[]>()

/** The kinds a tool serves, or `undefined` for a tool this build does not know. */
export function kindsForTool(name: string): readonly InstanceKind[] | undefined {
  return TOOL_KINDS.get(name)
}

/** Whether a tool exists for a connection of this kind. */
export function toolServesKind(name: string, kind: InstanceKind): boolean {
  return TOOL_KINDS.get(name)?.includes(kind) ?? false
}

/** Whether a call counts against the separate, lower budget for costly tools. */
export type ExpensiveMarker = true | ((args: Record<string, unknown>) => boolean)

/**
 * Tools that load a connection's backend far more than a page read — a scan
 * over every message, an arbitrary query, a server-side body search — keyed by
 * name like `TOOL_KINDS` and filled the same way. Read by the MCP rate limit
 * (mcp-rate-limit.ts) from the request body, before the tool runs, since a
 * refusal there is a 429 rather than a tool result.
 */
const TOOL_COST = new Map<string, ExpensiveMarker>()

/**
 * Whether this call to `name` with these arguments is an expensive one. A
 * marker that throws counts as expensive; an unknown tool does not, since the
 * toolkit refuses it before anything runs.
 */
export function isExpensiveCall(name: string, args: Record<string, unknown>): boolean {
  const marker = TOOL_COST.get(name)
  if (!marker) return false
  if (marker === true) return true
  try {
    return marker(args)
  }
  catch {
    return true
  }
}

/**
 * The optional `reason` argument every tool takes: the model's one-sentence
 * account of why it is calling the tool. MCP never sends the user's prompt, so
 * this is the closest a connection owner can get to "what was this for".
 *
 * **Injected here, once, rather than declared per tool**, so the description
 * cannot drift and no tool can forget it. It is removed from the arguments
 * before the tool's own handler runs (`countedHandler`), so no tool sees it or
 * can come to depend on it.
 *
 * **Optional, and clipped rather than refused.** A client that omits it, or a
 * model that writes too much, must never turn a real call into a validation
 * error; `MAX_REASON_INPUT` only caps request size, and storage clips to
 * `MAX_REASON`. See tool-calls.ts for what happens to it, and why it is never
 * logged, exported or returned.
 */
const REASON_FIELD = z.string().max(MAX_REASON_INPUT).optional().describe(
  'One sentence: why you are calling this tool, i.e. what the user asked for. '
  + 'Do not include names, contact details, message text or other personal data.',
)

/**
 * Define an MCP tool that belongs to one or more kinds of connection.
 *
 * **Why this exists rather than three separate declarations.** A tool's kind was
 * being asserted three times per file — by the directory it sits in, by an
 * explicit `group`, and by the third argument to `isToolAllowed` — kept in step
 * by a comment. Only the third one enforces anything, and forgetting it is not a
 * cosmetic slip: a Postgres token minted with `all_tools` would register
 * `send-text-message`, whose handler calls `useEvolutionClient()` on a row that
 * has no Evolution credentials. Declaring the kind once makes the mismatch
 * unrepresentable.
 *
 * **`kinds` (plural) is for a tool whose meaning is genuinely identical across
 * engines**, which today means the SQL tools: `run-query` takes the same
 * argument and promises the same thing whether the connection is Postgres or
 * another SQL engine, and the differences live behind `sql-engine.ts` and in the
 * per-kind `instructions`. It is *not* the way to share a tool whose arguments
 * differ — that is why Telegram has `read-telegram-messages` rather than a
 * two-kind `read-messages`, and that reasoning still stands.
 *
 * Basenames must stay unique across groups regardless: the loader warns on a
 * collision and `McpServer.registerTool` throws on a duplicate registered name.
 * A single shared file satisfies that rule rather than straining it.
 *
 * `available` is the second half of the old `enabled` expression, kept for the
 * one tool that has a prerequisite beyond its kind. It takes no event because a
 * prerequisite is a property of the deployment, not of the caller.
 */
export function defineKindTool<
  const InputSchema extends ZodRawShape | undefined = ZodRawShape,
  const OutputSchema extends ZodRawShape = ZodRawShape,
>(
  definition: ToolDefinition<InputSchema, OutputSchema> & {
    name: string
    /** One kind, or several for a tool that means the same thing on each. */
    kind: InstanceKind | readonly [InstanceKind, ...InstanceKind[]]
    /**
     * The directory this tool sits in, when that is not simply its kind.
     * Required for a multi-kind tool, since there is no single kind to infer it
     * from; stated so a move cannot silently change what the listing reports.
     */
    group?: string
    available?: () => boolean
    /**
     * Counts against the per-connection budget for costly tools as well as
     * the ordinary ones (see mcp-rate-limit.ts). A function decides from the
     * raw arguments — unvalidated, so it must tolerate anything.
     */
    expensive?: ExpensiveMarker
  },
): ToolDefinition<InputSchema, OutputSchema> {
  const { kind, group, available, expensive, ...rest } = definition
  const kinds: readonly InstanceKind[] = Array.isArray(kind) ? kind : [kind as InstanceKind]

  TOOL_KINDS.set(rest.name, kinds)
  if (expensive) TOOL_COST.set(rest.name, expensive)

  // A tool argument of the same name would be shadowed by the injected one and
  // then stripped before its handler ran — fail at load instead.
  if (rest.inputSchema && 'reason' in rest.inputSchema) {
    throw new Error(`[mcp] tool ${rest.name} declares a 'reason' argument; that name is reserved (see REASON_FIELD)`)
  }

  return defineMcpTool<InputSchema, OutputSchema>({
    ...rest,
    // Cast: the injected field is invisible to the tool's own handler type on
    // purpose — the handler never receives it.
    inputSchema: { ...rest.inputSchema, reason: REASON_FIELD } as unknown as InputSchema,
    handler: countedHandler(rest.name, rest.handler),
    // Inferred from the directory too; stated so a move cannot silently change
    // which connections the tool belongs to. For a single-kind tool the group
    // *is* the kind, which is what every existing tool relies on.
    group: group ?? (kinds.length === 1 ? kinds[0]! : undefined),
    // Two gates, both fail closed — see `isToolAllowed`. `some` rather than a
    // single check because a multi-kind tool is allowed when the caller's kind
    // is any of its kinds; `isToolAllowed` still compares against the resolved
    // `auth.kind`, so exactly one of these can ever be true for a given request.
    // Kept synchronous: the toolkit evaluates `enabled` twice per request per
    // tool.
    enabled: event =>
      kinds.some(k => isToolAllowed(event, rest.name, k)) && (available?.() ?? true),
  })
}

/**
 * The tool's handler, with `reason` taken off its arguments, counted for the
 * hosted offering's usage rollup — tool name and outcome only, never arguments
 * or results (see hosted-events.ts) — and recorded with its reason when the
 * organization records tool calls (tool-calls.ts). Counting and recording are
 * synchronous and never throw, so neither can change what the tool answers; on
 * a self-hosted deployment that records nothing both return at their first
 * check.
 *
 * Every tool has an input schema now (the injected `reason` guarantees one),
 * so the SDK always calls `handler(args, extra)` and the arguments are `args[0]`.
 */
function countedHandler<H>(name: string, handler: H): H {
  if (typeof handler !== 'function') return handler
  const wrapped = async function (this: unknown, ...args: unknown[]) {
    let reason: unknown
    const [input] = args
    if (input && typeof input === 'object' && !Array.isArray(input) && 'reason' in input) {
      const { reason: given, ...rest } = input as Record<string, unknown>
      reason = given
      args = [rest, ...args.slice(1)]
    }

    let ok = false
    try {
      const result = await (handler as (...a: unknown[]) => unknown).apply(this, args)
      ok = !(result && typeof result === 'object' && (result as { isError?: unknown }).isError === true)
      return result
    }
    finally {
      try {
        const event = useEvent()
        const auth = event.context.mcpAuth as McpAuth | undefined
        if (auth) {
          countToolCall(auth.instance.org, auth.tokenId, name, ok)
          recordToolCall(auth, {
            tool: name,
            ok,
            reason: typeof reason === 'string' ? reason : undefined,
            userAgent: getRequestHeader(event, 'user-agent'),
          })
        }
      }
      catch {
        // No request context: nothing to attribute the call to.
      }
    }
  }
  return wrapped as H
}
