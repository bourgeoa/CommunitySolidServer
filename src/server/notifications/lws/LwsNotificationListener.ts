import type { Credentials } from '../../../authentication/Credentials';
import type { PermissionReader } from '../../../authorization/PermissionReader';
import { AccessMode } from '../../../authorization/permissions/Permissions';
import type { ResourceIdentifier } from '../../../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../../../logging/LogUtil';
import { createErrorMessage } from '../../../util/errors/ErrorUtil';
import { StaticHandler } from '../../../util/handlers/StaticHandler';
import type { IdentifierStrategy } from '../../../util/identifiers/IdentifierStrategy';
import { IdentifierSetMultiMap } from '../../../util/map/IdentifierMap';
import { isContainerPath } from '../../../util/PathUtil';
import { AS } from '../../../util/Vocabularies';
import type { VocabularyTerm } from '../../../util/Vocabularies';
import type { StorageLocationStrategy } from '../../description/StorageLocationStrategy';
import type { ActivityEmitter } from '../ActivityEmitter';
import type { LwsActivity, LwsNotificationSender } from './LwsNotificationSender';
import { createLwsActivity, LwsDeliveryError } from './LwsNotificationSender';
import type { LwsSubscription, LwsSubscriptionStorage } from './LwsSubscriptionStorage';

export interface LwsNotificationListenerArgs {
  /**
   * Emits the changes to resources.
   */
  emitter: ActivityEmitter;
  /**
   * Contains the subscriptions.
   */
  storage: LwsSubscriptionStorage;
  /**
   * Determines whether a subscriber can read the changed resource.
   */
  permissionReader: PermissionReader;
  /**
   * Determines the storage of the changed resource.
   */
  storageStrategy: StorageLocationStrategy;
  /**
   * Determines the parent container of the changed resource.
   */
  identifierStrategy: IdentifierStrategy;
  /**
   * Delivers the notifications.
   */
  sender: LwsNotificationSender;
  /**
   * After how many consecutive failed deliveries a subscription is removed. Defaults to 5.
   * Subscriptions are always removed immediately when the inbox answers with 410 Gone.
   */
  maxFailures?: number;
}

/**
 * Sends LWS notifications to the subscriptions that match a changed resource, as described in LWS, §Notifications.
 *
 * A subscription to a container matches all resources transitively contained in it.
 * Notifications are only sent if the subscriber can read the resource at the time the event occurs.
 *
 * Creates `Create`, `Update`, and `Delete` activities.
 * The actor is not included, so the notifications do not reveal who made the change.
 *
 * Subscriptions are deactivated after repeated failed deliveries, or when the inbox answers with 410 Gone.
 */
export class LwsNotificationListener extends StaticHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly storage: LwsSubscriptionStorage;
  private readonly permissionReader: PermissionReader;
  private readonly storageStrategy: StorageLocationStrategy;
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly sender: LwsNotificationSender;
  private readonly maxFailures: number;
  private readonly failures = new Map<string, number>();

  public constructor(args: LwsNotificationListenerArgs) {
    super();
    this.storage = args.storage;
    this.permissionReader = args.permissionReader;
    this.storageStrategy = args.storageStrategy;
    this.identifierStrategy = args.identifierStrategy;
    this.sender = args.sender;
    this.maxFailures = args.maxFailures ?? 5;

    args.emitter.on('changed', (topic, activity): void => {
      this.notify(topic, activity).catch((error: unknown): void => {
        this.logger.error(`Something went wrong sending LWS notifications: ${createErrorMessage(error)}`);
      });
    });
  }

  private async notify(resource: ResourceIdentifier, activity: VocabularyTerm<typeof AS>): Promise<void> {
    const type = this.getActivityType(activity);
    if (!type) {
      return;
    }
    const subscriptions = (await this.storage.getAll())
      .filter((subscription): boolean => this.matches(subscription, resource));
    if (subscriptions.length === 0) {
      return;
    }

    const storage = await this.storageStrategy.getStorageIdentifier(resource);
    const extra: Record<string, string> = {};
    if (!this.identifierStrategy.isRootContainer(resource)) {
      const parent = this.identifierStrategy.getParentContainer(resource).path;
      if (type === 'Create') {
        extra.target = parent;
      } else if (type === 'Delete') {
        extra.origin = parent;
      }
    }
    const objectType = isContainerPath(resource.path) ? 'Container' : 'DataResource';

    for (const subscription of subscriptions) {
      if (!await this.canRead(subscription, resource)) {
        this.logger.debug(`Not notifying ${subscription.id} as it can not read ${resource.path}`);
        continue;
      }
      const lwsActivity = createLwsActivity(type, resource.path, [ objectType ], extra);
      this.deliver(subscription, storage.path, lwsActivity).catch((error: unknown): void => {
        this.logger.error(`Unable to handle a failed LWS notification: ${createErrorMessage(error)}`);
      });
    }
  }

  /**
   * Sends the notification and deactivates the subscription after too many failures.
   */
  private async deliver(subscription: LwsSubscription, storage: string, activity: LwsActivity): Promise<void> {
    try {
      await this.sender.handleSafe({ inbox: subscription.inbox, storage, activity });
      this.failures.delete(subscription.id);
    } catch (error: unknown) {
      this.logger.warn(`Unable to notify ${subscription.inbox}: ${createErrorMessage(error)}`);
      const gone = error instanceof LwsDeliveryError && error.status === 410;
      const failures = (this.failures.get(subscription.id) ?? 0) + 1;
      if (gone || failures >= this.maxFailures) {
        this.logger.info(`Deactivating LWS subscription ${subscription.id} after ${failures} failed deliveries`);
        this.failures.delete(subscription.id);
        await this.storage.delete(subscription.id);
      } else {
        this.failures.set(subscription.id, failures);
      }
    }
  }

  private getActivityType(activity: VocabularyTerm<typeof AS>): string | undefined {
    if (activity.equals(AS.terms.Create)) {
      return 'Create';
    }
    if (activity.equals(AS.terms.Update)) {
      return 'Update';
    }
    if (activity.equals(AS.terms.Delete)) {
      return 'Delete';
    }
  }

  /**
   * Subscriptions to a container are recursive, subscriptions to a data resource only match that resource.
   */
  private matches(subscription: LwsSubscription, resource: ResourceIdentifier): boolean {
    return subscription.topic.some((topic): boolean =>
      topic === resource.path || (isContainerPath(topic) && resource.path.startsWith(topic)));
  }

  private async canRead(subscription: LwsSubscription, resource: ResourceIdentifier): Promise<boolean> {
    const credentials: Credentials = {};
    if (subscription.webId) {
      credentials.agent = { webId: subscription.webId };
    }
    if (subscription.clientId) {
      credentials.client = { clientId: subscription.clientId };
    }
    const requestedModes = new IdentifierSetMultiMap<AccessMode>([[ resource, AccessMode.read ]]);
    try {
      const permissions = await this.permissionReader.handleSafe({ credentials, requestedModes });
      return permissions.get(resource)?.read === true;
    } catch (error: unknown) {
      this.logger.warn(`Unable to determine permissions on ${resource.path}: ${createErrorMessage(error)}`);
      return false;
    }
  }
}
