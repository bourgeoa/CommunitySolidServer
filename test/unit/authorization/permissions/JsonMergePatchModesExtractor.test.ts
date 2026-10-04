import { JsonMergePatchModesExtractor } from '../../../../src/authorization/permissions/JsonMergePatchModesExtractor';
import type { AccessMap } from '../../../../src/authorization/permissions/Permissions';
import { AccessMode } from '../../../../src/authorization/permissions/Permissions';
import type { Operation } from '../../../../src/http/Operation';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { ResourceIdentifier } from '../../../../src/http/representation/ResourceIdentifier';
import type { ResourceSet } from '../../../../src/storage/ResourceSet';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { IdentifierSetMultiMap } from '../../../../src/util/map/IdentifierMap';
import { compareMaps } from '../../../util/Util';

describe('A JsonMergePatchModesExtractor', (): void => {
  const target: ResourceIdentifier = { path: 'http://example.com/foo' };
  let operation: Operation;
  let resourceSet: jest.Mocked<ResourceSet>;
  let extractor: JsonMergePatchModesExtractor;

  function getMap(modes: AccessMode[]): AccessMap {
    return new IdentifierSetMultiMap(modes.map((mode): [ResourceIdentifier, AccessMode] => [ target, mode ]));
  }

  beforeEach(async(): Promise<void> => {
    operation = {
      method: 'PATCH',
      body: new BasicRepresentation('{}', 'application/merge-patch+json'),
      preferences: {},
      target,
    };

    resourceSet = {
      hasResource: jest.fn().mockResolvedValue(true),
    };

    extractor = new JsonMergePatchModesExtractor(resourceSet);
  });

  it('can only handle JSON Merge Patch documents.', async(): Promise<void> => {
    await expect(extractor.canHandle(operation)).resolves.toBeUndefined();

    operation.body = new BasicRepresentation('{}', 'application/json');
    await expect(extractor.canHandle(operation)).rejects.toThrow(NotImplementedHttpError);
  });

  it('requires read and write access.', async(): Promise<void> => {
    compareMaps(await extractor.handle(operation), getMap([ AccessMode.read, AccessMode.write ]));
    expect(resourceSet.hasResource).toHaveBeenLastCalledWith(target);
  });

  it('also requires create access if the resource does not exist.', async(): Promise<void> => {
    resourceSet.hasResource.mockResolvedValueOnce(false);
    compareMaps(await extractor.handle(operation), getMap([ AccessMode.read, AccessMode.write, AccessMode.create ]));
  });
});
