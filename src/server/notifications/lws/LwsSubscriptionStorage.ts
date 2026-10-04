import type { KeyValueStorage } from '../../../storage/keyvalue/KeyValueStorage';

/**
 * An LWS webhook subscription.
 */
export interface LwsSubscription {
  /**
   * The URL of the subscription.
   */
  id: string;
  /**
   * The subscription type.
   */
  type: string;
  /**
   * The resources the subscription is about.
   */
  topic: string[];
  /**
   * The URL the notifications are sent to.
   */
  inbox: string;
  /**
   * When the subscription expires, as an ISO date string.
   */
  expires?: string;
  /**
   * The WebID of the subscriber, if the subscriber was authenticated.
   */
  webId?: string;
  /**
   * The client identifier of the subscriber, if known.
   */
  clientId?: string;
}

/**
 * Stores LWS subscriptions in a {@link KeyValueStorage}, using the last path segment of the subscription URL as key.
 * All subscriptions are also kept in memory, as they need to be checked on every resource change.
 * Therefore, this class should not be used on a server with multiple worker threads.
 */
export class LwsSubscriptionStorage {
  private readonly storage: KeyValueStorage<string, LwsSubscription>;
  private cache?: Promise<Map<string, LwsSubscription>>;

  public constructor(storage: KeyValueStorage<string, LwsSubscription>) {
    this.storage = storage;
  }

  /**
   * Returns all subscriptions that have not expired yet. Expired subscriptions are removed.
   */
  public async getAll(): Promise<LwsSubscription[]> {
    const subscriptions = await this.getCache();
    const now = Date.now();
    const result: LwsSubscription[] = [];
    for (const subscription of subscriptions.values()) {
      if (subscription.expires && Date.parse(subscription.expires) <= now) {
        await this.delete(subscription.id);
      } else {
        result.push(subscription);
      }
    }
    return result;
  }

  /**
   * Returns the subscription with the given URL, if it exists and has not expired.
   */
  public async get(id: string): Promise<LwsSubscription | undefined> {
    return (await this.getAll()).find((subscription): boolean => subscription.id === id);
  }

  /**
   * Stores the given subscription.
   */
  public async add(subscription: LwsSubscription): Promise<void> {
    const subscriptions = await this.getCache();
    await this.storage.set(this.getKey(subscription.id), subscription);
    subscriptions.set(subscription.id, subscription);
  }

  /**
   * Removes the subscription with the given URL. Returns whether it existed.
   */
  public async delete(id: string): Promise<boolean> {
    const subscriptions = await this.getCache();
    subscriptions.delete(id);
    return this.storage.delete(this.getKey(id));
  }

  private getKey(id: string): string {
    return encodeURIComponent(id.slice(id.lastIndexOf('/') + 1));
  }

  private async getCache(): Promise<Map<string, LwsSubscription>> {
    if (!this.cache) {
      this.cache = this.load();
      // Do not cache failures
      this.cache.catch((): void => {
        this.cache = undefined;
      });
    }
    return this.cache;
  }

  private async load(): Promise<Map<string, LwsSubscription>> {
    const subscriptions = new Map<string, LwsSubscription>();
    for await (const [ , subscription ] of this.storage.entries()) {
      subscriptions.set(subscription.id, subscription);
    }
    return subscriptions;
  }
}
