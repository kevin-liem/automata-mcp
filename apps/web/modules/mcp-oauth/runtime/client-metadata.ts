export const MCP_GRANT_TYPES = ['authorization_code', 'refresh_token']
const SHARED_SECRET_METHODS = ['client_secret_basic', 'client_secret_post', 'client_secret_jwt']

/**
 * oidc-provider 9.13 reads the singular authentication preference. Modern CIMD
 * documents describe capabilities instead: select the intersection with this
 * server's public-client PKCE policy, without enabling other grant types.
 */
export function negotiateCimdCapabilities(fetchMetadata: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchMetadata(input, init)
    if (response.status !== 200) return response
    let document: unknown
    try { document = await response.clone().json() }
    catch { return response }
    const id = input instanceof Request ? input.url : input.toString()
    if (!document || typeof document !== 'object' || Array.isArray(document)) return response
    const metadata = document as Record<string, unknown>
    // Let the provider reject mismatched identities; never rewrite one.
    if (metadata.client_id !== id) return response

    const negotiated = { ...metadata }
    const methods = metadata.token_endpoint_auth_methods_supported
    if (methods !== undefined) {
      if (!Array.isArray(methods) || !methods.length || methods.some(method => typeof method !== 'string')) {
        throw new Error('Invalid client authentication capability list.')
      }
      if (!methods.includes('none')) throw new Error('The OAuth client does not support this server\'s public-client PKCE authentication.')
      if (SHARED_SECRET_METHODS.includes(String(metadata.token_endpoint_auth_method))) {
        throw new Error('Client metadata documents cannot use shared-secret authentication.')
      }
      negotiated.token_endpoint_auth_method = 'none'
      // A JWT assertion algorithm is not a parameter of the selected none method.
      delete negotiated.token_endpoint_auth_signing_alg
    }
    if (metadata.grant_types !== undefined) {
      if (!Array.isArray(metadata.grant_types) || metadata.grant_types.some(grant => typeof grant !== 'string')) {
        throw new Error('Invalid client grant capability list.')
      }
      const grants = metadata.grant_types.filter(grant => MCP_GRANT_TYPES.includes(grant))
      if (!grants.includes('authorization_code')) throw new Error('The OAuth client must support the authorization-code grant.')
      negotiated.grant_types = grants
    }

    const headers = new Headers(response.headers)
    // The rewritten JSON has a different wire representation.
    for (const name of ['content-length', 'content-encoding', 'etag']) headers.delete(name)
    return new Response(JSON.stringify(negotiated), { status: response.status, statusText: response.statusText, headers })
  }
}
