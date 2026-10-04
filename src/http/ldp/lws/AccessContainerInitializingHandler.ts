import { getLoggerFor } from '../../../logging/LogUtil';
import type { StorageLocationStrategy } from '../../../server/description/StorageLocationStrategy';
import type { OperationHttpHandlerInput } from '../../../server/OperationHttpHandler';
import { OperationHttpHandler } from '../../../server/OperationHttpHandler';
import type { ResourceSet } from '../../../storage/ResourceSet';
import type { ResourceStore } from '../../../storage/ResourceStore';
import { INTERNAL_QUADS } from '../../../util/ContentTypes';
import { createErrorMessage } from '../../../util/errors/ErrorUtil';
import { joinUrl } from '../../../util/PathUtil';
import type { ResponseDescription } from '../../output/response/ResponseDescription';
import { BasicRepresentation } from '../../representation/BasicRepresentation';
import type { ResourceIdentifier } from '../../representation/ResourceIdentifier';

export interface AccessContainerInitializingHandlerArgs {
  /**
   * The handler to call after the containers have been created.
   */
  source: OperationHttpHandler;
  /**
   * Determines the storage of the target resource.
   */
  storageStrategy: StorageLocationStrategy;
  /**
   * Used to check whether the storage and the containers exist.
   */
  resourceSet: ResourceSet;
  /**
   * Used to create the containers.
   */
  store: ResourceStore;
  /**
   * Paths of the containers, relative to the storage.
   */
  paths: string[];
}

/**
 * Makes sure the given containers exist in the storage of the target resource before calling the source handler.
 * This is used to create the LWS access grant and access request containers in existing storages.
 * Every storage is only checked once.
 */
export class AccessContainerInitializingHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly source: OperationHttpHandler;
  private readonly storageStrategy: StorageLocationStrategy;
  private readonly resourceSet: ResourceSet;
  private readonly store: ResourceStore;
  private readonly paths: string[];
  private readonly initialized = new Map<string, Promise<boolean>>();

  public constructor(args: AccessContainerInitializingHandlerArgs) {
    super();
    this.source = args.source;
    this.storageStrategy = args.storageStrategy;
    this.resourceSet = args.resourceSet;
    this.store = args.store;
    this.paths = args.paths;
  }

  public async canHandle(input: OperationHttpHandlerInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public async handle(input: OperationHttpHandlerInput): Promise<ResponseDescription> {
    await this.initialize(input.operation.target);
    return this.source.handle(input);
  }

  private async initialize(target: ResourceIdentifier): Promise<void> {
    let storage: ResourceIdentifier;
    try {
      storage = await this.storageStrategy.getStorageIdentifier(target);
    } catch {
      return;
    }
    let promise = this.initialized.get(storage.path);
    if (!promise) {
      promise = this.createContainers(storage);
      this.initialized.set(storage.path, promise);
    }
    try {
      if (!await promise) {
        // The storage does not exist yet
        this.initialized.delete(storage.path);
      }
    } catch (error: unknown) {
      // Try again on the next request
      this.initialized.delete(storage.path);
      this.logger.warn(`Unable to create the access containers of ${storage.path}: ${createErrorMessage(error)}`);
    }
  }

  /**
   * Creates the containers if the storage exists. Returns false if it does not.
   */
  private async createContainers(storage: ResourceIdentifier): Promise<boolean> {
    if (!await this.resourceSet.hasResource(storage)) {
      return false;
    }
    for (const path of this.paths) {
      const container = { path: joinUrl(storage.path, path) };
      if (!await this.resourceSet.hasResource(container)) {
        this.logger.info(`Creating container ${container.path}`);
        await this.store.setRepresentation(container, new BasicRepresentation([], container, INTERNAL_QUADS));
      }
    }
    return true;
  }
}
