// The public route's discovery documents: protected resource metadata
// (RFC 9728) for `<origin>/mcp`, and authorization server metadata (RFC
// 8414) for the issuer `<origin>`

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REVOKE_PATH = '/oauth/revoke';

// what a client may ask for; offline_access is left out, as the MCP spec
// asks, and every grant gets a refresh token anyway
const SCOPES = ['read', 'exec', 'manage'];

export function buildProtectedResourceMetadata(issuer: string, resource: string) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'imp',
  };
}

export function buildAuthorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    revocation_endpoint: `${issuer}${REVOKE_PATH}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}
