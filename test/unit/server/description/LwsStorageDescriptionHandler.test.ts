import type { Operation } from '../../../../src/http/Operation';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { LwsStorageDescriber } from '../../../../src/server/description/LwsStorageDescriber';
import type { LwsStorageDescriptionHandlerArgs } from '../../../../src/server/description/LwsStorageDescriptionHandler';
import { LwsStorageDescriptionHandler } from '../../../../src/server/description/LwsStorageDescriptionHandler';
import type { StorageLocationStrategy } from '../../../../src/server/description/StorageLocationStrategy';
import type { HttpRequest } from '../../../../src/server/HttpRequest';
import type { HttpResponse } from '../../../../src/server/HttpResponse';
import type { ResourceSet } from '../../../../src/storage/ResourceSet';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { readableToString } from '../../../../src/util/StreamUtil';

describe('A LwsStorageDescriptionHandler', (): void => {
  const request: HttpRequest = {} as any;
  const response: HttpResponse = {} as any;
  const storage = { path: 'http://example.com/alice/' };
  let operation: Operation;
  let storageStrategy: jest.Mocked<StorageLocationStrategy>;
  let resourceSet: jest.Mocked<ResourceSet>;
  let args: LwsStorageDescriptionHandlerArgs;
  let handler: LwsStorageDescriptionHandler;

  beforeEach(async(): Promise<void> => {
    operation = {
      method: 'GET',
      target: storage,
      body: new BasicRepresentation(),
      preferences: {},
    };

    storageStrategy = {
      getStorageIdentifier: jest.fn().mockResolvedValue(storage),
    };

    resourceSet = {
      hasResource: jest.fn().mockResolvedValue(true),
    };

    args = { storageStrategy, resourceSet };
    handler = new LwsStorageDescriptionHandler(args);
  });

  describe('canHandle', (): void => {
    it('only supports GET and HEAD requests.', async(): Promise<void> => {
      operation.method = 'POST';
      await expect(handler.canHandle({ request, response, operation })).rejects.toThrow(NotImplementedHttpError);
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('Only GET and HEAD requests can target the storage description.');

      operation.method = 'HEAD';
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    });

    it('accepts requests without type preferences.', async(): Promise<void> => {
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
      operation.preferences = { type: {}};
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    });

    it('accepts requests that explicitly prefer the storage description.', async(): Promise<void> => {
      operation.preferences = { type: { 'application/lws+cid': 1, 'text/turtle': 0.5, '*/*': 0.1 }};
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    });

    it('accepts requests with an equally weighted other type.', async(): Promise<void> => {
      operation.preferences = { type: { 'application/lws+cid': 1, 'text/turtle': 1 }};
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    });

    it('rejects requests that do not accept the storage description.', async(): Promise<void> => {
      operation.preferences = { type: { 'text/turtle': 1 }};
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('The request does not prefer the storage description.');

      operation.preferences = { type: { 'application/lws+cid': 0, '*/*': 1 }};
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('The request does not prefer the storage description.');
    });

    it('rejects requests that prefer a different explicit type.', async(): Promise<void> => {
      operation.preferences = { type: { 'application/lws+cid': 0.5, 'text/turtle': 1 }};
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('The request does not prefer the storage description.');

      operation.preferences = { type: { 'text/turtle': 1, '*/*': 0.8 }};
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('The request does not prefer the storage description.');
    });

    it('accepts wildcard requests by default.', async(): Promise<void> => {
      operation.preferences = { type: { '*/*': 1 }};
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();

      operation.preferences = { type: { 'application/*': 1, '*/*': 0.5 }};
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    });

    it('rejects wildcard requests if configured that way.', async(): Promise<void> => {
      handler = new LwsStorageDescriptionHandler({ ...args, wildcardDescribes: false });
      operation.preferences = { type: { '*/*': 1 }};
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('The request does not prefer the storage description.');

      operation.preferences = { type: { 'application/lws+cid': 1, '*/*': 0.5 }};
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    });

    it('rejects targets that are not a storage.', async(): Promise<void> => {
      storageStrategy.getStorageIdentifier.mockResolvedValueOnce({ path: 'http://example.com/' });
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('http://example.com/alice/ is not the URI of a storage.');
      expect(storageStrategy.getStorageIdentifier).toHaveBeenLastCalledWith(storage);
    });

    it('rejects storages that do not exist.', async(): Promise<void> => {
      resourceSet.hasResource.mockResolvedValueOnce(false);
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('http://example.com/alice/ is not the URI of a storage.');
      expect(resourceSet.hasResource).toHaveBeenLastCalledWith(storage);
    });

    it('rejects targets for which no storage can be found.', async(): Promise<void> => {
      storageStrategy.getStorageIdentifier.mockRejectedValueOnce(new NotFoundHttpError());
      await expect(handler.canHandle({ request, response, operation }))
        .rejects.toThrow('http://example.com/alice/ is not the URI of a storage.');
    });
  });

  describe('handle', (): void => {
    it('returns the storage description.', async(): Promise<void> => {
      const result = await handler.handle({ request, response, operation });
      expect(result.statusCode).toBe(200);
      expect(result.metadata?.contentType).toBe('application/lws+cid');
      expect(result.metadata?.identifier.value).toBe(storage.path);
      expect(JSON.parse(await readableToString(result.data!))).toEqual({
        '@context': [ 'https://www.w3.org/ns/cid/v1', 'https://www.w3.org/ns/lws/v1' ],
        id: storage.path,
        type: 'Storage',
        service: [{ type: 'StorageRoot', serviceEndpoint: storage.path }],
      });
    });

    it('includes the configured services and capabilities.', async(): Promise<void> => {
      handler = new LwsStorageDescriptionHandler({
        ...args,
        services: [
          { type: 'Relative', serviceEndpoint: 'notifications/' },
          { type: 'Absolute', serviceEndpoint: 'http://other.example.com/endpoint' },
          { type: [ 'NoEndpoint', 'Other' ], extra: true },
        ],
        capabilities: [{ type: 'JsonMergePatch' }],
      });
      const result = await handler.handle({ request, response, operation });
      expect(JSON.parse(await readableToString(result.data!))).toEqual({
        '@context': [ 'https://www.w3.org/ns/cid/v1', 'https://www.w3.org/ns/lws/v1' ],
        id: storage.path,
        type: 'Storage',
        service: [
          { type: 'StorageRoot', serviceEndpoint: storage.path },
          { type: 'Relative', serviceEndpoint: 'http://example.com/alice/notifications/' },
          { type: 'Absolute', serviceEndpoint: 'http://other.example.com/endpoint' },
          { type: [ 'NoEndpoint', 'Other' ], extra: true },
        ],
        capability: [{ type: 'JsonMergePatch' }],
      });
    });

    it('lets the describers extend the storage description.', async(): Promise<void> => {
      const describer1: jest.Mocked<LwsStorageDescriber> = {
        handleSafe: jest.fn(async({ description }): Promise<void> => {
          description.service.push({ type: 'Extra', serviceEndpoint: 'http://example.com/extra' });
        }),
      } as any;
      const describer2: jest.Mocked<LwsStorageDescriber> = {
        handleSafe: jest.fn(async({ description }): Promise<void> => {
          description.verificationMethod = [{ id: 'key' }];
        }),
      } as any;
      handler = new LwsStorageDescriptionHandler({ ...args, describers: [ describer1, describer2 ]});
      const result = await handler.handle({ request, response, operation });
      expect(JSON.parse(await readableToString(result.data!))).toEqual({
        '@context': [ 'https://www.w3.org/ns/cid/v1', 'https://www.w3.org/ns/lws/v1' ],
        id: storage.path,
        type: 'Storage',
        service: [
          { type: 'StorageRoot', serviceEndpoint: storage.path },
          { type: 'Extra', serviceEndpoint: 'http://example.com/extra' },
        ],
        verificationMethod: [{ id: 'key' }],
      });
      expect(describer1.handleSafe).toHaveBeenCalledTimes(1);
      expect(describer1.handleSafe.mock.calls[0][0].storage).toBe(storage);
      expect(describer2.handleSafe).toHaveBeenCalledTimes(1);
    });

    it('fails if a describer fails.', async(): Promise<void> => {
      const describer: jest.Mocked<LwsStorageDescriber> = {
        handleSafe: jest.fn().mockRejectedValue(new Error('bad data')),
      } as any;
      handler = new LwsStorageDescriptionHandler({ ...args, describers: [ describer ]});
      await expect(handler.handle({ request, response, operation })).rejects.toThrow('bad data');
    });

    it('returns no data for HEAD requests.', async(): Promise<void> => {
      operation.method = 'HEAD';
      const result = await handler.handle({ request, response, operation });
      expect(result.statusCode).toBe(200);
      expect(result.metadata?.contentType).toBe('application/lws+cid');
      expect(result.data).toBeUndefined();
    });
  });
});
