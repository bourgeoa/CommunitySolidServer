import type { OperationHandler } from '../../../../../src/http/ldp/OperationHandler';
import type {
  AccessDocumentOperationHandlerArgs,
} from '../../../../../src/http/ldp/lws/AccessDocumentOperationHandler';
import { AccessDocumentOperationHandler } from '../../../../../src/http/ldp/lws/AccessDocumentOperationHandler';
import type { Operation } from '../../../../../src/http/Operation';
import type { ResponseDescription } from '../../../../../src/http/output/response/ResponseDescription';
import { BasicRepresentation } from '../../../../../src/http/representation/BasicRepresentation';
import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import type { Logger } from '../../../../../src/logging/Logger';
import { getLoggerFor } from '../../../../../src/logging/LogUtil';
import type { StorageLocationStrategy } from '../../../../../src/server/description/StorageLocationStrategy';
import type { LwsNotificationSender } from '../../../../../src/server/notifications/lws/LwsNotificationSender';
import { BadRequestHttpError } from '../../../../../src/util/errors/BadRequestHttpError';
import { MethodNotAllowedHttpError } from '../../../../../src/util/errors/MethodNotAllowedHttpError';
import { NotFoundHttpError } from '../../../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../../../src/util/errors/NotImplementedHttpError';
import { UnsupportedMediaTypeHttpError } from '../../../../../src/util/errors/UnsupportedMediaTypeHttpError';
import { readableToString } from '../../../../../src/util/StreamUtil';
import { SOLID_HTTP } from '../../../../../src/util/Vocabularies';
import { flushPromises } from '../../../../util/Util';

