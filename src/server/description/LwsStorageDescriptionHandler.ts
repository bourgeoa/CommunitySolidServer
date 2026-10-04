/* eslint-disable @typescript-eslint/naming-convention */
import { OkResponseDescription } from '../../http/output/response/OkResponseDescription';
import type { ResponseDescription } from '../../http/output/response/ResponseDescription';
import { BasicRepresentation } from '../../http/representation/BasicRepresentation';
import type { ValuePreferences } from '../../http/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../../logging/LogUtil';
import type { ResourceSet } from '../../storage/ResourceSet';
import { getTypeWeight } from '../../storage/conversion/ConversionUtil';
import { APPLICATION_LWS_CID } from '../../util/ContentTypes';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import type { OperationHttpHandlerInput } from '../OperationHttpHandler';
import { OperationHttpHandler } from '../OperationHttpHandler';
import type { LwsStorageDescriber, LwsStorageDescriberInput } from './LwsStorageDescriber';
import type { StorageLocationStrategy } from './StorageLocationStrategy';

/**
 * A service or capability entry in an LWS storage description.
 */
export type LwsStorageEntry = Record<string, unknown> & { type: string | string[] };

export interface LwsStorageDescriptionHandlerArgs {
  /**
   * Used to determine whether the target of a request is the URI of a storage.
   */
  storageStrategy: StorageLocationStrategy;
  /**
   * Used to verify the storage exists.
   */
  resourceSet: ResourceSet;
  /**
   * Additional services to include in every storage description.
   * Relative `serviceEndpoint` values are resolved against the storage URI.
   */
  services?: LwsStorageEntry[];
  /**
   * Capabilities to include in every storage description.
   */
  capabilities?: LwsStorageEntry[];
  /**
   * Describers that can add entries to every storage description, such as additional services.
   */
  describers?: LwsStorageDescriber[];
  /**
   * Whether a request that only accepts `*` + `/` + `*` should also receive the storage description.
   * Requests without an Accept header always receive the description.
   * Servers that also need to support Solid clients can set this to false,
   * so the storage root container is returned in that case, as Solid clients expect.
   * Defaults to true.
   */
  wildcardDescribes?: boolean;
}

/**
 * Serves the LWS storage description resource on the storage URI.
 *
 * In this implementation, the storage URI is the URI of the storage root container,
 * which is allowed by LWS, §Logical Resource Organization: "Storage MAY function as a root container".
 * Content negotiation determines whether a request receives the storage description (`application/lws+cid`)
 * or a representation of the root container.
 *
 * LWS, §Discovery and Binding: "Requests for the storage URI MUST return a document that conforms to
 * the storage description resource data model with a media type of `application/lws+cid`,
 * unless content negotiation requires a different format."
 *
 * The storage description is public, so clients can always discover the services of a storage.
 * Requests that do not prefer the storage description are rejected in the `canHandle` call,
 * so they can be handled by the next handler.
 */
export class LwsStorageDescriptionHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly storageStrategy: StorageLocationStrategy;
  private readonly resourceSet: ResourceSet;
  private readonly services: LwsStorageEntry[];
  private readonly capabilities: LwsStorageEntry[];
  private readonly describers: LwsStorageDescriber[];
  private readonly wildcardDescribes: boolean;

  public constructor(args: LwsStorageDescriptionHandlerArgs) {
    super();
    this.storageStrategy = args.storageStrategy;
    this.resourceSet = args.resourceSet;
    this.services = args.services ?? [];
    this.capabilities = args.capabilities ?? [];
    this.describers = args.describers ?? [];
    this.wildcardDescribes = args.wildcardDescribes ?? true;
  }

  public async canHandle({ operation: { method, target, preferences }}: OperationHttpHandlerInput): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new NotImplementedHttpError('Only GET and HEAD requests can target the storage description.');
    }
    if (!this.prefersDescription(preferences.type)) {
      throw new NotImplementedHttpError('The request does not prefer the storage description.');
    }
    if (!await this.isStorage(target)) {
      throw new NotImplementedHttpError(`${target.path} is not the URI of a storage.`);
    }
  }

  public async handle({ operation: { method, target }}: OperationHttpHandlerInput):
  Promise<ResponseDescription> {
    const representation = new BasicRepresentation(
      JSON.stringify(await this.describe(target)),
      target,
      APPLICATION_LWS_CID,
    );
    if (method === 'HEAD') {
      representation.data.destroy();
      return new OkResponseDescription(representation.metadata);
    }
    return new OkResponseDescription(representation.metadata, representation.data);
  }

  /**
   * Generates the storage description for the given storage.
   */
  protected async describe(storage: ResourceIdentifier): Promise<Record<string, unknown>> {
    const services: LwsStorageEntry[] = [
      { type: 'StorageRoot', serviceEndpoint: storage.path },
      ...this.services.map((service): LwsStorageEntry => this.resolveEndpoint(service, storage)),
    ];
    const description: LwsStorageDescriberInput['description'] = {
      '@context': [ 'https://www.w3.org/ns/cid/v1', 'https://www.w3.org/ns/lws/v1' ],
      id: storage.path,
      type: 'Storage',
      service: services,
    };
    if (this.capabilities.length > 0) {
      description.capability = this.capabilities;
    }
    for (const describer of this.describers) {
      await describer.handleSafe({ storage, description });
    }
    return description;
  }

  private resolveEndpoint(service: LwsStorageEntry, storage: ResourceIdentifier): LwsStorageEntry {
    if (typeof service.serviceEndpoint !== 'string') {
      return service;
    }
    return { ...service, serviceEndpoint: new URL(service.serviceEndpoint, storage.path).href };
  }

  /**
   * Determines whether the storage description is the preferred response for the given type preferences.
   */
  private prefersDescription(preferred?: ValuePreferences): boolean {
    // No Accept header: there is no content negotiation that requires a different format
    if (!preferred || Object.keys(preferred).length === 0) {
      return true;
    }
    const weight = getTypeWeight(APPLICATION_LWS_CID, preferred);
    if (weight <= 0) {
      return false;
    }
    const explicit = APPLICATION_LWS_CID in preferred;
    if (!explicit && !this.wildcardDescribes) {
      return false;
    }
    // Only describe if no other explicitly requested type is preferred
    return Object.entries(preferred).every(([ type, value ]): boolean =>
      type === APPLICATION_LWS_CID || type.includes('*') || value <= weight);
  }

  private async isStorage(target: ResourceIdentifier): Promise<boolean> {
    try {
      const storage = await this.storageStrategy.getStorageIdentifier(target);
      return storage.path === target.path && await this.resourceSet.hasResource(target);
    } catch {
      return false;
    }
  }
}
