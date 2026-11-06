import type { Operation } from '../../http/Operation';
import type { ResourceSet } from '../../storage/ResourceSet';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { JSON_PATCH_TYPES } from '../../util/JsonPatch';
import { IdentifierSetMultiMap } from '../../util/map/IdentifierMap';
import { ModesExtractor } from './ModesExtractor';
import type { AccessMap } from './Permissions';
import { AccessMode } from './Permissions';

/**
 * Determines the required access modes for JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7386) requests.
 *
 * Both can replace and remove any value of the target resource,
 * and its result depends on the current state of the resource,
 * so it requires Read and Write permissions.
 * Create permissions are also required in case the target resource does not exist yet.
 */
export class JsonPatchModesExtractor extends ModesExtractor {
  private readonly resourceSet: ResourceSet;

  public constructor(resourceSet: ResourceSet) {
    super();
    this.resourceSet = resourceSet;
  }

  public async canHandle({ body }: Operation): Promise<void> {
    if (!JSON_PATCH_TYPES.includes(body.metadata.contentType!)) {
      throw new NotImplementedHttpError('Can only determine permissions of JSON patch documents.');
    }
  }

  public async handle({ target }: Operation): Promise<AccessMap> {
    const requiredModes: AccessMap = new IdentifierSetMultiMap();
    requiredModes.add(target, AccessMode.read);
    requiredModes.add(target, AccessMode.write);
    if (!await this.resourceSet.hasResource(target)) {
      requiredModes.add(target, AccessMode.create);
    }
    return requiredModes;
  }
}
