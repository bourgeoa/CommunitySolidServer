import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { AsyncHandler } from '../../util/handlers/AsyncHandler';

export interface LwsStorageDescriberInput {
  /**
   * The storage that is being described.
   */
  storage: ResourceIdentifier;
  /**
   * The storage description, which the describer can extend.
   * It always contains a `service` array.
   */
  description: Record<string, unknown> & { service: Record<string, unknown>[] };
}

/**
 * Adds entries to an LWS storage description, such as services and verification methods.
 */
export abstract class LwsStorageDescriber extends AsyncHandler<LwsStorageDescriberInput> {}
