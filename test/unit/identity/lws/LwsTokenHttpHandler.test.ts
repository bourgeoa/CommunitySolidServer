import { createResponse } from 'node-mocks-http';
import type { MockResponse } from 'node-mocks-http';
import type { LwsAccessTokenIssuer } from '../../../../src/identity/lws/LwsAccessTokenIssuer';
import { GRANT_TYPE_TOKEN_EXCHANGE, LwsTokenHttpHandler } from '../../../../src/identity/lws/LwsTokenHttpHandler';
import type { SubjectTokenVerifier } from '../../../../src/identity/lws/SubjectTokenVerifier';
import { TOKEN_TYPE_JWT } from '../../../../src/identity/lws/SubjectTokenVerifier';
import type { StorageLocationStrategy } from '../../../../src/server/description/StorageLocationStrategy';
import type { HttpRequest } from '../../../../src/server/HttpRequest';
import type { ResourceSet } from '../../../../src/storage/ResourceSet';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { guardedStreamFrom } from '../../../../src/util/StreamUtil';

function createRequest(body: string, contentType = 'application/x-www-form-urlencoded'): HttpRequest {
  const request = guardedStreamFrom(body) as HttpRequest;
  request.method = 'POST';
  request.headers = contentType ? { 'content-type': contentType } : {};
  return request;
}

describe('An LwsTokenHttpHandler', (): void => {
  const storage = 'https://storage.example/alice/';
  const subject = { subject: 'https://alice.example/#me', issuer: 'https://idp.example/', client: 'https://app.example/' };
  let params: Record<string, string>;
  let response: MockResponse<any>;
  let issuer: jest.Mocked<LwsAccessTokenIssuer>;
  let verifier: jest.Mocked<SubjectTokenVerifier>;
  let storageStrategy: jest.Mocked<StorageLocationStrategy>;
  let resourceSet: jest.Mocked<ResourceSet>;
  let handler: LwsTokenHttpHandler;

  async function handle(body = new URLSearchParams(params).toString(), contentType?: string): Promise<unknown> {
    await handler.handle({ request: createRequest(body, contentType), response });
    return JSON.parse(response._getData());
  }

  beforeEach(async(): Promise<void> => {
    params = {
      grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
      resource: storage,
      subject_token: 'token',
      subject_token_type: TOKEN_TYPE_JWT,
    };
    response = createResponse();

    issuer = {
      issuer: 'https://as.example/',
      lifetime: 300,
      issue: jest.fn().mockResolvedValue('access-token'),
    } as any;

    verifier = {
      handleSafe: jest.fn().mockResolvedValue(subject),
    } as any;

    storageStrategy = {
      getStorageIdentifier: jest.fn().mockResolvedValue({ path: storage }),
    };

    resourceSet = {
      hasResource: jest.fn().mockResolvedValue(true),
    };

    handler = new LwsTokenHttpHandler({ issuer, verifier, storageStrategy, resourceSet });
  });

  function expectHeaders(status: number): void {
    expect(response.statusCode).toBe(status);
    expect(response.getHeaders()).toEqual({
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });
  }

  it('issues an access token.', async(): Promise<void> => {
    await expect(handle(undefined, 'application/x-www-form-urlencoded; charset=utf-8')).resolves.toEqual({
      access_token: 'access-token',
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      expires_in: 300,
    });
    expectHeaders(200);
    expect(verifier.handleSafe).toHaveBeenCalledTimes(1);
    expect(verifier.handleSafe)
      .toHaveBeenLastCalledWith({ token: 'token', tokenType: TOKEN_TYPE_JWT, audience: 'https://as.example/' });
    expect(storageStrategy.getStorageIdentifier).toHaveBeenLastCalledWith({ path: storage });
    expect(resourceSet.hasResource).toHaveBeenLastCalledWith({ path: storage });
    expect(issuer.issue).toHaveBeenLastCalledWith(subject.subject, subject.client, storage);
  });

  it('requires a form encoded body.', async(): Promise<void> => {
    await expect(handle(undefined, 'application/json')).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'Token requests need to use application/x-www-form-urlencoded.',
    });
    expectHeaders(400);

    response = createResponse();
    await handler.handle({ request: createRequest('', ''), response });
    expect(JSON.parse(response._getData())).toEqual(expect.objectContaining({ error: 'invalid_request' }));
  });

  it('only supports the token exchange grant type.', async(): Promise<void> => {
    params.grant_type = 'authorization_code';
    await expect(handle()).resolves.toEqual({
      error: 'unsupported_grant_type',
      error_description: `Only the ${GRANT_TYPE_TOKEN_EXCHANGE} grant type is supported.`,
    });
    expectHeaders(400);
  });

  it('requires single non-empty values for the parameters.', async(): Promise<void> => {
    delete (params as any).grant_type;
    await expect(handle()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'The grant_type parameter is required and must have a single value.',
    });

    response = createResponse();
    const body = `${new URLSearchParams(params).toString()}&resource=${encodeURIComponent(storage)}`;
    await expect(handle(`grant_type=${encodeURIComponent(GRANT_TYPE_TOKEN_EXCHANGE)}&${body}`)).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'The resource parameter is required and must have a single value.',
    });

    response = createResponse();
    params = { grant_type: GRANT_TYPE_TOKEN_EXCHANGE, resource: storage, subject_token: '' };
    await expect(handle()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'The subject_token parameter is required and must have a single value.',
    });
    expect(verifier.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('rejects resources that are not storages on this server.', async(): Promise<void> => {
    const expected = {
      error: 'invalid_target',
      error_description: `${storage} is not a storage known to this authorization server.`,
    };
    storageStrategy.getStorageIdentifier.mockRejectedValueOnce(new Error('not here'));
    await expect(handle()).resolves.toEqual(expected);
    expectHeaders(400);

    response = createResponse();
    storageStrategy.getStorageIdentifier.mockResolvedValueOnce({ path: 'https://storage.example/' });
    await expect(handle()).resolves.toEqual(expected);

    response = createResponse();
    resourceSet.hasResource.mockResolvedValueOnce(false);
    await expect(handle()).resolves.toEqual(expected);
    expect(verifier.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('rejects unsupported subject tokens.', async(): Promise<void> => {
    verifier.handleSafe.mockRejectedValueOnce(new NotImplementedHttpError('unknown type'));
    await expect(handle()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'Unsupported subject token: unknown type',
    });
    expectHeaders(400);
  });

  it('rejects invalid subject tokens.', async(): Promise<void> => {
    verifier.handleSafe.mockRejectedValueOnce(new BadRequestHttpError('bad signature'));
    await expect(handle()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'Invalid subject token: bad signature',
    });
    expectHeaders(400);
    expect(issuer.issue).toHaveBeenCalledTimes(0);
  });

  it('throws other errors.', async(): Promise<void> => {
    const error = new Error('bad key');
    issuer.issue.mockRejectedValueOnce(error);
    await expect(handler.handle({ request: createRequest(new URLSearchParams(params).toString()), response }))
      .rejects.toBe(error);
  });
});
