import { DataFactory } from 'n3';
import type { Operation } from '../../../src/http/Operation';
import { BasicRepresentation } from '../../../src/http/representation/BasicRepresentation';
import type { ResourceIdentifier } from '../../../src/http/representation/ResourceIdentifier';
import { findDescendants, isRecursiveDelete } from '../../../src/storage/ContainerUtil';
import type { ResourceStore } from '../../../src/storage/ResourceStore';
import { INTERNAL_QUADS } from '../../../src/util/ContentTypes';
import { LDP, SOLID_HTTP } from '../../../src/util/Vocabularies';

const { namedNode, quad } = DataFactory;

describe('ContainerUtil', (): void => {
  describe('#isRecursiveDelete', (): void => {
    let operation: Operation;

    beforeEach(async(): Promise<void> => {
      operation = {
        method: 'DELETE',
        target: { path: 'http://example.com/container/' },
        preferences: {},
        body: new BasicRepresentation(),
      };
      operation.body.metadata.set(SOLID_HTTP.terms.depth, 'infinity');
    });

    it('returns true for a DELETE on a container with depth infinity.', async(): Promise<void> => {
      expect(isRecursiveDelete(operation)).toBe(true);
    });

    it('returns false for other methods.', async(): Promise<void> => {
      operation.method = 'GET';
      expect(isRecursiveDelete(operation)).toBe(false);
    });

    it('returns false if the target is not a container.', async(): Promise<void> => {
      operation.target = { path: 'http://example.com/document' };
      expect(isRecursiveDelete(operation)).toBe(false);
    });

    it('returns false if there is no depth infinity.', async(): Promise<void> => {
      operation.body.metadata.removeAll(SOLID_HTTP.terms.depth);
      expect(isRecursiveDelete(operation)).toBe(false);
      operation.body.metadata.set(SOLID_HTTP.terms.depth, '1');
      expect(isRecursiveDelete(operation)).toBe(false);
    });
  });

  describe('#findDescendants', (): void => {
    const root = 'http://example.com/container/';
    const children: Record<string, string[]> = {
      [root]: [ `${root}a`, `${root}sub/`, `${root}b` ],
      [`${root}sub/`]: [ `${root}sub/c`, `${root}sub/empty/` ],
      [`${root}sub/empty/`]: [],
    };
    let store: jest.Mocked<ResourceStore>;

    beforeEach(async(): Promise<void> => {
      store = {
        getRepresentation: jest.fn(async(identifier: ResourceIdentifier): Promise<BasicRepresentation> => {
          const quads = children[identifier.path].map((child): any =>
            quad(namedNode(identifier.path), LDP.terms.contains, namedNode(child)));
          return new BasicRepresentation(quads, identifier, INTERNAL_QUADS);
        }),
      } as any;
    });

    it('returns all descendants with members before their container.', async(): Promise<void> => {
      await expect(findDescendants(store, { path: root })).resolves.toEqual([
        { path: `${root}a` },
        { path: `${root}sub/c` },
        { path: `${root}sub/empty/` },
        { path: `${root}sub/` },
        { path: `${root}b` },
      ]);
      expect(store.getRepresentation).toHaveBeenCalledTimes(3);
      expect(store.getRepresentation).toHaveBeenLastCalledWith(
        { path: `${root}sub/empty/` },
        { type: { [INTERNAL_QUADS]: 1 }},
      );
    });

    it('returns an empty list for an empty container.', async(): Promise<void> => {
      await expect(findDescendants(store, { path: `${root}sub/empty/` })).resolves.toEqual([]);
    });
  });
});
