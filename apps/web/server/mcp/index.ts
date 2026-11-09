/**
 * Default MCP handler. Applies to both routes:
 *
 *   POST /mcp            Authorization: Bearer <token>
 *   POST /mcp/<token>    path-segment fallback, registered by
 *                        modules/mcp-token-route.ts
 *
 * `middleware` runs inside the route handler, after routing (so
 * `getRouterParam(event, 'token')` is populated) and before any tool is
 * registered. Returning a `Response` short-circuits — nothing downstream runs.
 */
export default defineMcpHandler({
  middleware: async (event, next) => {
    const auth = await resolveMcpAuth(event)

    if (!auth) {
      // 401 + WWW-Authenticate. Never 200-with-an-error-body: to a client that
      // reads like a tool that ran and declined.
      return mcpUnauthorized()
    }

    // A valid credential beyond its organization's limits: 403, never 401,
    // since it works again the moment the limits rise. No limits — every
    // self-hosted organization — costs nothing here. See entitlements.ts.
    const refusal = await mcpLimitRefusal(auth.instance.org, auth.tokenId, auth.limits)
    if (refusal) return refusal

    // The MCP-only context key. UI code reads `event.context.user`; these two
    // are never cross-read. See server/utils/mcp-auth.ts.
    event.context.mcpAuth = auth

    // Body capped here, after auth, rather than in 00-body-limit.ts: a caller
    // without a token never gets a byte read, and a tool call gets more room
    // than the UI. Buffered into h3's cache, which the toolkit's read replays.
    try {
      await readCappedBody(event, MCP_BODY_LIMIT)
    }
    catch (error) {
      const status = (error as { statusCode?: number })?.statusCode === 413 ? 413 : 400
      return mcpBodyRefused(status)
    }

    // Which client this token is used from, recorded on `initialize` only and
    // never awaited past the body read. Here rather than in a tool or hook: we
    // run stateless, so nothing later in the request has seen the initialize.
    // See server/utils/mcp-clients.ts.
    await captureTokenClient(event, auth.tokenId)

    return next()
  },
})
