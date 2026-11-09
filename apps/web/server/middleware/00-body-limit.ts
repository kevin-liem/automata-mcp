/**
 * Caps every request body before anything reads it. Runs first (file order) and
 * reads the body into h3's cache under the path's limit, so `parseBody`, the
 * webhooks' `readBody` and any route added later replay a bounded buffer —
 * no route can buffer an unbounded body by forgetting to ask. See
 * server/utils/body-limit.ts.
 *
 * /mcp is skipped here and capped in server/mcp/index.ts after the token
 * authenticates, with its own larger limit: an unauthenticated caller there
 * gets its 401 without a byte of its body read.
 */
export default defineEventHandler(async (event) => {
  if (isMcpPath(event.path)) return
  await readCappedBody(event, bodyLimitFor(event.path))
})
