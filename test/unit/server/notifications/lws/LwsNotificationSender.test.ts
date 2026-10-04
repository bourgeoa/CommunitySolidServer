import { createLwsActivity, LwsDeliveryError } from '../../../../../src/server/notifications/lws/LwsNotificationSender';

describe('LwsNotificationSender', (): void => {
  describe('createLwsActivity', (): void => {
    it('creates an activity.', async(): Promise<void> => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      jest.useFakeTimers();
      jest.setSystemTime(now);
      const activity = createLwsActivity('Update', 'http://example.com/foo', [ 'DataResource' ]);
      jest.useRealTimers();
      expect(activity).toEqual({
        id: expect.stringMatching(/^urn:uuid:[0-9a-f-]{36}$/u),
        type: [ 'Update' ],
        object: { id: 'http://example.com/foo', type: [ 'DataResource' ]},
        published: now.toISOString(),
      });
    });

    it('adds the extra properties.', async(): Promise<void> => {
      const activity = createLwsActivity('Create', 'http://example.com/foo', [ 'DataResource' ], {
        target: 'http://example.com/',
        published: 'ignored',
      });
      expect(activity.target).toBe('http://example.com/');
      expect(activity.published).not.toBe('ignored');
    });

    it('generates unique identifiers.', async(): Promise<void> => {
      const first = createLwsActivity('Delete', 'http://example.com/foo', [ 'DataResource' ]);
      const second = createLwsActivity('Delete', 'http://example.com/foo', [ 'DataResource' ]);
      expect(first.id).not.toBe(second.id);
    });
  });

  describe('A LwsDeliveryError', (): void => {
    it('stores the message and status.', async(): Promise<void> => {
      const error = new LwsDeliveryError('failed', 410);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('LwsDeliveryError');
      expect(error.message).toBe('failed');
      expect(error.status).toBe(410);
    });

    it('can have no status.', async(): Promise<void> => {
      expect(new LwsDeliveryError('failed').status).toBeUndefined();
    });
  });
});
