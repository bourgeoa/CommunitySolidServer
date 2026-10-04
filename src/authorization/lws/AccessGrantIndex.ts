import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../../logging/LogUtil';
import type { ActivityEmitter } from '../../server/notifications/ActivityEmitter';
import type { ResourceStore } from '../../storage/ResourceStore';
import { INTERNAL_QUADS } from '../../util/ContentTypes';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { joinUrl } from '../../util/PathUtil';
import { readableToQuads, readableToString } from '../../util/StreamUtil';
import { LDP } from '../../util/Vocabularies';
import type { AccessDocument } from './AccessGrantUtil';
import { validateAccessDocument } from './AccessGrantUtil';

/**
 * An access grant together with its identifier.
 */
export interface StoredAccessGrant {
  id: string;
  grant: AccessDocument;
}

/**
 * Keeps track of the LWS access grants of every storage.
 * The grants of a storage are the resources in its access grant container,
 * which is found at the given relative path of the storage.
 *
 * The grants are cached in memory, and the cache is cleared whenever a resource in an access grant container changes.
 * Since the cache is in memory, this class should not be used on a server with multiple worker threads.
 */
export class AccessGrantIndex {
  protected readonly logger = getLoggerFor(this);

  private readonly store: ResourceStore;
  private readonly grantPath: string;
  private readonly cache = new Map<string, Promise<StoredAccessGrant[]>>();

  /**
   * @param store - Store containing the grants.
   * @param emitter - Emits the changes to the store, so the cache can be cleared.
   * @param grantPath - Path of the access grant container, relative to the storage. Defaults to `.lws/grants/`.
   */
  public constructor(store: ResourceStore, emitter: ActivityEmitter, grantPath = '.lws/grants/') {
    this.store = store;
    this.grantPath = grantPath;
    emitter.on('changed', (topic): void => {
      if (topic.path.includes(`/${this.grantPath}`)) {
        this.cache.clear();
      }
    });
  }

  /**
   * Returns the identifier of the access grant container of the given storage.
   */
  public getGrantContainer(storage: ResourceIdentifier): ResourceIdentifier {
    return { path: joinUrl(storage.path, this.grantPath) };
  }

  /**
   * Returns all valid access grants of the given storage.
   */
  public async getGrants(storage: ResourceIdentifier): Promise<StoredAccessGrant[]> {
    let grants = this.cache.get(storage.path);
    if (!grants) {
      grants = this.loadGrants(storage);
      this.cache.set(storage.path, grants);
      // Do not cache failures
      const pending = grants;
      pending.catch((): void => {
        if (this.cache.get(storage.path) === pending) {
          this.cache.delete(storage.path);
        }
      });
    }
    return grants;
  }

  private async loadGrants(storage: ResourceIdentifier): Promise<StoredAccessGrant[]> {
    const container = this.getGrantContainer(storage);
    if (!await this.store.hasResource(container)) {
      return [];
    }
    const representation = await this.store.getRepresentation(container, { type: { [INTERNAL_QUADS]: 1 }});
    const quads = await readableToQuads(representation.data);
    const members = quads.getObjects(container.path, LDP.terms.contains, null).map((term): string => term.value);

    const grants: StoredAccessGrant[] = [];
    for (const member of members) {
      try {
        const grantRepresentation = await this.store.getRepresentation({ path: member }, {});
        const grant = JSON.parse(await readableToString(grantRepresentation.data)) as unknown;
        grants.push({ id: member, grant: validateAccessDocument(grant, 'AccessGrant', storage.path) });
      } catch (error: unknown) {
        this.logger.warn(`Ignoring invalid access grant ${member}: ${createErrorMessage(error)}`);
      }
    }
    return grants;
  }
}
