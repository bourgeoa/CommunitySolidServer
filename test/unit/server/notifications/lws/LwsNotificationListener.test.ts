import { EventEmitter } from 'node:events';
import type { PermissionReader } from '../../../../../src/authorization/PermissionReader';
import { AccessMode } from '../../../../../src/authorization/permissions/Permissions';
import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../../../../src/http/representation/ResourceIdentifier';
import type { Logger } from '../../../../../src/logging/Logger';
import { getLoggerFor } from '../../../../../src/logging/LogUtil';
import type { StorageLocationStrategy } from '../../../../../src/server/description/StorageLocationStrategy';
import type { ActivityEmitter } from '../../../../../src/server/notifications/ActivityEmitter';
import { LwsNotificationListener } from '../../../../../src/server/notifications/lws/LwsNotificationListener';
import type { LwsNotificationSender } from '../../../../../src/server/notifications/lws/LwsNotificationSender';
import { LwsDeliveryError } from '../../../../../src/server/notifications/lws/LwsNotificationSender';
import type {
  LwsSubscription,
  LwsSubscriptionStorage,
} from '../../../../../src/server/notifications/lws/LwsSubscriptionStorage';
import { SingleRootIdentifierStrategy } from '../../../../../src/util/identifiers/SingleRootIdentifierStrategy';
import { IdentifierMap } from '../../../../../src/util/map/IdentifierMap';
import { AS } from '../../../../../src/util/Vocabularies';
import type { VocabularyTerm } from '../../../../../src/util/Vocabularies';
import { flushPromises } from '../../../../util/Util';

