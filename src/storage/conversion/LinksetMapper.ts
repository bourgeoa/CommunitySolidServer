import type { Quad } from '@rdfjs/types';
import type { AuxiliaryIdentifierStrategy } from '../../http/auxiliary/AuxiliaryIdentifierStrategy';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import type { StorageLocationStrategy } from '../../server/description/StorageLocationStrategy';
import type { IdentifierStrategy } from '../../util/identifiers/IdentifierStrategy';
import type { Link } from '../../util/LinksetUtil';
import { IANA_RELATION_NAMESPACE, linkToQuad, quadToLink, relationToPredicate } from '../../util/LinksetUtil';
import { isContainerIdentifier } from '../../util/PathUtil';
import { IANA, LDP, LWS, PIM, RDF } from '../../util/Vocabularies';

const INTERNAL_NAMESPACE = 'urn:npm:solid:community-server:';

/**
 * Namespaces of types that are managed by the server.
 */
const SERVER_TYPE_NAMESPACES = [ LDP.namespace, LWS.namespace, PIM.namespace, IANA.namespace ];

/**
 * Link relations whose values are computed by the server and can never be set by clients.
 */
const COMPUTED_RELATIONS = new Set([
  `${IANA_RELATION_NAMESPACE}up`,
  `${IANA_RELATION_NAMESPACE}linkset`,
  LWS.storage,
]);

/**
 * Maps between the RDF metadata of a resource, as stored by the server,
 * and the links in its LWS linkset resource.
 *
 * Every RDF triple of which the subject is the described resource and the object is an IRI
 * is represented as a link.
 * Triples with literal values, such as the modification date, can not be represented in a linkset;
 * they are not shown and are always preserved when the linkset is modified.
 *
 * Some links are managed by the server: containment (`item`), the parent container (`up`),
 * and the server types of the resource (`type`).
 * These are always shown, but changes to them by clients are ignored.
 */
export class LinksetMapper {
  private readonly metadataStrategy: AuxiliaryIdentifierStrategy;
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly storageStrategy?: StorageLocationStrategy;

  /**
   * @param metadataStrategy - Strategy used to determine the subject of a linkset resource.
   * @param identifierStrategy - Strategy used to determine the parent container of a resource.
   * @param storageStrategy - Strategy used to determine if a resource is a storage root,
   *                          which has no parent container.
   */
  public constructor(
    metadataStrategy: AuxiliaryIdentifierStrategy,
    identifierStrategy: IdentifierStrategy,
    storageStrategy?: StorageLocationStrategy,
  ) {
    this.metadataStrategy = metadataStrategy;
    this.identifierStrategy = identifierStrategy;
    this.storageStrategy = storageStrategy;
  }

  /**
   * Returns the identifier of the resource described by the given linkset resource.
   */
  public getSubject(linkset: ResourceIdentifier): ResourceIdentifier {
    return this.metadataStrategy.getSubjectIdentifier(linkset);
  }

  /**
   * Generates all links that should be shown in the linkset of the given linkset resource.
   *
   * @param linkset - Identifier of the linkset resource.
   * @param quads - The stored metadata of the subject resource.
   */
  public async toLinks(linkset: ResourceIdentifier, quads: Iterable<Quad>): Promise<Link[]> {
    const subject = this.getSubject(linkset);
    const links: Link[] = [];
    for (const quad of quads) {
      if (quad.subject.value === subject.path && !quad.predicate.value.startsWith(INTERNAL_NAMESPACE)) {
        const link = quadToLink(quad);
        if (link) {
          links.push(link);
        }
      }
    }

    // LWS, §Metadata: "we consider the link to its parent container resource to be part of the metadata"
    if (!await this.isStorageRoot(subject)) {
      const parent = this.identifierStrategy.getParentContainer(subject);
      links.push({ anchor: subject.path, rel: 'up', href: parent.path });
    }
    const type = isContainerIdentifier(subject) ? LWS.Container : LWS.DataResource;
    links.push({ anchor: subject.path, rel: 'type', href: type });

    return links;
  }

  /**
   * Generates the metadata that needs to be stored after a client provided new links for a linkset.
   * Server-managed metadata from the original metadata is always preserved,
   * and server-managed links in the new links are ignored.
   *
   * @param linkset - Identifier of the linkset resource.
   * @param links - The new links provided by the client.
   * @param originalQuads - The currently stored metadata of the subject resource.
   */
  public toQuads(linkset: ResourceIdentifier, links: Link[], originalQuads: Iterable<Quad>): Quad[] {
    const subject = this.getSubject(linkset).path;
    const result: Quad[] = [];
    for (const quad of originalQuads) {
      // Metadata about other subjects can not be shown in the linkset so is also preserved
      if (quad.subject.value !== subject || this.isServerManaged(quad)) {
        result.push(quad);
      }
    }
    for (const link of links) {
      if (COMPUTED_RELATIONS.has(relationToPredicate(link.rel))) {
        continue;
      }
      const quad = linkToQuad(link);
      if (!this.isServerManaged(quad)) {
        result.push(quad);
      }
    }
    return result;
  }

  private async isStorageRoot(identifier: ResourceIdentifier): Promise<boolean> {
    if (this.identifierStrategy.isRootContainer(identifier)) {
      return true;
    }
    if (!this.storageStrategy) {
      return false;
    }
    try {
      return (await this.storageStrategy.getStorageIdentifier(identifier)).path === identifier.path;
    } catch {
      return false;
    }
  }

  /**
   * Determines whether a stored metadata triple is managed by the server,
   * and can therefore not be changed through the linkset.
   */
  private isServerManaged(quad: Quad): boolean {
    if (quad.subject.termType !== 'NamedNode' || quad.object.termType !== 'NamedNode') {
      return true;
    }
    const predicate = quad.predicate.value;
    if (predicate.startsWith(INTERNAL_NAMESPACE) || predicate === LDP.contains) {
      return true;
    }
    return predicate === RDF.type &&
      SERVER_TYPE_NAMESPACES.some((namespace): boolean => quad.object.value.startsWith(namespace));
  }
}
