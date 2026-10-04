/* eslint-disable @typescript-eslint/naming-convention */
import fetch from 'cross-fetch';
import { LWS_CONTEXT_URI } from '../../../authorization/lws/AccessGrantUtil';
import { getLoggerFor } from '../../../logging/LogUtil';
import { createErrorMessage } from '../../../util/errors/ErrorUtil';
import { APPLICATION_LWS_JSON } from '../../../util/ContentTypes';
import type { HttpMessageSigner } from './HttpMessageSigner';
import type { LwsNotificationSenderInput } from './LwsNotificationSender';
import { LwsDeliveryError, LwsNotificationSender } from './LwsNotificationSender';

/**
 * The fragment identifier of the notification signing key in a storage description.
 */
export const LWS_NOTIFICATION_KEY_FRAGMENT = 'lws-notification-key';

/**
 * Sends LWS notifications to an inbox with an HTTP POST request,
 * as described in the LWS 1.0 Notification Suite: Webhooks.
 *
 * Deliveries that fail with a 5xx response or a network error are tried again.
 * If the delivery fails, an {@link LwsDeliveryError} is thrown.
 *
 * If a signer is provided, the requests are signed with HTTP Message Signatures.
 * The `keyid` of the signature is the storage URI with the {@link LWS_NOTIFICATION_KEY_FRAGMENT} fragment,
 * so the key needs to be added to the storage description.
 */
export class WebhookLwsNotificationSender extends LwsNotificationSender {
  protected readonly logger = getLoggerFor(this);

  private readonly signer?: HttpMessageSigner;
  private readonly retries: number;
  private readonly retryDelay: number;

  /**
   * @param signer - Signs the requests.
   * @param retries - How often a delivery is tried again after a 5xx response or a network error. Defaults to 2.
   * @param retryDelay - How many milliseconds to wait before the first retry.
   *                     The delay doubles after every retry. Defaults to 1000.
   */
  public constructor(signer?: HttpMessageSigner, retries = 2, retryDelay = 1000) {
    super();
    this.signer = signer;
    this.retries = retries;
    this.retryDelay = retryDelay;
  }

  public async handle({ inbox, storage, activity }: LwsNotificationSenderInput): Promise<void> {
    const body = JSON.stringify({
      '@context': [ LWS_CONTEXT_URI ],
      type: 'Notification',
      storage,
      activity,
    });
    const keyId = `${storage}#${LWS_NOTIFICATION_KEY_FRAGMENT}`;

    let delay = this.retryDelay;
    for (let attempt = 0; ; attempt += 1) {
      this.logger.debug(`Sending LWS notification about ${activity.object.id} to ${inbox}`);
      let status: number | undefined;
      try {
        const headers = this.signer ?
            await this.signer.sign(inbox, APPLICATION_LWS_JSON, body, keyId) :
            { 'content-type': APPLICATION_LWS_JSON };
        // Redirects are not followed, as they would turn the POST request into a GET request
        const response = await fetch(inbox, { method: 'POST', headers, body, redirect: 'manual' });
        status = response.status;
        if (status < 300) {
          return;
        }
      } catch (error: unknown) {
        this.logger.debug(`Unable to reach ${inbox}: ${createErrorMessage(error)}`);
      }
      // Client errors will not be solved by trying again
      if (attempt >= this.retries || (status && status < 500)) {
        throw new LwsDeliveryError(`Delivering an LWS notification to ${inbox} failed` +
          `${status ? ` with status ${status}` : ''}.`, status);
      }
      await new Promise((resolve): unknown => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}