jest.mock('../../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('A LwsNotificationListener', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor('mock') as any;
  const storageId = { path: 'http://example.com/alice/' };
  const container = { path: 'http://example.com/alice/foo/' };
  const resource = { path: 'http://example.com/alice/foo/bar' };
  const webId = 'http://example.com/alice/profile/card#me';
  let subscription: LwsSubscription;
  let emitter: ActivityEmitter;
  let storage: jest.Mocked<LwsSubscriptionStorage>;
  let permissionReader: jest.Mocked<PermissionReader>;
  let storageStrategy: jest.Mocked<StorageLocationStrategy>;
  let sender: jest.Mocked<LwsNotificationSender>;

  async function emit(topic: ResourceIdentifier, activity: VocabularyTerm<typeof AS>): Promise<void> {
    emitter.emit('changed', topic, activity, new RepresentationMetadata());
    await flushPromises();
  }

  function createListener(maxFailures?: number): LwsNotificationListener {
    return new LwsNotificationListener({
      emitter,
      storage,
      permissionReader,
      storageStrategy,
      identifierStrategy: new SingleRootIdentifierStrategy('http://example.com/'),
      sender,
      maxFailures,
    });
  }

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();

    subscription = {
      id: 'http://example.com/.notifications/lws/abc',
      type: 'WebhookSubscription',
      topic: [ container.path ],
      inbox: 'https://example.org/inbox',
      webId,
      clientId: 'http://client.example/id',
    };

    emitter = new EventEmitter() as any;

    storage = {
      getAll: jest.fn(async(): Promise<LwsSubscription[]> => [ subscription ]),
      delete: jest.fn().mockResolvedValue(true),
    } as any;

    permissionReader = {
      handleSafe: jest.fn(async({ requestedModes }): Promise<any> => new IdentifierMap(
        [ ...requestedModes.distinctKeys() ].map((id): any => [ id, { read: true }]),
      )),
    } as any;

    storageStrategy = {
      getStorageIdentifier: jest.fn().mockResolvedValue(storageId),
    };

    sender = {
      handleSafe: jest.fn().mockResolvedValue(undefined),
    } as any;

    createListener();
  });

  it('sends a Create notification with a target.', async(): Promise<void> => {
    await emit(resource, AS.terms.Create);
    expect(storageStrategy.getStorageIdentifier).toHaveBeenLastCalledWith(resource);
    expect(sender.handleSafe).toHaveBeenCalledTimes(1);
    expect(sender.handleSafe).toHaveBeenLastCalledWith({
      inbox: subscription.inbox,
      storage: storageId.path,
      activity: {
        id: expect.stringMatching(/^urn:uuid:/u),
        type: [ 'Create' ],
        object: { id: resource.path, type: [ 'DataResource' ]},
        target: container.path,
        published: expect.any(String),
      },
    });
    expect(logger.error).toHaveBeenCalledTimes(0);
  });

  it('sends an Update notification without target or origin.', async(): Promise<void> => {
    await emit(resource, AS.terms.Update);
    expect(sender.handleSafe).toHaveBeenCalledTimes(1);
    const { activity } = sender.handleSafe.mock.calls[0][0];
    expect(activity.type).toEqual([ 'Update' ]);
    expect(activity.target).toBeUndefined();
    expect(activity.origin).toBeUndefined();
  });

  it('sends a Delete notification with an origin.', async(): Promise<void> => {
    await emit(resource, AS.terms.Delete);
    expect(sender.handleSafe).toHaveBeenCalledTimes(1);
    const { activity } = sender.handleSafe.mock.calls[0][0];
    expect(activity.type).toEqual([ 'Delete' ]);
    expect(activity.origin).toBe(container.path);
    expect(activity.target).toBeUndefined();
  });

  it('ignores Add and Remove activities.', async(): Promise<void> => {
    await emit(container, AS.terms.Add);
    await emit(container, AS.terms.Remove);
    expect(storage.getAll).toHaveBeenCalledTimes(0);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('marks containers as such.', async(): Promise<void> => {
    await emit(container, AS.terms.Create);
    const { activity } = sender.handleSafe.mock.calls[0][0];
    expect(activity.object).toEqual({ id: container.path, type: [ 'Container' ]});
    expect(activity.target).toBe(storageId.path);
  });

  it('does not add a target or origin for the root container.', async(): Promise<void> => {
    const root = { path: 'http://example.com/' };
    subscription.topic = [ root.path ];
    await emit(root, AS.terms.Create);
    await emit(root, AS.terms.Delete);
    expect(sender.handleSafe).toHaveBeenCalledTimes(2);
    for (const [{ activity }] of sender.handleSafe.mock.calls) {
      expect(activity.target).toBeUndefined();
      expect(activity.origin).toBeUndefined();
    }
  });

  it('matches container topics recursively.', async(): Promise<void> => {
    subscription.topic = [ storageId.path ];
    await emit(resource, AS.terms.Update);
    expect(sender.handleSafe).toHaveBeenCalledTimes(1);
  });

  it('only matches data resource topics exactly.', async(): Promise<void> => {
    subscription.topic = [ 'http://example.com/alice/foo/ba' ];
    await emit(resource, AS.terms.Update);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
    expect(storageStrategy.getStorageIdentifier).toHaveBeenCalledTimes(0);

    subscription.topic = [ 'http://example.com/other', resource.path ];
    await emit(resource, AS.terms.Update);
    expect(sender.handleSafe).toHaveBeenCalledTimes(1);
  });

  it('does not notify resources outside of a container topic.', async(): Promise<void> => {
    subscription.topic = [ 'http://example.com/bob/' ];
    await emit(resource, AS.terms.Update);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('checks the read permissions of the subscriber at delivery time.', async(): Promise<void> => {
    await emit(resource, AS.terms.Update);
    expect(permissionReader.handleSafe).toHaveBeenCalledTimes(1);
    const { credentials, requestedModes } = permissionReader.handleSafe.mock.calls[0][0];
    expect(credentials).toEqual({ agent: { webId }, client: { clientId: 'http://client.example/id' }});
    expect([ ...requestedModes.get(resource)! ]).toEqual([ AccessMode.read ]);
  });

  it('uses empty credentials for anonymous subscribers.', async(): Promise<void> => {
    delete subscription.webId;
    delete subscription.clientId;
    await emit(resource, AS.terms.Update);
    expect(permissionReader.handleSafe.mock.calls[0][0].credentials).toEqual({});
    expect(sender.handleSafe).toHaveBeenCalledTimes(1);
  });

  it('does not notify subscribers that can not read the resource.', async(): Promise<void> => {
    const other = { ...subscription, id: 'http://example.com/.notifications/lws/other', inbox: 'https://other/' };
    storage.getAll.mockResolvedValue([ subscription, other ]);
    permissionReader.handleSafe.mockResolvedValueOnce(new IdentifierMap([[ resource, { read: false }]]));
    permissionReader.handleSafe.mockResolvedValueOnce(new IdentifierMap());
    await emit(resource, AS.terms.Update);
    expect(permissionReader.handleSafe).toHaveBeenCalledTimes(2);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
    expect(logger.debug).toHaveBeenCalledWith(`Not notifying ${subscription.id} as it can not read ${resource.path}`);
    expect(logger.debug).toHaveBeenCalledWith(`Not notifying ${other.id} as it can not read ${resource.path}`);
  });

  it('does not notify if the permissions can not be determined.', async(): Promise<void> => {
    permissionReader.handleSafe.mockRejectedValueOnce(new Error('bad permissions'));
    await emit(resource, AS.terms.Update);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      `Unable to determine permissions on ${resource.path}: bad permissions`,
    );
  });

  it('deactivates a subscription after too many consecutive failures.', async(): Promise<void> => {
    sender.handleSafe.mockRejectedValue(new LwsDeliveryError('failed', 500));
    for (let i = 0; i < 4; ++i) {
      await emit(resource, AS.terms.Update);
    }
    expect(sender.handleSafe).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenLastCalledWith(`Unable to notify ${subscription.inbox}: failed`);
    expect(storage.delete).toHaveBeenCalledTimes(0);

    await emit(resource, AS.terms.Update);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenLastCalledWith(subscription.id);
    expect(logger.info).toHaveBeenLastCalledWith(
      `Deactivating LWS subscription ${subscription.id} after 5 failed deliveries`,
    );
  });

  it('resets the failure count after a successful delivery.', async(): Promise<void> => {
    emitter.removeAllListeners('changed');
    createListener(2);
    sender.handleSafe.mockRejectedValueOnce(new Error('failed'));
    await emit(resource, AS.terms.Update);
    await emit(resource, AS.terms.Update);
    sender.handleSafe.mockRejectedValueOnce(new Error('failed'));
    await emit(resource, AS.terms.Update);
    expect(storage.delete).toHaveBeenCalledTimes(0);

    sender.handleSafe.mockRejectedValueOnce(new Error('failed'));
    await emit(resource, AS.terms.Update);
    expect(storage.delete).toHaveBeenCalledTimes(1);

    // The count is reset after deactivation
    sender.handleSafe.mockRejectedValueOnce(new Error('failed'));
    await emit(resource, AS.terms.Update);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('immediately deactivates a subscription if the inbox is gone.', async(): Promise<void> => {
    sender.handleSafe.mockRejectedValueOnce(new LwsDeliveryError('gone', 410));
    await emit(resource, AS.terms.Update);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenLastCalledWith(subscription.id);
    expect(logger.info).toHaveBeenLastCalledWith(
      `Deactivating LWS subscription ${subscription.id} after 1 failed deliveries`,
    );
  });

  it('logs an error if a subscription can not be deactivated.', async(): Promise<void> => {
    sender.handleSafe.mockRejectedValueOnce(new LwsDeliveryError('gone', 410));
    storage.delete.mockRejectedValueOnce(new Error('bad storage'));
    await emit(resource, AS.terms.Update);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith('Unable to handle a failed LWS notification: bad storage');
  });

  it('logs an error if something goes wrong finding the subscriptions.', async(): Promise<void> => {
    storage.getAll.mockRejectedValueOnce(new Error('bad data'));
    await emit(resource, AS.terms.Update);
    expect(sender.handleSafe).toHaveBeenCalledTimes(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith('Something went wrong sending LWS notifications: bad data');
  });
});
