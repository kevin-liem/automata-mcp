import { addComponent, addServerHandler, addServerPlugin, createResolver, defineNuxtModule } from '@nuxt/kit'
import { METADATA_PATHS } from './mcp-oauth/shared'

/** All OAuth registrations and defaults live here, outside upstream's config. */
export default defineNuxtModule({
  meta: { name: 'mcp-oauth' },
  setup(_options, nuxt) {
    const resolver = createResolver(import.meta.url)
    nuxt.options.runtimeConfig.mcpOauth = Object.assign({
      enabled: false,
      cookieKey: '',
      encryptionKey: '',
      jwks: '',
    }, nuxt.options.runtimeConfig.mcpOauth)
    addComponent({ name: 'McpOAuthConnect', filePath: resolver.resolve('./mcp-oauth/Connect.vue') })
    addServerPlugin(resolver.resolve('./mcp-oauth/runtime/plugin'))
    const handler = resolver.resolve('./mcp-oauth/runtime/handler')
    addServerHandler({ route: '/oauth/**', handler })
    addServerHandler({ route: '/api/mcp-oauth/status', handler })

    // The toolkit registers these exact URLs as 404 placeholders. Replace only
    // those placeholders, after every Nuxt module has registered its handlers.
    nuxt.hook('nitro:config', (config) => {
      config.handlers = (config.handlers ?? []).filter(entry => !(
        METADATA_PATHS.includes(entry?.route ?? '')
        && entry?.handler?.includes('/mcp/oauth-metadata')
      ))
      for (const route of METADATA_PATHS) config.handlers.push({ route, handler })
    })
  },
})
