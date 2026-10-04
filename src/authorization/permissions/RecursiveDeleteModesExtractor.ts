import type { Operation } from '../../http/Operation';
import { findDescendants, isRecursiveDelete } from '../../storage/ContainerUtil';
import type { ResourceSet } from '../../storage/ResourceSet';
import type { ResourceStore } from '../../storage/ResourceStore';
import { ModesExtractor } from './ModesExtractor';
import type { AccessMap } from './Permissions';
import { AccessMode } from './Permissions';

/**
 * Adds the `delete` mode on all resources in a container to the modes of a recursive delete of that container,
 * as requested with the `Depth: infinity` header.
 * See {@link isRecursiveDelete}.
 */
export class RecursiveDeleteModesExtractor extends ModesExtractor {
  private readonly source: ModesExtractor;
  private readonly resourceSet: ResourceSet;
  private readonly store: ResourceStore;

  public constructor(source: ModesExtractor, resourceSet: ResourceSet, store: ResourceStore) {
    super();
    this.source = source;
    this.resourceSet = resourceSet;
    this.store = store;
  }

  public async canHandle(operation: Operation): Promise<void> {
    await this.source.canHandle(operation);
  }

  public async handle(operation: Operation): Promise<AccessMap> {
    const accessMap = await this.source.handle(operation);
    if (isRecursiveDelete(operation) && await this.resourceSet.hasResource(operation.target)) {
      for (const descendant of await findDescendants(this.store, operation.target)) {
        accessMap.add(descendant, AccessMode.delete);
      }
    }
    return accessMap;
  }
}
