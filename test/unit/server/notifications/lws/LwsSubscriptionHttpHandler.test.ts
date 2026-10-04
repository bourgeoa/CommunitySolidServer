import 'jest-rdf';
import type { Credentials } from '../../../../../src/authentication/Credentials';
import type { CredentialsExtractor } from '../../../../../src/authentication/CredentialsExtractor';
import type { PermissionReader } from '../../../../../src/authorization/PermissionReader';
import { AccessMode } from '../../../../../src/authorization/permissions/Permissions';
import type { Operation } from '../../../../../src/http/Operation';
import { BasicRepresentation } from '../../../../../src/http/representation/BasicRepresentation';
import type { HttpRequest } from '../../../../../src/server/HttpRequest';
import type { HttpResponse } from '../../../../../src/server/HttpResponse';
import {
  LwsSubscriptionHttpHandler,
  WEBHOOK_SUBSCRIPTION,
} from '../../../../../src/server/notifications/lws/LwsSubscriptionHttpHandler';
import type {
  LwsSubscription,
  LwsSubscriptionStorage,
} from '../../../../../src/server/notifications/lws/LwsSubscriptionStorage';
import { BadRequestHttpError } from '../../../../../src/util/errors/BadRequestHttpError';
import { ForbiddenHttpError } from '../../../../../src/util/errors/ForbiddenHttpError';
import { MethodNotAllowedHttpError } from '../../../../../src/util/errors/MethodNotAllowedHttpError';
import { NotFoundHttpError } from '../../../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../../../src/util/errors/NotImplementedHttpError';
import { UnauthorizedHttpError } from '../../../../../src/util/errors/UnauthorizedHttpError';
import { UnsupportedMediaTypeHttpError } from '../../../../../src/util/errors/UnsupportedMediaTypeHttpError';
import { IdentifierMap } from '../../../../../src/util/map/IdentifierMap';
import { readableToString } from '../../../../../src/util/StreamUtil';
import { LWS, RDF, SOLID_HTTP } from '../../../../../src/util/Vocabularies';

