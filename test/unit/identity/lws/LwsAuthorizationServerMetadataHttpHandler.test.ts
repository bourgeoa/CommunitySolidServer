import { createResponse } from 'node-mocks-http';
import type { MockResponse } from 'node-mocks-http';
import type { LwsAccessTokenIssuer } from '../../../../src/identity/lws/LwsAccessTokenIssuer';
import {
  LwsAuthorizationServerMetadataHttpHandler,
} from '../../../../src/identity/lws/LwsAuthorizationServerMetadataHttpHandler';
import { GRANT_TYPE_TOKEN_EXCHANGE } from '../../../../src/identity/lws/LwsTokenHttpHandler';
import { TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_JWT } from '../../../../src/identity/lws/SubjectTokenVerifier';
import type { HttpRequest } from '../../../../src/server/HttpRequest';

describe('An LwsAuthorizationServerMetadataHttpHandler', (): void => {
  const issuer = { issuer: 'https://as.example/' } as LwsAccessTokenIssuer;
  let response: MockResponse<any>;

  beforeEach(async(): Promise<void> => {
    response = createResponse();
  });

  it('returns the authorization server metadata.', async(): Promise<void> => {
    const handler = new LwsAuthorizationServerMetadataHttpHandler({
      issuer,
      tokenPath: '/.lws/token',
      jwksPath: '.lws/jwks',
    });
    await expect(handler.handle({ request: { method: 'GET' } as HttpRequest, response })).resolves.toBeUndefined();
    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(response._getData())).toEqual({
      issuer: 'https://as.example/',
      token_endpoint: 'https://as.example/.lws/token',
      jwks_uri: 'https://as.example/.lws/jwks',
      grant_types_supported: [ GRANT_TYPE_TOKEN_EXCHANGE ],
      token_endpoint_auth_methods_supported: [ 'none' ],
      response_types_supported: [ 'token' ],
      claims_supported: [ 'sub', 'iss', 'client_id', 'aud', 'exp', 'iat', 'jti' ],
      subject_token_types_supported: [ TOKEN_TYPE_JWT, TOKEN_TYPE_ID_TOKEN ],
      subject_identifier_types_supported: [ 'https', 'did:key', 'did:web' ],
    });
  });

  it('can be configured with the supported token and identifier types.', async(): Promise<void> => {
    const handler = new LwsAuthorizationServerMetadataHttpHandler({
      issuer,
      tokenPath: 'token',
      jwksPath: 'jwks',
      subjectTokenTypes: [ TOKEN_TYPE_JWT ],
      subjectIdentifierTypes: [ 'did:key' ],
    });
    await handler.handle({ request: { method: 'GET' } as HttpRequest, response });
    expect(JSON.parse(response._getData())).toEqual(expect.objectContaining({
      subject_token_types_supported: [ TOKEN_TYPE_JWT ],
      subject_identifier_types_supported: [ 'did:key' ],
    }));
  });

  it('does not return a body for HEAD requests.', async(): Promise<void> => {
    const handler = new LwsAuthorizationServerMetadataHttpHandler({ issuer, tokenPath: 'token', jwksPath: 'jwks' });
    await handler.handle({ request: { method: 'HEAD' } as HttpRequest, response });
    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toEqual({ 'content-type': 'application/json' });
    expect(response._getData()).toBe('');
  });
});
