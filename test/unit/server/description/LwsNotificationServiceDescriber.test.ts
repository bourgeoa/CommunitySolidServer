import type { LwsStorageDescriberInput } from '../../../../src/server/description/LwsStorageDescriber';
import {
  LwsNotificationServiceDescriber,
} from '../../../../src/server/description/LwsNotificationServiceDescriber';
import type { HttpMessageSigner } from '../../../../src/server/notifications/lws/HttpMessageSigner';

describe('A LwsNotificationServiceDescriber', (): void => {
  const baseUrl = 'http://example.com/';
  const storage = { path: 'http://example.com/alice/' };
  const keyId = 'http://example.com/alice/#lws-notification-key';
  const publicKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', alg: 'ES256' };
  const service = {
    type: 'NotificationService',
    serviceEndpoint: 'http://example.com/.notifications/lws/',
    subscriptionType: [ 'WebhookSubscription' ],
  };
  let description: LwsStorageDescriberInput['description'];
  let signer: jest.Mocked<HttpMessageSigner>;

  beforeEach(async(): Promise<void> => {
    description = { service: []};
    signer = {
      getPublicKey: jest.fn().mockResolvedValue(publicKey),
    } as any;
  });

  it('adds the notification service.', async(): Promise<void> => {
    const describer = new LwsNotificationServiceDescriber(baseUrl);
    await expect(describer.handle({ storage, description })).resolves.toBeUndefined();
    expect(description).toEqual({ service: [ service ]});
  });

  it('supports a custom path.', async(): Promise<void> => {
    const describer = new LwsNotificationServiceDescriber(baseUrl, 'subs/');
    await describer.handle({ storage, description });
    expect(description.service[0].serviceEndpoint).toBe('http://example.com/subs/');
  });

  it('adds the signing key if there is a signer.', async(): Promise<void> => {
    const describer = new LwsNotificationServiceDescriber(baseUrl, undefined, signer);
    await describer.handle({ storage, description });
    expect(description).toEqual({
      service: [ service ],
      verificationMethod: [{
        id: keyId,
        type: 'JsonWebKey',
        controller: storage.path,
        publicKeyJwk: publicKey,
      }],
      authentication: [ keyId ],
    });
  });

  it('keeps existing verification methods.', async(): Promise<void> => {
    description.verificationMethod = [{ id: 'other' }];
    description.authentication = [ 'other' ];
    const describer = new LwsNotificationServiceDescriber(baseUrl, undefined, signer);
    await describer.handle({ storage, description });
    expect(description.verificationMethod).toEqual([
      { id: 'other' },
      { id: keyId, type: 'JsonWebKey', controller: storage.path, publicKeyJwk: publicKey },
    ]);
    expect(description.authentication).toEqual([ 'other', keyId ]);
  });

  it('replaces non-array verification values.', async(): Promise<void> => {
    description.verificationMethod = 'invalid';
    description.authentication = 'invalid';
    const describer = new LwsNotificationServiceDescriber(baseUrl, undefined, signer);
    await describer.handle({ storage, description });
    expect(description.verificationMethod).toHaveLength(1);
    expect(description.authentication).toEqual([ keyId ]);
  });
});
