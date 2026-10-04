import { EventEmitter } from 'node:events';
import { DataFactory } from 'n3';
import { AccessGrantIndex } from '../../../../src/authorization/lws/AccessGrantIndex';
import { LWS_CONTEXT_URI } from '../../../../src/authorization/lws/AccessGrantUtil';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { ResourceIdentifier } from '../../../../src/http/representation/ResourceIdentifier';
import type { Logger } from '../../../../src/logging/Logger';
import { getLoggerFor } from '../../../../src/logging/LogUtil';
import type { ActivityEmitter } from '../../../../src/server/notifications/ActivityEmitter';
import type { ResourceStore } from '../../../../src/storage/ResourceStore';
import { INTERNAL_QUADS } from '../../../../src/util/ContentTypes';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';
import { AS, LDP } from '../../../../src/util/Vocabularies';

const { namedNode, quad } = DataFactory;

jest.mock('../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { warn: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('An AccessGrantIndex', (): void => {
  const storage = { path: 'http://example.com/alice/' };
  const container = 'http://example.com/alice/.lws/grants/';
  const grant1 = `${container}grant1`;
  const grant2 = `${container}grant2`;
  const invalid = `${container}invalid`;
  const logger = getLoggerFor('AccessGrantIndex') as jest.Mocked<Logger>;
  let resources: Record<string, string>;
  let store: jest.Mocked<ResourceStore>;
  let emitter: ActivityEmitter;
  let index: AccessGrantIndex;

  function createGrant(webId: string): string {
    return JSON.stringify({
      '@context': LWS_CONTEXT_URI,
      type: 'AccessGrant',
      storage: storage.path,
      access: [{ type: 'AccessPolicy', action: [ 'read' ], assignee: webId }],
    });
  }

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    resources = {
      [grant1]: createGrant('http://example.com/bob/profile#me'),
      [grant2]: createGrant('http://example.com/carol/profile#me'),
      [invalid]: '{ "type": "AccessGrant" }',
    };

    store = {
      hasResource: jest.fn().mockResolvedValue(true),
      getRepresentation: jest.fn(async(identifier: ResourceIdentifier): Promise<BasicRepresentation> => {
        if (identifier.path === container) {
          const quads = Object.keys(resources).map((member): any =>
            quad(namedNode(container), LDP.terms.contains, namedNode(member)));
          return new BasicRepresentation(quads, identifier, INTERNAL_QUADS);
        }
        if (!resources[identifier.path]) {
          throw new NotFoundHttpError();
        }
        return new BasicRepresentation(resources[identifier.path], identifier, 'application/ld+json');
      }),
    } as any;

    emitter = new EventEmitter() as any;

    index = new AccessGrantIndex(store, emitter);
  });

  it('returns the grant container of a storage.', async(): Promise<void> => {
    expect(index.getGrantContainer(storage)).toEqual({ path: container });
    index = new AccessGrantIndex(store, emitter, 'grants/');
    expect(index.getGrantContainer(storage)).toEqual({ path: 'http://example.com/alice/grants/' });
  });

  it('returns no grants if there is no grant container.', async(): Promise<void> => {
    store.hasResource.mockResolvedValueOnce(false);
    await expect(index.getGrants(storage)).resolves.toEqual([]);
    expect(store.hasResource).toHaveBeenLastCalledWith({ path: container });
    expect(store.getRepresentation).toHaveBeenCalledTimes(0);
  });

  it('returns the valid grants and ignores the invalid ones.', async(): Promise<void> => {
    const grants = await index.getGrants(storage);
    expect(grants).toHaveLength(2);
    expect(grants[0].id).toBe(grant1);
    expect(grants[0].grant).toEqual(JSON.parse(resources[grant1]));
    expect(grants[1].id).toBe(grant2);
    expect(store.getRepresentation).toHaveBeenCalledWith({ path: container }, { type: { [INTERNAL_QUADS]: 1 }});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(`Ignoring invalid access grant ${invalid}`);
  });

  it('ignores grants that can not be read.', async(): Promise<void> => {
    const missing = quad(namedNode(container), LDP.terms.contains, namedNode(`${container}missing`));
    store.getRepresentation.mockImplementationOnce(async(identifier): Promise<BasicRepresentation> =>
      new BasicRepresentation([ missing ], identifier, INTERNAL_QUADS));
    await expect(index.getGrants(storage)).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('caches the grants.', async(): Promise<void> => {
    const grants = await index.getGrants(storage);
    await expect(index.getGrants(storage)).resolves.toBe(grants);
    expect(store.hasResource).toHaveBeenCalledTimes(1);
  });

  it('clears the cache when a resource in a grant container changes.', async(): Promise<void> => {
    await index.getGrants(storage);
    emitter.emit('changed', { path: 'http://example.com/alice/other' }, AS.terms.Update, {} as any);
    await index.getGrants(storage);
    expect(store.hasResource).toHaveBeenCalledTimes(1);

    emitter.emit('changed', { path: grant1 }, AS.terms.Update, {} as any);
    await index.getGrants(storage);
    expect(store.hasResource).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures.', async(): Promise<void> => {
    store.hasResource.mockRejectedValueOnce(new Error('bad data'));
    await expect(index.getGrants(storage)).rejects.toThrow('bad data');
    await expect(index.getGrants(storage)).resolves.toHaveLength(2);
    expect(store.hasResource).toHaveBeenCalledTimes(2);
  });
});
