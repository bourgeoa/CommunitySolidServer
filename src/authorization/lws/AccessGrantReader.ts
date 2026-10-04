import type { Credentials } from '../../authentication/Credentials';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../../logging/LogUtil';
import type { StorageLocationStrategy } from '../../server/description/StorageLocationStrategy';
import type { ResourceStore } from '../../storage/ResourceStore';
import type { IdentifierStrategy } from '../../util/identifiers/IdentifierStrategy';
import { IdentifierMap } from '../../util/map/IdentifierMap';
import { isContainerPath, joinUrl } from '../../util/PathUtil';
import { LWS, RDF } from '../../util/Vocabularies';
import type { PermissionReaderInput } from '../PermissionReader';
import { PermissionReader } from '../PermissionReader';
import type { PermissionMap, PermissionSet } from '../permissions/Permissions';
import { AccessMode } from '../permissions/Permissions';
import type { AccessGrantIndex } from './AccessGrantIndex';
import type { AccessPolicy, ConstraintContext } from './AccessGrantUtil';
import { ACTION_MODES, areConstraintsSatisfied, hasType, PUBLIC_ASSIGNEE } from './AccessGrantUtil';

interface ResourceInfo {
  format?: string;
  types: string[];
}

/**
 * Determines permissions based on the LWS access grants of the storage containing the requested resources.
 *
 * A policy of a grant applies to a resource if
 *  * its assignee is the WebID of the agent, or `foaf:Agent`, which grants access to everyone,
 *  * the resource is one of the target values (targets are not recursive),
 *    and the resource matches the target type,
 *  * and all its constraints are satisfied.
 * Policies without a target do not apply to any resource.
 *
 * The `read`, `modify`, and `delete` actions correspond to the `read`, `write` + `append`, and `delete` modes.
 * The `create` action on a container corresponds to `append` on the container
 * and `create` on the resources directly inside it.
 *
 * Additionally, authenticated agents can create access requests in the access request container of every storage,
 * as they need to be able to request access to resources they can not access yet.
 *
 * This reader only grants permissions, so it should be combined with the other permission readers,
 * for example through a {@link UnionPermissionReader}.
 */
export class AccessGrantReader extends PermissionReader {
  protected readonly logger = getLoggerFor(this);

  private readonly index: AccessGrantIndex;
  private readonly storageStrategy: StorageLocationStrategy;
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly store: ResourceStore;
  private readonly requestPath?: string;

  /**
   * @param index - Contains the access grants.
   * @param storageStrategy - Determines the storage of a resource.
   * @param identifierStrategy - Determines the parent container of a resource.
   * @param store - Used to determine the media type and types of resources when evaluating constraints.
   * @param requestPath - Path of the access request container, relative to the storage.
   *                      Authenticated agents can create resources in that container.
   */
  public constructor(
    index: AccessGrantIndex,
    storageStrategy: StorageLocationStrategy,
    identifierStrategy: IdentifierStrategy,
    store: ResourceStore,
    requestPath?: string,
  ) {
    super();
    this.index = index;
    this.storageStrategy = storageStrategy;
    this.identifierStrategy = identifierStrategy;
    this.store = store;
    this.requestPath = requestPath;
  }

  public async handle({ credentials, requestedModes }: PermissionReaderInput): Promise<PermissionMap> {
    const result: PermissionMap = new IdentifierMap();
    const now = new Date();
    const infoCache = new Map<string, Promise<ResourceInfo>>();
    for (const [ identifier, modes ] of requestedModes.entrySets()) {
      const permissions = await this.getPermissions(identifier, modes, credentials, now, infoCache);
      if (Object.keys(permissions).length > 0) {
        result.set(identifier, permissions);
      }
    }
    return result;
  }

