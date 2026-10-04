import { createResponse } from 'node-mocks-http';
import type { MockResponse } from 'node-mocks-http';
import type { LwsAccessTokenIssuer } from '../../../../src/identity/lws/LwsAccessTokenIssuer';
import { LwsJwksHttpHandler } from '../../../../src/identity/lws/LwsJwksHttpHandler';
import type { HttpRequest } from '../../../../src/server/HttpRequest';

describe('An LwsJwksHttpHandler', (): void => {
  const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'kid', use: 'sig' };
  let response: MockResponse<any>;
  let issuer: jest.Mocked<LwsAccessTokenIssuer>;
  let handler: LwsJwksHttpHandler;

  beforeEach(async(): Promise<void> => {
    response = createResponse();
    issuer = {
      getPublicJwk: jest.fn().mockResolvedValue(jwk),
    } as any;
    handler = new LwsJwksHttpHandler(issuer);
  });

  it('returns the public key as a JWKS.', async(): Promise<void> => {
    await expect(handler.handle({ request: { method: 'GET' } as HttpRequest, response })).resolves.toBeUndefined();
    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toEqual({ 'content-type': 'application/jwk-set+json' });
    expect(JSON.parse(response._getData())).toEqual({ keys: [ jwk ]});
  });

  it('does not return a body for HEAD requests.', async(): Promise<void> => {
    await handler.handle({ request: { method: 'HEAD' } as HttpRequest, response });
    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toEqual({ 'content-type': 'application/jwk-set+json' });
    expect(response._getData()).toBe('');
  });
});
