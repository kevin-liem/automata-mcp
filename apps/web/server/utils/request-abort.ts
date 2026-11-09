import type { H3Event } from 'h3'

const SIGNAL = Symbol('requestAbortSignal')

/**
 * An `AbortSignal` that fires when the client goes away before this request's
 * answer has been written.
 *
 * **Why the HTTP connection, and not MCP's own cancellation.** The SDK hands
 * tool handlers a `signal` of its own, which aborts on `notifications/cancelled`.
 * We run stateless: every HTTP request gets a fresh SDK server, so a
 * cancellation notification arrives on a *different* request, at a server that
 * never saw the call it names. The socket closing under this request is the
 * only signal that reaches the handler doing the work.
 *
 * `writableFinished` separates a client that gave up from the normal end of a
 * response: `close` fires in both cases, after the answer only once it has been
 * written.
 *
 * One controller per request, memoised on the event, so several statements in
 * one tool call share a single listener on the response.
 */
export function requestAbortSignal(event: H3Event = useEvent()): AbortSignal {
  const context = event.context as { [SIGNAL]?: AbortSignal }
  const existing = context[SIGNAL]
  if (existing) return existing

  const controller = new AbortController()
  const res = event.node.res
  if (res.writableFinished || res.destroyed) {
    controller.abort()
  }
  else {
    res.once('close', () => {
      if (!res.writableFinished) controller.abort()
    })
  }
  context[SIGNAL] = controller.signal
  return controller.signal
}
