import { getLoggerFor } from '../../../logging/LogUtil';
import { PAGINATION_RELATIONS } from '../../../storage/conversion/ContainerToLwsJsonConverter';
import type { StorageLocationStrategy } from '../../../server/description/StorageLocationStrategy';
import type { HttpResponse } from '../../../server/HttpResponse';
import { APPLICATION_LINKSET_JSON, APPLICATION_LWS_CID } from '../../../util/ContentTypes';
import { addHeader } from '../../../util/HeaderUtil';
import type { IdentifierStrategy } from '../../../util/identifiers/IdentifierStrategy';
import { isContainerIdentifier } from '../../../util/PathUtil';
import { LDP, LWS, RDF, SOLID_ERROR, SOLID_HTTP } from '../../../util/Vocabularies';
import type { AuxiliaryStrategy } from '../../auxiliary/AuxiliaryStrategy';
import type { RepresentationMetadata } from '../../representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../representation/ResourceIdentifier';
import { MetadataWriter } from './MetadataWriter';

/**
 * Adds the `Link` headers required by the Linked Web Storage protocol.
 *
 * For successful responses to read requests, and for 201 responses after creating a resource, this adds:
 *  * `rel="https://www.w3.org/ns/lws#storage"`, pointing to the storage the resource is part of.
 *  * `rel="up"`, pointing to the parent container, unless the resource is a storage root.
 *  * `rel="type"`, with value `lws:Container` or `lws:DataResource`.
 *  * `rel="linkset"`, pointing to the linkset resource of the resource.
 *  * `rel="first"`, `rel="last"`, `rel="prev"`, and `rel="next"` for paginated container listings.
 *
 * Auxiliary resources only receive the storage link as they are not part of the containment hierarchy.
 * The storage description, and error responses which have a target, such as 401 responses,
 * also receive the storage link so clients can discover the storage without hardcoding its location.
 */
export class LwsLinkMetadataWriter extends MetadataWriter {
  protected readonly logger = getLoggerFor(this);

  private readonly storageStrategy: StorageLocationStrategy;
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly auxiliaryStrategy: AuxiliaryStrategy;
  private readonly linksetStrategy: AuxiliaryStrategy;

  /**
   * @param storageStrategy - Used to find the storage a resource belongs to.
   * @param identifierStrategy - Used to find the parent container of a resource.
   * @param auxiliaryStrategy - Used to determine if a resource is an auxiliary resource.
   * @param linksetStrategy - Used to determine the identifier of the linkset resource.
   */
  public constructor(
    storageStrategy: StorageLocationStrategy,
    identifierStrategy: IdentifierStrategy,
    auxiliaryStrategy: AuxiliaryStrategy,
    linksetStrategy: AuxiliaryStrategy,
  ) {
    super();
    this.storageStrategy = storageStrategy;
    this.identifierStrategy = identifierStrategy;
    this.auxiliaryStrategy = auxiliaryStrategy;
    this.linksetStrategy = linksetStrategy;
  }

  public async handle({ response, metadata }: { response: HttpResponse; metadata: RepresentationMetadata }):
  Promise<void> {
    let identifier: ResourceIdentifier | undefined;
    let fullLinks = true;
    if (metadata.contentType === APPLICATION_LWS_CID) {
      // The storage description only needs the storage link
      identifier = { path: metadata.identifier.value };
      fullLinks = false;
    } else if (metadata.has(RDF.terms.type, LDP.terms.Resource)) {
      identifier = { path: metadata.identifier.value };
    } else {
      const location = metadata.get(SOLID_HTTP.terms.location);
      if (location) {
        identifier = { path: location.value };
      } else {
        const target = metadata.get(SOLID_ERROR.terms.target);
        if (target) {
          identifier = { path: target.value };
          fullLinks = false;
        }
      }
    }

    if (!identifier) {
      return;
    }

    const storage = await this.findStorage(identifier);
    if (storage) {
      addHeader(response, 'Link', `<${storage.path}>; rel="${LWS.storage}"`);
    }

    if (!fullLinks || this.auxiliaryStrategy.isAuxiliaryIdentifier(identifier)) {
      return;
    }

    // LWS, §Containment: "Servers MUST include a Link header with rel="up" pointing to the parent container
    // in responses to GET and HEAD requests on any non-root resource."
    if (storage?.path !== identifier.path && !this.identifierStrategy.isRootContainer(identifier)) {
      const parent = this.identifierStrategy.getParentContainer(identifier);
      addHeader(response, 'Link', `<${parent.path}>; rel="up"`);
    }

    const type = isContainerIdentifier(identifier) ? LWS.Container : LWS.DataResource;
    if (!metadata.has(RDF.terms.type, type)) {
      addHeader(response, 'Link', `<${type}>; rel="type"`);
    }

    const linkset = this.linksetStrategy.getAuxiliaryIdentifier(identifier);
    addHeader(response, 'Link', `<${linkset.path}>; rel="linkset"; type="${APPLICATION_LINKSET_JSON}"`);

    // Pagination links of paginated container listings
    for (const [ rel, predicate ] of Object.entries(PAGINATION_RELATIONS)) {
      for (const page of metadata.getAll(predicate)) {
        addHeader(response, 'Link', `<${page.value}>; rel="${rel}"`);
      }
    }
  }

  private async findStorage(identifier: ResourceIdentifier): Promise<ResourceIdentifier | undefined> {
    try {
      return await this.storageStrategy.getStorageIdentifier(identifier);
    } catch {
      this.logger.debug(`No storage found for ${identifier.path}`);
    }
  }
}
