/**
 * The MCP surface carries bearer tokens in two places: the `Authorization`
 * header and — for clients that cannot set headers — the URL itself
 * (`/mcp/<token>`). Neither may reach a log line, an error report, or a trace.
 *
 * Used by server/plugins/redact-mcp.ts. Reach for these in any logging or
 * error-reporting code you add later.
 */

const REDACTED = '[redacted]'

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'apikey',
  'x-api-key',
  'x-webhook-secret',
])

/** `/mcp/wamcp_abc123?foo=1` -> `/mcp/[redacted]` */
export function redactPath(path: string | undefined): string {
  if (!path) return ''
  const [pathname] = path.split('?')

  if (isMediaDownloadPath(pathname)) return `/api/media/whatsapp/${REDACTED}`

  if (pathname === '/mcp' || !pathname!.startsWith('/mcp')) {
    return pathname!
  }

  return `/mcp/${REDACTED}`
}

export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!headers) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value
  }
  return out
}

/** True for any request on the MCP surface, including the path-token form. */
export function isMcpPath(path: string | undefined): boolean {
  if (!path) return false
  const [pathname] = path.split('?')
  return pathname === '/mcp' || pathname!.startsWith('/mcp/')
}

export function isMediaDownloadPath(path: string | undefined): boolean {
  return Boolean(path?.split('?')[0]?.startsWith('/api/media/whatsapp/'))
}
