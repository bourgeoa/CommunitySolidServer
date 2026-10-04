import type { KeyValueStorage } from '../../../../../src/storage/keyvalue/KeyValueStorage';
import type { LwsSubscription } from '../../../../../src/server/notifications/lws/LwsSubscriptionStorage';
import { LwsSubscriptionStorage } from '../../../../../src/server/notifications/lws/LwsSubscriptionStorage';
import { MemoryMapStorage } from '../../../../../src/storage/keyvalue/MemoryMapStorage';

describe('A LwsSubscriptionStorage', (): void => {
  const endpoint = 'http://example.com/.notifications/lws/';
  let subscription: LwsSubscription;
  let source: KeyValueStorage<string, LwsSubscription>;
  let storage: LwsSubscriptionStorage;

  beforeEach(async(): Promise<void> => {
    subscription = {
      id: `${endpoint}abc`,
      type: 'WebhookSubscription',
      topic: [ 'http://example.com/foo' ],
      inbox: 'https://example.org/inbox',
    };
    source = new MemoryMapStorage();
    storage = new LwsSubscriptionStorage(source);
  });

  it('stores subscriptions using the last path segment as key.', async(): Promise<void> => {
    await expect(storage.add(subscription)).resolves.toBeUndefined();
    await expect(source.get('abc')).resolves.toEqual(subscription);
    await expect(storage.getAll()).resolves.toEqual([ subscription ]);
    await expect(storage.get(subscription.id)).resolves.toEqual(subscription);
    await expect(storage.get(`${endpoint}other`)).resolves.toBeUndefined();
  });

  it('encodes the key.', async(): Promise<void> => {
    subscription.id = `${endpoint}a b`;
    await storage.add(subscription);
    await expect(source.get('a%20b')).resolves.toEqual(subscription);
  });

  it('loads the existing subscriptions from the source storage once.', async(): Promise<void> => {
    await source.set('abc', subscription);
    const entriesSpy = jest.spyOn(source, 'entries');
    await expect(storage.getAll()).resolves.toEqual([ subscription ]);
    await expect(storage.get(subscription.id)).resolves.toEqual(subscription);
    expect(entriesSpy).toHaveBeenCalledTimes(1);
  });

  it('removes subscriptions.', async(): Promise<void> => {
    await storage.add(subscription);
    await expect(storage.delete(subscription.id)).resolves.toBe(true);
    await expect(storage.getAll()).resolves.toEqual([]);
    await expect(source.get('abc')).resolves.toBeUndefined();
    await expect(storage.delete(subscription.id)).resolves.toBe(false);
  });

  it('removes expired subscriptions.', async(): Promise<void> => {
    const expired = { ...subscription, id: `${endpoint}expired`, expires: new Date(Date.now() - 1000).toISOString() };
    const valid = { ...subscription, expires: new Date(Date.now() + 100000).toISOString() };
    await storage.add(expired);
    await storage.add(valid);
    await expect(storage.getAll()).resolves.toEqual([ valid ]);
    await expect(source.get('expired')).resolves.toBeUndefined();
    await expect(storage.get(expired.id)).resolves.toBeUndefined();
  });

  it('does not cache failures to load the subscriptions.', async(): Promise<void> => {
    await source.set('abc', subscription);
    jest.spyOn(source, 'entries').mockImplementationOnce((): any => {
      throw new Error('bad data');
    });
    await expect(storage.getAll()).rejects.toThrow('bad data');
    await expect(storage.getAll()).resolves.toEqual([ subscription ]);
  });
});
