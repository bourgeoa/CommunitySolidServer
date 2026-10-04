import type { HttpMessageSigner } from '../notifications/lws/HttpMessageSigner';
import { LWS_NOTIFICATION_KEY_FRAGMENT } from '../notifications/lws/WebhookLwsNotificationSender';
import { joinUrl } from '../../util/PathUtil';
import type { LwsStorageDescriberInput } from './LwsStorageDescriber';
import { LwsStorageDescriber } from './LwsStorageDescriber';

/**
 * Adds the notification service of the LWS 1.0 Notification Suite: Webhooks to an LWS storage description.
 *
 * If a signer is provided, its public key is added as a verification method,
 * referenced from the `authentication` verification relationship,
 * so inboxes can verify the signatures of the notifications.
 */
export class LwsNotificationServiceDescriber extends LwsStorageDescriber {
  private readonly endpoint: string;
  private readonly signer?: HttpMessageSigner;

  /**
   * @param baseUrl - Base URL of the server.
   * @param path - Path of the subscription endpoint, relative to the base URL. Defaults to `.notifications/lws/`.
   * @param signer - Signs the notifications.
   */
  public constructor(baseUrl: string, path = '.notifications/lws/', signer?: HttpMessageSigner) {
    super();
    this.endpoint = joinUrl(baseUrl, path);
    this.signer = signer;
  }

  public async handle({ storage, description }: LwsStorageDescriberInput): Promise<void> {
    description.service.push({
      type: 'NotificationService',
      serviceEndpoint: this.endpoint,
      subscriptionType: [ 'WebhookSubscription' ],
    });

    if (this.signer) {
      const id = `${storage.path}#${LWS_NOTIFICATION_KEY_FRAGMENT}`;
      const methods = Array.isArray(description.verificationMethod) ? description.verificationMethod as unknown[] : [];
      const authentication = Array.isArray(description.authentication) ? description.authentication as unknown[] : [];
      description.verificationMethod = [ ...methods, {
        id,
        type: 'JsonWebKey',
        controller: storage.path,
        publicKeyJwk: await this.signer.getPublicKey(),
      }];
      description.authentication = [ ...authentication, id ];
    }
  }
}
