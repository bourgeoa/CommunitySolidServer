import { getLoggerFor } from '../../logging/LogUtil';
import { findDescendants, isRecursiveDelete } from '../../storage/ContainerUtil';
import type { ResourceStore } from '../../storage/ResourceStore';
import { PreconditionFailedHttpError } from '../../util/errors/PreconditionFailedHttpError';
import type { ResponseDescription } from '../output/response/ResponseDescription';
import type { OperationHandlerInput } from './OperationHandler';
import { OperationHandler } from './OperationHandler';

/**
 * Supports recursive deletes of containers, as requested with the `Depth: infinity` header.
 *
 * LWS, §Delete resource: "Servers MAY support recursive deletion of all contained resources
 * within the container that is being deleted. Clients MUST use the `Depth: infinity` header
 * to request for a recursive delete."
 *
 * The preconditions of the request are checked on the container first.
 * Then all contained resources are deleted, starting with the deepest ones,
 * after which the source handler deletes the container itself, without checking the preconditions again.
 * This is not atomic: if deleting a resource fails, the resources that were already deleted stay deleted.
 */
export class RecursiveDeleteOperationHandler extends OperationHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly source: OperationHandler;
  private readonly store: ResourceStore;

  public constructor(source: OperationHandler, store: ResourceStore) {
    super();
    this.source = source;
    this.store = store;
  }

  public async canHandle(input: OperationHandlerInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    const { operation } = input;
    if (isRecursiveDelete(operation) && await this.store.hasResource(operation.target)) {
      if (operation.conditions) {
        const { data, metadata } = await this.store.getRepresentation(operation.target, {});
        data.destroy();
        if (!operation.conditions.matchesMetadata(metadata)) {
          throw new PreconditionFailedHttpError();
        }
      }
      for (const descendant of await findDescendants(this.store, operation.target)) {
        this.logger.debug(`Recursively deleting ${descendant.path}`);
        await this.store.deleteResource(descendant);
      }
      // The conditions were already checked, and deleting the members changes the state of the container
      return this.source.handle({ operation: { ...operation, conditions: undefined }});
    }
    return this.source.handle(input);
  }
}
