import { createResponse } from 'node-mocks-http';
import type { MockResponse } from 'node-mocks-http';
import type { TargetExtractor } from '../../../../src/http/input/identifier/TargetExtractor';
import {
  getProtectedResourceMetadataUrl,
  LwsProtectedResourceMetadataHttpHandler,
} from '../../../../src/server/description/LwsProtectedResourceMetadataHttpHandler';
import type { HttpRequest } from '../../../../src/server/HttpRequest';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';

describe('getProtectedResourceMetadataUrl', (): void => {
  it('inserts the well-known path after the base URL.', async(): Promise<void> => {
    expect(getProtectedResourceMetadataUrl('https://example.com/', 'https://example.com/alice/img.jpg?a=b'))
      .toBe('https://example.com/.well-known/oauth-protected-resource/alice/img.jpg?a=b');
    expect(getProtectedResourceMetadataUrl('https://example.com/base', 'https://example.com/base/alice/'))
      .toBe('https://example.com/base/.well-known/oauth-protected-resource/alice/');
    expect(getProtectedResourceMetadataUrl('https://example.com/', 'https://example.com/', 'prm'))
      .toBe('https://example.com/prm');
    expect(getProtectedResourceMetadataUrl('https://example.com/', 'https://other.example/'))
      .toBe('https://example.com/.well-known/oauth-protected-resource');
  });
});

describe('A LwsProtectedResourceMetadataHttpHandler', (): void => {
  const baseUrl = 'https://example.com/';
  let request: HttpRequest;
  let response: MockResponse<any>;
  let targetExtractor: jest.Mocked<TargetExtractor>;
  let handler: LwsProtectedResourceMetadataHttpHandler;

  async function getMetadata(path: string): Promise<unknown> {
    targetExtractor.handleSafe.mockResolvedValueOnce({ path });
    response = createResponse();
    await handler.handle({ request, response });
    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toEqual({ 'content-type': 'application/json' });
    return JSON.parse(response._getData());
  }

  beforeEach(async(): Promise<void> => {
    request = { method: 'GET' } as any;
    targetExtractor = { handleSafe: jest.fn() } as any;
    handler = new LwsProtectedResourceMetadataHttpHandler({
      baseUrl,
      targetExtractor,
      authorizationServers: [ baseUrl ],
    });
  });

  it('returns the metadata of the resource identified by the URL.', async(): Promise<void> => {
    await expect(getMetadata('https://example.com/.well-known/oauth-protected-resource/alice/img.jpg?a=b'))
      .resolves.toEqual({
        resource: 'https://example.com/alice/img.jpg?a=b',
        authorization_servers: [ baseUrl ],
        bearer_methods_supported: [ 'header' ],
      });
    expect(targetExtractor.handleSafe).toHaveBeenLastCalledWith({ request });
  });

  it('returns the metadata of the root without a path.', async(): Promise<void> => {
    await expect(getMetadata('https://example.com/.well-known/oauth-protected-resource'))
      .resolves.toEqual(expect.objectContaining({ resource: baseUrl }));
    await expect(getMetadata('https://example.com/.well-known/oauth-protected-resource/'))
      .resolves.toEqual(expect.objectContaining({ resource: baseUrl }));
  });

  it('supports a custom path.', async(): Promise<void> => {
    handler = new LwsProtectedResourceMetadataHttpHandler({
      baseUrl: 'https://example.com',
      targetExtractor,
      authorizationServers: [ baseUrl ],
      metadataPath: 'prm',
    });
    await expect(getMetadata('https://example.com/prm/foo'))
      .resolves.toEqual(expect.objectContaining({ resource: 'https://example.com/foo' }));
  });

  it('does not send a body for HEAD requests.', async(): Promise<void> => {
    request.method = 'HEAD';
    targetExtractor.handleSafe.mockResolvedValueOnce({ path: 'https://example.com/.well-known/oauth-protected-resource' });
    response = createResponse();
    await handler.handle({ request, response });
    expect(response._getData()).toBe('');
  });

  it('throws a 404 for other URLs.', async(): Promise<void> => {
    targetExtractor.handleSafe.mockResolvedValueOnce({ path: 'https://example.com/.well-known/oauth-protected-resources' });
    await expect(handler.handle({ request, response: createResponse() })).rejects.toThrow(NotFoundHttpError);
  });
});