jest.mock('../../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { warn: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('An AccessDocumentOperationHandler', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor('mock') as any;
  const storage = { path: 'http://example.com/alice/' };
  const grants = 'http://example.com/alice/.lws/grants/';
  const requests = 'http://example.com/alice/.lws/requests/';
  const location = `${grants}new`;
  const inbox = 'http://example.org/bob/inbox';
  let document: Record<string, any>;
  let result: ResponseDescription;
  let operation: Operation;
  let source: jest.Mocked<OperationHandler>;
  let storageStrategy: jest.Mocked<StorageLocationStrategy>;
  let sender: jest.Mocked<LwsNotificationSender>;
  let args: AccessDocumentOperationHandlerArgs;
  let handler: AccessDocumentOperationHandler;

  function post(target: string, body: string, contentType?: string): void {
    operation = {
      method: 'POST',
      target: { path: target },
      body: new BasicRepresentation(body, new RepresentationMetadata(contentType)),
      preferences: {},
    };
  }

  function createDocument(type: string): Record<string, any> {
    return {
      '@context': 'https://www.w3.org/ns/lws/v1',
      type,
      storage: storage.path,
      inbox,
      access: [
        {
          type: 'AccessPolicy',
          action: [ 'read' ],
          assignee: 'http://example.org/bob',
          target: { type: 'DataResource', value: [ `${storage.path}foo` ]},
        },
        {
          type: 'AccessPolicy',
          action: [ 'read' ],
          assignee: 'http://example.org/carol',
        },
      ],
    };
  }

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    document = createDocument('AccessGrant');
    post(grants, JSON.stringify(document), 'application/lws+json');

    result = {
      statusCode: 201,
      metadata: new RepresentationMetadata({ [SOLID_HTTP.location]: location }),
    };

    source = {
      canHandle: jest.fn(),
      handle: jest.fn(async(): Promise<ResponseDescription> => result),
    } as any;

    storageStrategy = {
      getStorageIdentifier: jest.fn().mockResolvedValue(storage),
    };

    sender = {
      handleSafe: jest.fn().mockResolvedValue(undefined),
    } as any;

    args = { source, storageStrategy, sender };
    handler = new AccessDocumentOperationHandler(args);
  });

  it('uses the source handler to determine if it can handle the input.', async(): Promise<void> => {
    await expect(handler.canHandle({ operation })).resolves.toBeUndefined();
    expect(source.canHandle).toHaveBeenLastCalledWith({ operation });

    source.canHandle.mockRejectedValueOnce(new NotImplementedHttpError());
    await expect(handler.canHandle({ operation })).rejects.toThrow(NotImplementedHttpError);
  });

  it('passes requests to other resources to the source handler.', async(): Promise<void> => {
    for (const target of [ `${storage.path}foo`, `${storage.path}.lws/`, `${grants}nested/`, `${grants}nested/doc` ]) {
      post(target, 'text', 'text/plain');
      operation.method = 'PUT';
      await expect(handler.handle({ operation })).resolves.toBe(result);
      expect(source.handle).toHaveBeenLastCalledWith({ operation });
    }
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('passes requests to the source handler if the storage can not be determined.', async(): Promise<void> => {
    storageStrategy.getStorageIdentifier.mockRejectedValueOnce(new NotFoundHttpError());
    operation.method = 'PUT';
    await expect(handler.handle({ operation })).resolves.toBe(result);
    expect(source.handle).toHaveBeenLastCalledWith({ operation });
  });

  it('only allows GET, HEAD, and POST on the access containers.', async(): Promise<void> => {
    for (const target of [ grants, requests ]) {
      for (const method of [ 'PUT', 'PATCH', 'DELETE' ]) {
        post(target, '');
        operation.method = method;
        await expect(handler.handle({ operation })).rejects.toThrow(MethodNotAllowedHttpError);
      }
      for (const method of [ 'GET', 'HEAD' ]) {
        post(target, '');
        operation.method = method;
        await expect(handler.handle({ operation })).resolves.toBe(result);
      }
    }
    post(requests, '');
    operation.method = 'PUT';
    await expect(handler.handle({ operation })).rejects.toThrow('PUT is not allowed on AccessRequest resources.');
    expect(source.handle).toHaveBeenCalledTimes(4);
  });

  it('only allows GET, HEAD, and DELETE on the members of the access containers.', async(): Promise<void> => {
    for (const target of [ `${grants}doc`, `${requests}doc` ]) {
      for (const method of [ 'PUT', 'PATCH', 'POST' ]) {
        post(target, '');
        operation.method = method;
        await expect(handler.handle({ operation })).rejects.toThrow(MethodNotAllowedHttpError);
      }
      for (const method of [ 'GET', 'HEAD', 'DELETE' ]) {
        post(target, '');
        operation.method = method;
        await expect(handler.handle({ operation })).resolves.toBe(result);
      }
    }
    post(`${grants}doc`, '');
    operation.method = 'PATCH';
    await expect(handler.handle({ operation })).rejects.toThrow('PATCH is not allowed on AccessGrant resources.');
    expect(source.handle).toHaveBeenCalledTimes(6);
  });

  it('rejects bodies that are not JSON.', async(): Promise<void> => {
    post(grants, JSON.stringify(document), 'text/turtle');
    await expect(handler.handle({ operation })).rejects.toThrow(UnsupportedMediaTypeHttpError);
    await expect(handler.handle({ operation })).rejects
      .toThrow('AccessGrant resources need to be application/lws+json.');

    post(grants, JSON.stringify(document));
    await expect(handler.handle({ operation })).rejects.toThrow(UnsupportedMediaTypeHttpError);
    expect(source.handle).toHaveBeenCalledTimes(0);
  });

  it('accepts all JSON media types.', async(): Promise<void> => {
    for (const contentType of [ 'application/lws+json', 'application/json', 'application/ld+json' ]) {
      post(grants, JSON.stringify(document), contentType);
      await expect(handler.handle({ operation })).resolves.toBe(result);
    }
    expect(source.handle).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid JSON.', async(): Promise<void> => {
    post(grants, '{ invalid', 'application/lws+json');
    await expect(handler.handle({ operation })).rejects.toThrow(BadRequestHttpError);
    post(grants, '{ invalid', 'application/lws+json');
    await expect(handler.handle({ operation })).rejects.toThrow('Invalid JSON.');
    expect(source.handle).toHaveBeenCalledTimes(0);
  });

  it('rejects invalid access documents.', async(): Promise<void> => {
    // An access request posted to the grant container
    post(grants, JSON.stringify(createDocument('AccessRequest')), 'application/lws+json');
    await expect(handler.handle({ operation })).rejects.toThrow(BadRequestHttpError);
    post(grants, JSON.stringify(createDocument('AccessRequest')), 'application/lws+json');
    await expect(handler.handle({ operation })).rejects.toThrow('Invalid access document');
    expect(source.handle).toHaveBeenCalledTimes(0);
  });

  it('rejects access documents targeting the reserved container.', async(): Promise<void> => {
    document.access[0].target.value.push(`${grants}other`);
    post(grants, JSON.stringify(document), 'application/lws+json');
    await expect(handler.handle({ operation })).rejects.toThrow(BadRequestHttpError);
    post(grants, JSON.stringify(document), 'application/lws+json');
    await expect(handler.handle({ operation })).rejects.toThrow(`Access can not be granted to ${grants}other.`);
    expect(source.handle).toHaveBeenCalledTimes(0);
  });

  it('replaces the body so the source handler can still read it.', async(): Promise<void> => {
    const body = JSON.stringify(document);
    const { metadata } = operation.body;
    await expect(handler.handle({ operation })).resolves.toBe(result);
    expect(source.handle).toHaveBeenCalledTimes(1);
    const input = source.handle.mock.calls[0][0];
    expect(input.operation.body.metadata).toBe(metadata);
    expect(input.operation.body.metadata.contentType).toBe('application/lws+json');
    await expect(readableToString(input.operation.body.data)).resolves.toBe(body);
  });

  it('accepts access requests.', async(): Promise<void> => {
    post(requests, JSON.stringify(createDocument('AccessRequest')), 'application/lws+json');
    await expect(handler.handle({ operation })).resolves.toBe(result);
    expect(source.handle).toHaveBeenCalledTimes(1);
    // Notifications are only sent for access grants
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('notifies the inbox after an access grant is created.', async(): Promise<void> => {
    await expect(handler.handle({ operation })).resolves.toBe(result);
    expect(sender.handleSafe).toHaveBeenCalledTimes(1);
    expect(sender.handleSafe).toHaveBeenLastCalledWith({
      inbox,
      storage: storage.path,
      activity: {
        id: expect.stringMatching(/^urn:uuid:/u),
        type: [ 'Create' ],
        object: { id: location, type: [ 'AccessGrant' ]},
        target: grants,
        published: expect.any(String),
      },
    });
  });

  it('only logs errors when sending the notification.', async(): Promise<void> => {
    sender.handleSafe.mockRejectedValueOnce(new Error('unreachable'));
    await expect(handler.handle({ operation })).resolves.toBe(result);
    await flushPromises();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      `Unable to notify ${inbox} of access grant ${location}: unreachable`,
    );
  });

  it('sends no notification if the grant has no inbox.', async(): Promise<void> => {
    delete document.inbox;
    post(grants, JSON.stringify(document), 'application/lws+json');
    await expect(handler.handle({ operation })).resolves.toBe(result);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('sends no notification if there is no location.', async(): Promise<void> => {
    result = { statusCode: 201 };
    await expect(handler.handle({ operation })).resolves.toBe(result);

    result = { statusCode: 201, metadata: new RepresentationMetadata() };
    post(grants, JSON.stringify(document), 'application/lws+json');
    await expect(handler.handle({ operation })).resolves.toBe(result);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('sends no notification if there is no sender.', async(): Promise<void> => {
    handler = new AccessDocumentOperationHandler({ source, storageStrategy });
    await expect(handler.handle({ operation })).resolves.toBe(result);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('supports custom paths.', async(): Promise<void> => {
    handler = new AccessDocumentOperationHandler({
      ...args,
      grantPath: 'access/grants/',
      requestPath: 'access/requests/',
      reservedPath: 'access/',
    });
    post(grants, JSON.stringify(document), 'text/plain');
    operation.method = 'PUT';
    await expect(handler.handle({ operation })).resolves.toBe(result);

    document.access[0].target.value = [ `${storage.path}access/other` ];
    post(`${storage.path}access/grants/`, JSON.stringify(document), 'application/lws+json');
    await expect(handler.handle({ operation })).rejects
      .toThrow(`Access can not be granted to ${storage.path}access/other.`);

    post(`${storage.path}access/requests/doc`, '');
    operation.method = 'PUT';
    await expect(handler.handle({ operation })).rejects.toThrow(MethodNotAllowedHttpError);
  });
});
