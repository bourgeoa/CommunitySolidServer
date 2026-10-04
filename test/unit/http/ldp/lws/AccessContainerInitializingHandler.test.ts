import {
  AccessContainerInitializingHandler,
} from '../../../../../src/http/ldp/lws/AccessContainerInitializingHandler';
import type { Operation } from '../../../../../src/http/Operation';
import type { ResponseDescription } from '../../../../../src/http/output/response/ResponseDescription';
import { BasicRepresentation } from '../../../../../src/http/representation/BasicRepresentation';
import type { ResourceIdentifier } from '../../../../../src/http/representation/ResourceIdentifier';
import type { Logger } from '../../../../../src/logging/Logger';
import { getLoggerFor } from '../../../../../src/logging/LogUtil';
import type { StorageLocationStrategy } from '../../../../../src/server/description/StorageLocationStrategy';
import type { HttpRequest } from '../../../../../src/server/HttpRequest';
import type { HttpResponse } from '../../../../../src/server/HttpResponse';
import type { OperationHttpHandler } from '../../../../../src/server/OperationHttpHandler';
import type { ResourceSet } from '../../../../../src/storage/ResourceSet';
import type { ResourceStore } from '../../../../../src/storage/ResourceStore';
import { NotFoundHttpError } from '../../../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../../../src/util/errors/NotImplementedHttpError';

jest.mock('../../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { info: jest.fn(), warn: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('An AccessContainerInitializingHandler', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor('mock') as any;
  const request: HttpRequest = {} as any;
  const response: HttpResponse = {} as any;
  const storage = { path: 'http://example.com/alice/' };
  const grants = 'http://example.com/alice/.lws/grants/';
  const requests = 'http://example.com/alice/.lws/requests/';
  const result: ResponseDescription = { statusCode: 200 };
  let existing: Set<string>;
  let operation: Operation;
  let source: jest.Mocked<OperationHttpHandler>;
  let storageStrategy: jest.Mocked<StorageLocationStrategy>;
  let resourceSet: jest.Mocked<ResourceSet>;
  let store: jest.Mocked<ResourceStore>;
  let handler: AccessContainerInitializingHandler;

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    existing = new Set([ storage.path, requests ]);

    operation = {
      method: 'GET',
      target: { path: 'http://example.com/alice/foo' },
      body: new BasicRepresentation(),
      preferences: {},
    };

    source = {
      canHandle: jest.fn(),
      handle: jest.fn().mockResolvedValue(result),
    } as any;

    storageStrategy = {
      getStorageIdentifier: jest.fn().mockResolvedValue(storage),
    };

    resourceSet = {
      hasResource: jest.fn(async(id: ResourceIdentifier): Promise<boolean> => existing.has(id.path)),
    };

    store = {
      setRepresentation: jest.fn(async(id: ResourceIdentifier): Promise<any> => {
        existing.add(id.path);
        return new Map();
      }),
    } as any;

    handler = new AccessContainerInitializingHandler({
      source,
      storageStrategy,
      resourceSet,
      store,
      paths: [ '.lws/grants/', '.lws/requests/' ],
    });
  });

  it('uses the source handler to determine if it can handle the input.', async(): Promise<void> => {
    await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    expect(source.canHandle).toHaveBeenLastCalledWith({ request, response, operation });

    source.canHandle.mockRejectedValueOnce(new NotImplementedHttpError());
    await expect(handler.canHandle({ request, response, operation })).rejects.toThrow(NotImplementedHttpError);
  });

  it('creates the missing containers before calling the source handler.', async(): Promise<void> => {
    await expect(handler.handle({ request, response, operation })).resolves.toBe(result);
    expect(store.setRepresentation).toHaveBeenCalledTimes(1);
    expect(store.setRepresentation.mock.calls[0][0]).toEqual({ path: grants });
    expect(store.setRepresentation.mock.calls[0][1].metadata.contentType).toBe('internal/quads');
    expect(source.handle).toHaveBeenLastCalledWith({ request, response, operation });
  });

  it('only checks every storage once.', async(): Promise<void> => {
    await expect(handler.handle({ request, response, operation })).resolves.toBe(result);
    await expect(handler.handle({ request, response, operation })).resolves.toBe(result);
    expect(storageStrategy.getStorageIdentifier).toHaveBeenCalledTimes(2);
    expect(resourceSet.hasResource).toHaveBeenCalledTimes(3);
    expect(store.setRepresentation).toHaveBeenCalledTimes(1);
    expect(source.handle).toHaveBeenCalledTimes(2);
  });

  it('does nothing if the storage could not be determined.', async(): Promise<void> => {
    storageStrategy.getStorageIdentifier.mockRejectedValueOnce(new NotFoundHttpError());
    await expect(handler.handle({ request, response, operation })).resolves.toBe(result);
    expect(resourceSet.hasResource).toHaveBeenCalledTimes(0);
    expect(store.setRepresentation).toHaveBeenCalledTimes(0);
  });

  it('checks the storage again on the next request if it does not exist yet.', async(): Promise<void> => {
    existing.delete(storage.path);
    await expect(handler.handle({ request, response, operation })).resolves.toBe(result);
    expect(store.setRepresentation).toHaveBeenCalledTimes(0);

    existing.add(storage.path);
    await expect(handler.handle({ request, response, operation })).resolves.toBe(result);
    expect(store.setRepresentation).toHaveBeenCalledTimes(1);
  });

  it('logs errors and tries again on the next request.', async(): Promise<void> => {
    store.setRepresentation.mockRejectedValueOnce(new Error('bad data'));
    await expect(handler.handle({ request, response, operation })).resolves.toBe(result);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'Unable to create the access containers of http://example.com/alice/: bad data',
    );
    expect(source.handle).toHaveBeenCalledTimes(1);

    await expect(handler.handle({ request, response, operation })).resolves.toBe(result);
    expect(store.setRepresentation).toHaveBeenCalledTimes(2);
    expect(existing.has(grants)).toBe(true);
  });
});