  private async getPermissions(
    identifier: ResourceIdentifier,
    modes: ReadonlySet<AccessMode>,
    credentials: Credentials,
    now: Date,
    infoCache: Map<string, Promise<ResourceInfo>>,
  ): Promise<PermissionSet> {
    let storage: ResourceIdentifier;
    try {
      storage = await this.storageStrategy.getStorageIdentifier(identifier);
    } catch {
      return {};
    }
    const permissions: PermissionSet = {};
    this.addRequestPermissions(identifier, storage, credentials, permissions);

    const policies = await this.getAgentPolicies(storage, credentials);
    if (policies.length === 0) {
      return permissions;
    }

    const getInfo = async(target: ResourceIdentifier): Promise<ResourceInfo> => {
      let info = infoCache.get(target.path);
      if (!info) {
        info = this.getResourceInfo(target);
        infoCache.set(target.path, info);
      }
      return info;
    };
    const parent = this.identifierStrategy.isRootContainer(identifier) ?
      undefined :
        this.identifierStrategy.getParentContainer(identifier);

    for (const policy of policies) {
      const appliesToResource = this.matchesTarget(policy, identifier);
      const appliesToParent = modes.has(AccessMode.create) && parent && policy.action.includes('create') &&
        this.matchesTarget(policy, parent);
      if (!appliesToResource && !appliesToParent) {
        continue;
      }
      const context: ConstraintContext = {
        client: credentials.client?.clientId,
        now,
        getFormat: async(): Promise<string | undefined> => (await getInfo(identifier)).format,
        getTypes: async(): Promise<string[]> => (await getInfo(identifier)).types,
      };
      if (!await areConstraintsSatisfied(policy, context)) {
        continue;
      }
      if (appliesToResource) {
        for (const action of policy.action) {
          for (const mode of ACTION_MODES[action] ?? []) {
            permissions[mode] = true;
          }
        }
      }
      if (appliesToParent) {
        permissions.create = true;
      }
    }
    return permissions;
  }

  /**
   * Authenticated agents can create resources in the access request container.
   */
  private addRequestPermissions(
    identifier: ResourceIdentifier,
    storage: ResourceIdentifier,
    credentials: Credentials,
    permissions: PermissionSet,
  ): void {
    if (!this.requestPath || !credentials.agent?.webId) {
      return;
    }
    const requestContainer = joinUrl(storage.path, this.requestPath);
    if (identifier.path === requestContainer) {
      permissions.append = true;
    } else if (!this.identifierStrategy.isRootContainer(identifier) &&
      this.identifierStrategy.getParentContainer(identifier).path === requestContainer) {
      permissions.create = true;
    }
  }

  /**
   * Returns the policies of the storage grants that have the agent as assignee.
   */
  private async getAgentPolicies(storage: ResourceIdentifier, credentials: Credentials): Promise<AccessPolicy[]> {
    const webId = credentials.agent?.webId;
    const grants = await this.index.getGrants(storage);
    return grants.flatMap(({ grant }): AccessPolicy[] => grant.access)
      .filter((policy): boolean => policy.assignee === PUBLIC_ASSIGNEE || policy.assignee === webId);
  }

  /**
   * Determines whether the given resource matches the target of the policy.
   */
  private matchesTarget(policy: AccessPolicy, identifier: ResourceIdentifier): boolean {
    const { target } = policy;
    if (!target?.value.includes(identifier.path)) {
      return false;
    }
    if (hasType(target.type, 'StorageResource')) {
      return true;
    }
    return hasType(target.type, isContainerPath(identifier.path) ? 'Container' : 'DataResource');
  }

  /**
   * Determines the media type and the types of the given resource.
   */
  private async getResourceInfo(identifier: ResourceIdentifier): Promise<ResourceInfo> {
    const types: string[] = [ isContainerPath(identifier.path) ? LWS.Container : LWS.DataResource ];
    try {
      const { data, metadata } = await this.store.getRepresentation(identifier, {});
      data.destroy();
      types.push(...metadata.getAll(RDF.terms.type).map((term): string => term.value));
      return { format: isContainerPath(identifier.path) ? undefined : metadata.contentType, types };
    } catch {
      this.logger.debug(`Unable to determine the metadata of ${identifier.path}`);
      return { types };
    }
  }
}