describe('A LwsSubscriptionHttpHandler', (): void => {
  const baseUrl = 'http://example.com/';
  const endpoint = 'http://example.com/.notifications/lws/';
  const webId = 'http://example.com/alice/profile/card#me';
  const topic = 'http://example.com/alice/foo';
  const inbox = 'https://example.org/inbox';
  const request: HttpRequest = {} as any;
  const response: HttpResponse = {} as any;
  let credentials: Credentials;
  let operation: Operation;
  let subscription: LwsSubscription;
  let credentialsExtractor: jest.Mocked<CredentialsExtractor>;
  let permissionReader: jest.Mocked<PermissionReader>;
  let storage: jest.Mocked<LwsSubscriptionStorage>;
  let handler: LwsSubscriptionHttpHandler;

  function setBody(body: unknown, contentType = 'application/lws+json'): void {
    operation.body = new BasicRepresentation(typeof body === 'string' ? body : JSON.stringify(body), contentType);
  }

  beforeEach(async(): Promise<void> => {
    credentials = { agent: { webId }, client: { clientId: 'http://client.example/id' }};
    operation = {
      method: 'POST',
      target: { path: endpoint },
      body: new BasicRepresentation(),
      preferences: {},
    };
    setBody({ type: WEBHOOK_SUBSCRIPTION, topic: [ topic ], inbox });

    subscription = {
      id: `${endpoint}abc`,
      type: WEBHOOK_SUBSCRIPTION,
      topic: [ topic ],
      inbox,
      webId,
    };

    credentialsExtractor = {
      handleSafe: jest.fn(async(): Promise<Credentials> => credentials),
    } as any;
    permissionReader = {
      handleSafe: jest.fn(async({ requestedModes }): Promise<any> => new IdentifierMap(
        [ ...requestedModes.distinctKeys() ].map((id): any => [ id, { read: true }]),
      )),
    } as any;
    storage = {
      getAll: jest.fn().mockResolvedValue([ subscription ]),
      get: jest.fn().mockResolvedValue(subscription),
      add: jest.fn(),
      delete: jest.fn().mockResolvedValue(true),
    } as any;

    handler = new LwsSubscriptionHttpHandler({ baseUrl, credentialsExtractor, permissionReader, storage });
  });

  describe('canHandle', (): void => {
    it('accepts requests targeting the endpoint or its subscriptions.', async(): Promise<void> => {
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
      operation.target = { path: `${endpoint}abc` };
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    });

    it('rejects other targets.', async(): Promise<void> => {
      operation.target = { path: 'http://example.com/foo' };
      await expect(handler.canHandle({ request, response, operation })).rejects.toThrow(NotImplementedHttpError);
    });

    it('supports a custom path.', async(): Promise<void> => {
      handler = new LwsSubscriptionHttpHandler(
        { baseUrl, path: 'subs/', credentialsExtractor, permissionReader, storage },
      );
      await expect(handler.canHandle({ request, response, operation })).rejects.toThrow(NotImplementedHttpError);
      operation.target = { path: 'http://example.com/subs/' };
      await expect(handler.canHandle({ request, response, operation })).resolves.toBeUndefined();
    });
  });

  describe('creating subscriptions', (): void => {
    it('creates a subscription.', async(): Promise<void> => {
      const result = await handler.handle({ request, response, operation });
      expect(result.statusCode).toBe(201);
      expect(storage.add).toHaveBeenCalledTimes(1);
      const created = storage.add.mock.calls[0][0];
      expect(created).toEqual({
        id: expect.stringMatching(/^http:\/\/example\.com\/\.notifications\/lws\/[0-9a-f-]{36}$/u),
        type: WEBHOOK_SUBSCRIPTION,
        topic: [ topic ],
        inbox,
        webId,
        clientId: 'http://client.example/id',
      });
      expect(result.metadata?.get(SOLID_HTTP.terms.location)?.value).toBe(created.id);
      expect(result.metadata?.contentType).toBe('application/lws+json');
      expect(JSON.parse(await readableToString(result.data!))).toEqual({
        '@context': [ 'https://www.w3.org/ns/lws/v1' ],
        type: WEBHOOK_SUBSCRIPTION,
        subscription: created.id,
        topic: [ topic ],
        inbox,
      });

      expect(permissionReader.handleSafe).toHaveBeenCalledTimes(1);
      const { requestedModes, credentials: usedCredentials } = permissionReader.handleSafe.mock.calls[0][0];
      expect(usedCredentials).toBe(credentials);
      expect([ ...requestedModes.get({ path: topic })! ]).toEqual([ AccessMode.read ]);
    });

    it('creates a subscription for an anonymous subscriber with an expiration.', async(): Promise<void> => {
      credentials = {};
      const expires = '2030-01-01T00:00:00Z';
      setBody({ type: WEBHOOK_SUBSCRIPTION, topic: [ topic ], inbox, expires }, 'application/json');
      const result = await handler.handle({ request, response, operation });
      expect(result.statusCode).toBe(201);
      const created = storage.add.mock.calls[0][0];
      expect(created.webId).toBeUndefined();
      expect(created.clientId).toBeUndefined();
      expect(created.expires).toBe('2030-01-01T00:00:00.000Z');
      expect(JSON.parse(await readableToString(result.data!)).expires).toBe('2030-01-01T00:00:00.000Z');
    });

    it('accepts JSON-LD.', async(): Promise<void> => {
      setBody({ type: WEBHOOK_SUBSCRIPTION, topic: [ topic ], inbox: 'http://example.org/inbox' }, 'application/ld+json');
      await expect(handler.handle({ request, response, operation })).resolves.toMatchObject({ statusCode: 201 });
    });

    it('rejects unsupported content types.', async(): Promise<void> => {
      setBody({}, 'text/turtle');
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(UnsupportedMediaTypeHttpError);
      setBody({});
      operation.body.metadata.contentType = undefined;
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(UnsupportedMediaTypeHttpError);
    });

    it('rejects invalid JSON.', async(): Promise<void> => {
      setBody('{ invalid');
      await expect(handler.handle({ request, response, operation })).rejects.toThrow('Invalid JSON.');
    });

    it('rejects JSON that is not an object.', async(): Promise<void> => {
      setBody([ 'a' ]);
      await expect(handler.handle({ request, response, operation }))
        .rejects.toThrow('A subscription request needs to be a JSON object.');
    });

    it('rejects requests without a valid type.', async(): Promise<void> => {
      setBody({ topic: [ topic ], inbox });
      await expect(handler.handle({ request, response, operation }))
        .rejects.toThrow('A subscription request needs a type.');
      setBody({ type: 'StreamingSubscription', topic: [ topic ], inbox });
      await expect(handler.handle({ request, response, operation }))
        .rejects.toThrow('Unsupported subscription type StreamingSubscription.');
    });

    it('rejects requests without valid topics.', async(): Promise<void> => {
      for (const invalid of [ undefined, topic, [], [ topic, 'relative' ]]) {
        setBody({ type: WEBHOOK_SUBSCRIPTION, topic: invalid, inbox });
        await expect(handler.handle({ request, response, operation }))
          .rejects.toThrow('A subscription request needs an array of topic URIs.');
      }
    });

    it('rejects requests without a valid inbox.', async(): Promise<void> => {
      for (const invalid of [ undefined, 'relative', 'mailto:alice@example.com' ]) {
        setBody({ type: WEBHOOK_SUBSCRIPTION, topic: [ topic ], inbox: invalid });
        await expect(handler.handle({ request, response, operation }))
          .rejects.toThrow('A webhook subscription needs an HTTP(S) inbox URL.');
      }
    });

    it('rejects requests with an invalid expiration.', async(): Promise<void> => {
      for (const invalid of [ 5, 'not a date' ]) {
        setBody({ type: WEBHOOK_SUBSCRIPTION, topic: [ topic ], inbox, expires: invalid });
        const result = handler.handle({ request, response, operation });
        await expect(result).rejects.toThrow(BadRequestHttpError);
        await expect(result).rejects.toThrow('expires needs to be a dateTime.');
      }
    });

    it('rejects requests with an expiration in the past.', async(): Promise<void> => {
      setBody({ type: WEBHOOK_SUBSCRIPTION, topic: [ topic ], inbox, expires: '2000-01-01T00:00:00Z' });
      const result = handler.handle({ request, response, operation });
      await expect(result).rejects.toThrow('expires needs to be in the future.');
    });

    it('throws a 403 if an authenticated subscriber can not read a topic.', async(): Promise<void> => {
      permissionReader.handleSafe.mockResolvedValueOnce(new IdentifierMap([[{ path: topic }, { read: false }]]));
      const result = handler.handle({ request, response, operation });
      await expect(result).rejects.toThrow(ForbiddenHttpError);
      await expect(result).rejects.toThrow(`No read access to ${topic}.`);
      expect(storage.add).toHaveBeenCalledTimes(0);
    });

    it('throws a 401 if an anonymous subscriber can not read a topic.', async(): Promise<void> => {
      credentials = {};
      permissionReader.handleSafe.mockResolvedValueOnce(new IdentifierMap());
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(UnauthorizedHttpError);
      expect(storage.add).toHaveBeenCalledTimes(0);
    });
  });

  describe('listing subscriptions', (): void => {
    beforeEach(async(): Promise<void> => {
      operation.method = 'GET';
      storage.getAll.mockResolvedValue([
        subscription,
        { ...subscription, id: `${endpoint}other`, webId: 'http://example.com/bob/profile/card#me' },
        { ...subscription, id: `${endpoint}anonymous`, webId: undefined },
      ]);
    });

    it('returns the subscriptions of the agent.', async(): Promise<void> => {
      const result = await handler.handle({ request, response, operation });
      expect(result.statusCode).toBe(200);
      expect(result.metadata?.contentType).toBe('application/lws+json');
      expect(result.metadata?.getAll(RDF.terms.type)).toEqualRdfTermArray([ LWS.terms.Container ]);
      expect(JSON.parse(await readableToString(result.data!))).toEqual({
        '@context': [ 'https://www.w3.org/ns/lws/v1' ],
        id: endpoint,
        type: 'Container',
        totalItems: 1,
        items: [{ id: subscription.id, type: [ 'DataResource' ]}],
      });
    });

    it('supports HEAD requests.', async(): Promise<void> => {
      operation.method = 'HEAD';
      const result = await handler.handle({ request, response, operation });
      expect(result.statusCode).toBe(200);
      expect(result.data).toBeUndefined();
      expect(result.metadata?.contentType).toBe('application/lws+json');
      expect(result.metadata?.getAll(RDF.terms.type)).toEqualRdfTermArray([ LWS.terms.Container ]);
    });

    it('requires authentication.', async(): Promise<void> => {
      credentials = {};
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(UnauthorizedHttpError);
    });

    it('rejects other methods on the endpoint.', async(): Promise<void> => {
      operation.method = 'PUT';
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(MethodNotAllowedHttpError);
    });
  });

  describe('accessing a subscription', (): void => {
    beforeEach(async(): Promise<void> => {
      operation.method = 'GET';
      operation.target = { path: subscription.id };
    });

    it('returns the subscription.', async(): Promise<void> => {
      subscription.expires = '2030-01-01T00:00:00.000Z';
      const result = await handler.handle({ request, response, operation });
      expect(storage.get).toHaveBeenLastCalledWith(subscription.id);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(await readableToString(result.data!))).toEqual({
        '@context': [ 'https://www.w3.org/ns/lws/v1' ],
        type: WEBHOOK_SUBSCRIPTION,
        subscription: subscription.id,
        topic: [ topic ],
        inbox,
        expires: '2030-01-01T00:00:00.000Z',
      });
    });

    it('supports HEAD requests.', async(): Promise<void> => {
      operation.method = 'HEAD';
      const result = await handler.handle({ request, response, operation });
      expect(result.statusCode).toBe(200);
      expect(result.data).toBeUndefined();
    });

    it('allows anyone to access subscriptions of anonymous subscribers.', async(): Promise<void> => {
      delete subscription.webId;
      credentials = {};
      await expect(handler.handle({ request, response, operation })).resolves.toMatchObject({ statusCode: 200 });
    });

    it('throws a 404 if the subscription does not exist.', async(): Promise<void> => {
      storage.get.mockResolvedValueOnce(undefined);
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(NotFoundHttpError);
    });

    it('throws a 404 if the subscription belongs to a different agent.', async(): Promise<void> => {
      credentials = { agent: { webId: 'http://example.com/bob/profile/card#me' }};
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(NotFoundHttpError);
      credentials = {};
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(NotFoundHttpError);
    });

    it('deletes the subscription.', async(): Promise<void> => {
      operation.method = 'DELETE';
      const result = await handler.handle({ request, response, operation });
      expect(result.statusCode).toBe(204);
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenLastCalledWith(subscription.id);
    });

    it('rejects other methods.', async(): Promise<void> => {
      operation.method = 'POST';
      await expect(handler.handle({ request, response, operation })).rejects.toThrow(MethodNotAllowedHttpError);
    });
  });
});
