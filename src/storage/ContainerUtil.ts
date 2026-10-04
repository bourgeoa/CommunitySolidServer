import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import type { Operation } from '../http/Operation';
import { INTERNAL_QUADS } from '../util/ContentTypes';
import { isContainerIdentifier } from '../util/PathUtil';
import { readableToQuads } from '../util/StreamUtil';
import { LDP, SOLID_HTTP } from '../util/Vocabularies';
import type { ResourceStore } from './ResourceStore';

/**
 * Determines whether the operation is a recursive delete of a container:
 * a DELETE request with a `Depth: infinity` header that targets a container.
 */
export function isRecursiveDelete(operation: Operation): boolean {
  return operation.method === 'DELETE' && isContainerIdentifier(operation.target) &&
    operation.body.metadata.get(SOLID_HTTP.terms.depth)?.value === 'infinity';
}

/**
 * Returns all resources transitively contained in the given container,
 * ordered so that every resource comes before the container that contains it.
 */
export async function findDescendants(store: ResourceStore, container: ResourceIdentifier):
Promise<ResourceIdentifier[]> {
  const representation = await store.getRepresentation(container, { type: { [INTERNAL_QUADS]: 1 }});
  const quads = await readableToQuads(representation.data);
  const result: ResourceIdentifier[] = [];
  for (const member of quads.getObjects(container.path, LDP.terms.contains, null)) {
    const identifier = { path: member.value };
    if (isContainerIdentifier(identifier)) {
      result.push(...await findDescendants(store, identifier));
    }
    result.push(identifier);
  }
  return result;
}
