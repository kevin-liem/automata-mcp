import { getOAuthService, isOAuthEnabled } from './runtime'

/** OAuth-specific redaction stays in the module, including authorization codes. */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('request', (event) => {
    if (!event.path.startsWith('/oauth/')) return
    event.context.noLog = true
    if (event.node.req.originalUrl) event.node.req.originalUrl = '/oauth/[redacted]'
  })
  nitro.hooks.hook('error', (error, context) => {
    if (!context.event?.path.startsWith('/oauth/')) return
    context.event._path = '/oauth/[redacted]'
    if (error && typeof error === 'object' && 'url' in error) error.url = '/oauth/[redacted]'
  })
  if (isOAuthEnabled()) {
    getOAuthService().catch(() => {})
  }
})
