import fetch from 'cross-fetch';
import type { Logger } from '../../../../../src/logging/Logger';
import type { HttpMessageSigner } from '../../../../../src/server/notifications/lws/HttpMessageSigner';
import type { LwsActivity } from '../../../../../src/server/notifications/lws/LwsNotificationSender';
import { LwsDeliveryError } from '../../../../../src/server/notifications/lws/LwsNotificationSender';
import {
  LWS_NOTIFICATION_KEY_FRAGMENT,
  WebhookLwsNotificationSender,
} from '../../../../../src/server/notifications/lws/WebhookLwsNotificationSender';
import { flushPromises } from '../../../../util/Util';

jest.mock('cross-fetch');

jest.mock('../../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { debug: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('A WebhookLwsNotificationSender', (): void => {
  const fetchMock: jest.Mock = fetch as any;
  const inbox = 'https://example.org/inbox';
  const storage = 'http://example.com/alice/';
  const activity: LwsActivity = {
    id: 'urn:uuid:123',
    type: [ 'Update' ],
    object: { id: 'http://example.com/alice/foo', type: [ 'DataResource' ]},
    published: '2026-01-01T00:00:00.000Z',
  };
  const expectedBody = JSON.stringify({
    '@context': [ 'https://www.w3.org/ns/lws/v1' ],
    type: 'Notification',
    storage,
    activity,
  });
  let signer: jest.Mocked<HttpMessageSigner>;

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    fetchMock.mockResolvedValue({ status: 200 });
    signer = {
      sign: jest.fn().mockResolvedValue({ 'content-type': 'application/lws+json', signature: 'sig1=:abc:' }),
    } as any;
  });

  afterEach(async(): Promise<void> => {
    jest.useRealTimers();
  });

  it('sends an unsigned notification.', async(): Promise<void> => {
    const sender = new WebhookLwsNotificationSender();
    await expect(sender.handle({ inbox, storage, activity })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(inbox, {
      method: 'POST',
      headers: { 'content-type': 'application/lws+json' },
      body: expectedBody,
      redirect: 'manual',
    });
  });

  it('sends a signed notification.', async(): Promise<void> => {
    const sender = new WebhookLwsNotificationSender(signer);
    await expect(sender.handle({ inbox, storage, activity })).resolves.toBeUndefined();
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(signer.sign).toHaveBeenLastCalledWith(
      inbox,
      'application/lws+json',
      expectedBody,
      `${storage}#${LWS_NOTIFICATION_KEY_FRAGMENT}`,
    );
    expect(fetchMock).toHaveBeenLastCalledWith(inbox, {
      method: 'POST',
      headers: { 'content-type': 'application/lws+json', signature: 'sig1=:abc:' },
      body: expectedBody,
      redirect: 'manual',
    });
  });

  it('does not accept redirects.', async(): Promise<void> => {
    fetchMock.mockResolvedValue({ status: 302 });
    const sender = new WebhookLwsNotificationSender(undefined, 2, 0);
    await expect(sender.handle({ inbox, storage, activity })).rejects.toMatchObject({ status: 302 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry after a 4xx response.', async(): Promise<void> => {
    fetchMock.mockResolvedValue({ status: 410 });
    const sender = new WebhookLwsNotificationSender(undefined, 2, 0);
    const result = sender.handle({ inbox, storage, activity });
    await expect(result).rejects.toThrow(LwsDeliveryError);
    await expect(result).rejects.toThrow(`Delivering an LWS notification to ${inbox} failed with status 410.`);
    await expect(result).rejects.toMatchObject({ status: 410 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries after 5xx responses and network errors with a doubling delay.', async(): Promise<void> => {
    jest.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });
    const sender = new WebhookLwsNotificationSender(undefined, 2, 100);
    let done = false;
    const result = sender.handle({ inbox, storage, activity }).then((): void => {
      done = true;
    });

    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await result;
    expect(done).toBe(true);
  });

  it('throws an error with the last status if all retries fail.', async(): Promise<void> => {
    fetchMock.mockResolvedValue({ status: 500 });
    const sender = new WebhookLwsNotificationSender(signer, 2, 0);
    const result = sender.handle({ inbox, storage, activity });
    await expect(result).rejects.toThrow(`Delivering an LWS notification to ${inbox} failed with status 500.`);
    await expect(result).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws an error without status if the inbox can not be reached.', async(): Promise<void> => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const sender = new WebhookLwsNotificationSender(undefined, 1, 0);
    const result = sender.handle({ inbox, storage, activity });
    await expect(result).rejects.toThrow(`Delivering an LWS notification to ${inbox} failed.`);
    await expect(result).rejects.toMatchObject({ status: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats signing errors like network errors.', async(): Promise<void> => {
    signer.sign.mockRejectedValue(new Error('bad key'));
    const sender = new WebhookLwsNotificationSender(signer, 0);
    await expect(sender.handle({ inbox, storage, activity })).rejects.toThrow(LwsDeliveryError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
