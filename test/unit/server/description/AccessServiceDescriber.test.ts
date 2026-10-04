import { AccessServiceDescriber } from '../../../../src/server/description/AccessServiceDescriber';
import type { LwsStorageDescriberInput } from '../../../../src/server/description/LwsStorageDescriber';

describe('An AccessServiceDescriber', (): void => {
  const storage = { path: 'http://example.com/alice/' };
  const profile = 'https://www.w3.org/ns/lws#AccessProfile';
  let description: LwsStorageDescriberInput['description'];

  beforeEach(async(): Promise<void> => {
    description = { service: [{ type: 'OtherService' }]};
  });

  it('adds the access request and grant services.', async(): Promise<void> => {
    const describer = new AccessServiceDescriber();
    await expect(describer.handle({ storage, description })).resolves.toBeUndefined();
    expect(description.service).toEqual([
      { type: 'OtherService' },
      {
        type: 'AccessRequestService',
        serviceEndpoint: 'http://example.com/alice/.lws/requests/',
        conformsTo: [ profile ],
      },
      {
        type: 'AccessGrantService',
        serviceEndpoint: 'http://example.com/alice/.lws/grants/',
        conformsTo: [ profile ],
      },
    ]);
  });

  it('supports custom paths.', async(): Promise<void> => {
    const describer = new AccessServiceDescriber('grants/', 'requests/');
    await describer.handle({ storage, description });
    expect(description.service[1].serviceEndpoint).toBe('http://example.com/alice/requests/');
    expect(description.service[2].serviceEndpoint).toBe('http://example.com/alice/grants/');
  });
});
