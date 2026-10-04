import { randomUUID } from 'node:crypto';
import { AsyncHandler } from '../../../util/handlers/AsyncHandler';

/**
 * An Activity Streams 2.0 activity of an LWS notification.
 */
export interface LwsActivity {
  id: string;
  type: string[];
  object: { id: string; type: string[] };
  target?: string;
  origin?: string;
  published: string;
  [key: string]: unknown;
}

export interface LwsNotificationSenderInput {
  /**
   * The URL the notification is sent to.
   */
  inbox: string;
  /**
   * The storage the notification is associated with.
   */
  storage: string;
  /**
   * The activity describing the event.
   */
  activity: LwsActivity;
}

/**
 * Thrown when a notification could not be delivered.
 */
export class LwsDeliveryError extends Error {
  /**
   * The status code of the last response of the inbox, if there was one.
   */
  public readonly status?: number;

  public constructor(message: string, status?: number) {
    super(message);
    this.name = 'LwsDeliveryError';
    this.status = status;
  }
}

/**
 * Delivers an LWS notification to an inbox.
 * Throws an {@link LwsDeliveryError} if the notification could not be delivered.
 */
export abstract class LwsNotificationSender extends AsyncHandler<LwsNotificationSenderInput> {}

/**
 * Creates an activity of an LWS notification.
 *
 * @param type - The Activity Streams type of the activity.
 * @param object - The identifier of the resource the activity is about.
 * @param objectTypes - The types of that resource.
 * @param extra - Additional properties of the activity.
 */
export function createLwsActivity(
  type: string,
  object: string,
  objectTypes: string[],
  extra: Partial<LwsActivity> = {},
): LwsActivity {
  return {
    id: `urn:uuid:${randomUUID()}`,
    type: [ type ],
    object: { id: object, type: objectTypes },
    ...extra,
    published: new Date().toISOString(),
  };
}
