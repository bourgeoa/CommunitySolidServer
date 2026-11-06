/* eslint-disable @typescript-eslint/naming-convention */
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { DataFactory, Writer } from 'n3';
import { LWS_PAGE_UNIT } from '../../http/input/preferences/LwsPagePreferenceParser';
import { BasicRepresentation } from '../../http/representation/BasicRepresentation';
import type { Representation } from '../../http/representation/Representation';
import { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import type { ValuePreferences } from '../../http/representation/RepresentationPreferences';
import {
  APPLICATION_JSON,
  APPLICATION_LD_JSON,
  APPLICATION_LWS_JSON,
  INTERNAL_QUADS,
  TEXT_TURTLE,
} from '../../util/ContentTypes';
import { ContentType } from '../../util/Header';
import { NotFoundHttpError } from '../../util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { IANA_RELATION_NAMESPACE } from '../../util/LinksetUtil';
import { isContainerPath } from '../../util/PathUtil';
import { readableToQuads } from '../../util/StreamUtil';
import { CONTENT_TYPE, CONTENT_TYPE_TERM, DC, IANA, LDP, LWS, POSIX, RDF, SCHEMA, XSD } from '../../util/Vocabularies';
import { BaseTypedRepresentationConverter } from './BaseTypedRepresentationConverter';
import { cleanPreferences, getConversionTarget, getTypeWeight, matchesMediaType } from './ConversionUtil';
import type { RepresentationConverterArgs } from './RepresentationConverter';

/**
 * The JSON-LD context of LWS container representations.
 */
export const LWS_CONTEXT = 'https://www.w3.org/ns/lws/v1';

/**
 * The URI of the LWS profile, which can be requested with the `profile` parameter of RDF media types.
 */
export const LWS_PROFILE = 'https://www.w3.org/ns/lws/v1';

/**
 * The RDF media types in which the LWS profile is produced by default.
 */
export const LWS_PROFILE_TYPES = [
  APPLICATION_LD_JSON,
  TEXT_TURTLE,
  'application/n-triples',
  'application/trig',
  'application/n-quads',
];

/**
 * The link relations used for pagination links, as IANA relation URIs.
 */
export const PAGINATION_RELATIONS = {
  first: DataFactory.namedNode(`${IANA_RELATION_NAMESPACE}first`),
  last: DataFactory.namedNode(`${IANA_RELATION_NAMESPACE}last`),
  next: DataFactory.namedNode(`${IANA_RELATION_NAMESPACE}next`),
  prev: DataFactory.namedNode(`${IANA_RELATION_NAMESPACE}prev`),
};

/**
 * A contained resource description as defined by the LWS container representation.
 */
export interface LwsContainedResource {
  id: string;
  type: string | string[];
  format?: string;
  size?: number;
  modified?: string;
}

/**
 * An LWS container representation.
 */
export interface LwsContainerRepresentation {
  '@context': string;
  id: string;
  type: 'Container';
  totalItems: number;
  items: LwsContainedResource[];
}

/**
 * Converts the internal quad representation of a container
 * into an LWS container representation (`application/lws+json`).
 *
 * LWS, §Media Type Equivalence: "For container representations, the media types `application/lws+json`,
 * `application/ld+json`, and `application/json` are equivalent: the response body is the same JSON-LD document
 * [...] and only the `Content-Type` response header varies."
 *
 * Which of these media types are produced, and with which weights, can be configured through `outputPreferences`.
 * This allows a server that also serves Solid clients to keep producing the LDP JSON-LD representation
 * for `application/ld+json` requests.
 *
 * This converter is designed to be placed in front of a more generic converter,
 * which handles all requests this converter rejects.
 * Two options determine which requests are accepted:
 *  * In case `strictPreferences` is true, a request is only accepted
 *    if none of the explicitly requested media types it can not produce have a higher weight
 *    than the best type it can produce.
 *  * In case `requireExplicit` is true, a request is only accepted
 *    if one of the media types it can produce is explicitly requested,
 *    so requests that only match through wildcards are rejected.
 *    This allows servers to keep a different default representation for containers.
 *
 * Clients can also request the LWS profile in one of the `profileTypes`, such as
 * `Accept: text/turtle; profile="https://www.w3.org/ns/lws/v1"`.
 * LWS, §Content Negotiation: "If the server selects such a media type, the response MUST conform to the LWS profile,
 * that is, it MUST be RDF isomorphic to the `application/lws+json` representation,
 * and its `Content-Type` MUST include the same `profile` parameter."
 * Such a request is accepted if no other media type has a higher weight,
 * whatever the values of `strictPreferences` and `requireExplicit`.
 *
 * Containers with more members than the `pageSize` are paginated, as described in LWS, §Pagination.
 * Pagination links to the other pages are added to the metadata, using IANA relation URIs as predicates.
 * The requested page is determined by range preferences with the {@link LWS_PAGE_UNIT} unit.
 */
export class ContainerToLwsJsonConverter extends BaseTypedRepresentationConverter {
  private readonly strictPreferences: boolean;
  private readonly requireExplicit: boolean;
  private readonly pageSize: number;
  private readonly pageParameter: string;
  private readonly profileTypes: string[];

  /**
   * @param options - Options for the converter.
   * @param options.outputPreferences - The produced media types and their weights.
   * @param options.strictPreferences - Whether explicitly preferred types this converter can not produce win.
   * @param options.requireExplicit - Whether one of the produced types needs to be explicitly requested.
   * @param options.pageSize - The maximum number of items on a page. Defaults to 1000.
   * @param options.pageParameter - The query parameter used in page URIs. Defaults to `page`.
   * @param options.profileTypes - The RDF media types in which the LWS profile can be requested.
   *                               Defaults to {@link LWS_PROFILE_TYPES}.
   */
  public constructor(options: {
    outputPreferences?: Record<string, number>;
    strictPreferences?: boolean;
    requireExplicit?: boolean;
    pageSize?: number;
    pageParameter?: string;
    profileTypes?: string[];
  } = {}) {
    super(INTERNAL_QUADS, options.outputPreferences ?? {
      [APPLICATION_LWS_JSON]: 1,
      [APPLICATION_LD_JSON]: 1,
      [APPLICATION_JSON]: 1,
    });
    this.strictPreferences = options.strictPreferences ?? false;
    this.requireExplicit = options.requireExplicit ?? false;
    this.pageSize = options.pageSize ?? 1000;
    this.pageParameter = options.pageParameter ?? 'page';
    this.profileTypes = options.profileTypes ?? LWS_PROFILE_TYPES;
  }

  public async canHandle(args: RepresentationConverterArgs): Promise<void> {
    if (!isContainerPath(args.identifier.path)) {
      throw new NotImplementedHttpError('Can only convert containers.');
    }
    // No conversion is needed if the internal representation is acceptable
    if (getTypeWeight(INTERNAL_QUADS, cleanPreferences(args.preferences.type)) > 0) {
      throw new NotImplementedHttpError('Internal quads are acceptable so no conversion is needed.');
    }
    if (this.getProfileType(args.preferences)) {
      return;
    }
    await super.canHandle(args);
    const outputTypes = await this.outputTypes;
    if (this.requireExplicit) {
      const preferred = args.preferences.type ?? {};
      if (!Object.keys(outputTypes).some((type): boolean => (preferred[type] ?? 0) > 0)) {
        throw new NotImplementedHttpError('The LWS container representation was not explicitly requested.');
      }
    }
    if (this.strictPreferences) {
      this.checkStrictPreferences(outputTypes, args.preferences.type);
    }
  }

  public async handle({ identifier, representation, preferences }: RepresentationConverterArgs):
  Promise<Representation> {
    const profileType = this.getProfileType(preferences);
    // Prefer the LWS media type in case multiple of the equivalent types match equally well
    const contentType = profileType ?? getConversionTarget(await this.outputTypes, preferences.type) ??
      APPLICATION_LWS_JSON;

    const store = await readableToQuads(representation.data);
    const container = identifier.path;

    const children = store.getObjects(container, LDP.terms.contains, null)
      .map((child): string => child.value)
      .sort();

    const metadata = new RepresentationMetadata(representation.metadata, { [CONTENT_TYPE]: contentType });
    const pageChildren = this.paginate(container, children, metadata, preferences.range);
    const items = pageChildren.map((child): LwsContainedResource =>
      this.describeChild(child, store.getQuads(child, null, null, null)));

    const result: LwsContainerRepresentation = {
      '@context': LWS_CONTEXT,
      id: container,
      type: 'Container',
      totalItems: children.length,
      items,
    };

    if (!profileType) {
      return new BasicRepresentation(JSON.stringify(result), metadata);
    }
    metadata.contentTypeObject = new ContentType(profileType, { profile: LWS_PROFILE });
    if (profileType === APPLICATION_LD_JSON) {
      return new BasicRepresentation(JSON.stringify(result), metadata);
    }
    return new BasicRepresentation(this.serializeProfile(result, profileType), metadata);
  }

  /**
   * Returns the media type in which the LWS profile was requested,
   * in case no other media type has a higher weight.
   */
  protected getProfileType(preferences: RepresentationConverterArgs['preferences']): string | undefined {
    const profiled = preferences.profiles?.[LWS_PROFILE] ?? {};
    let best: { type: string; weight: number } | undefined;
    for (const type of this.profileTypes) {
      const weight = profiled[type] ?? 0;
      if (weight > (best?.weight ?? 0)) {
        best = { type, weight };
      }
    }
    if (!best) {
      return;
    }
    const maxWeight = Math.max(...Object.values(preferences.type ?? {}));
    return best.weight >= maxWeight ? best.type : undefined;
  }

  /**
   * Serializes the RDF that the LWS container representation encodes, as defined by the LWS JSON-LD context,
   * in the given RDF media type.
   */
  protected serializeProfile(container: LwsContainerRepresentation, contentType: string): string {
    const { namedNode, literal, quad } = DataFactory;
    const subject = namedNode(container.id);
    const quads: Quad[] = [
      quad(subject, RDF.terms.type, LWS.terms.Container),
      quad(subject, LWS.terms.totalItems, literal(`${container.totalItems}`, XSD.terms.integer)),
    ];
    for (const item of container.items) {
      const child = namedNode(item.id);
      quads.push(quad(subject, LWS.terms.items, child));
      // This converter only generates items with a single type
      quads.push(quad(child, RDF.terms.type, item.type === 'Container' ? LWS.terms.Container : LWS.terms.DataResource));
      if (item.format) {
        quads.push(quad(child, DC.terms.format, literal(item.format)));
      }
      if (item.size !== undefined) {
        quads.push(quad(child, SCHEMA.terms.size, literal(`${item.size}`, XSD.terms.long)));
      }
      if (item.modified) {
        quads.push(quad(child, DC.terms.modified, literal(item.modified, XSD.terms.dateTime)));
      }
    }
    const writer = new Writer({ format: contentType });
    writer.addQuads(quads);
    let result = '';
    writer.end((error, output: string): void => {
      result = output;
    });
    return result;
  }

  /**
   * Returns the children on the requested page, and adds the pagination links to the metadata.
   * Containers with at most `pageSize` children are not paginated.
   */
  protected paginate(
    container: string,
    children: string[],
    metadata: RepresentationMetadata,
    range?: RepresentationConverterArgs['preferences']['range'],
  ): string[] {
    const page = range?.unit === LWS_PAGE_UNIT ? range.parts[0].start : 1;
    if (children.length <= this.pageSize) {
      if (page > 1) {
        throw new NotFoundHttpError(`Page ${page} of ${container} does not exist.`);
      }
      return children;
    }

    const pageCount = Math.ceil(children.length / this.pageSize);
    if (page > pageCount) {
      throw new NotFoundHttpError(`Page ${page} of ${container} does not exist.`);
    }
    const pageUri = (index: number): NamedNode => {
      const url = new URL(container);
      url.searchParams.set(this.pageParameter, `${index}`);
      return DataFactory.namedNode(url.href);
    };
    // "rel="first": The URI of the first page of results. MUST be present on paginated responses."
    metadata.add(PAGINATION_RELATIONS.first, pageUri(1));
    metadata.add(PAGINATION_RELATIONS.last, pageUri(pageCount));
    if (page > 1) {
      metadata.add(PAGINATION_RELATIONS.prev, pageUri(page - 1));
    }
    if (page < pageCount) {
      metadata.add(PAGINATION_RELATIONS.next, pageUri(page + 1));
    }
    return children.slice((page - 1) * this.pageSize, page * this.pageSize);
  }

  /**
   * Generates the LWS description of a single contained resource based on the quads describing it.
   */
  protected describeChild(id: string, quads: Quad[]): LwsContainedResource {
    const isContainer = isContainerPath(id);
    const description: LwsContainedResource = { id, type: isContainer ? 'Container' : 'DataResource' };

    if (!isContainer) {
      const format = this.findFormat(quads);
      // LWS: "`format` [...] MUST be present for DataResources."
      description.format = format ?? 'application/octet-stream';
    }

    const size = this.findObject(quads, POSIX.terms.size);
    if (size && !isContainer && /^\d+$/u.test(size.value)) {
      description.size = Number.parseInt(size.value, 10);
    }

    const modified = this.findObject(quads, DC.terms.modified);
    if (modified) {
      const date = new Date(modified.value);
      if (!Number.isNaN(date.getTime())) {
        description.modified = date.toISOString();
      }
    }

    return description;
  }

  /**
   * Determines the media type of a contained resource.
   * Depending on the backend this is either stored as a content-type triple,
   * or as an IANA media type class.
   */
  private findFormat(quads: Quad[]): string | undefined {
    const contentType = this.findObject(quads, CONTENT_TYPE_TERM);
    if (contentType) {
      return contentType.value;
    }
    for (const quad of quads) {
      if (quad.predicate.equals(RDF.terms.type) && quad.object.value.startsWith(IANA.namespace)) {
        const match = /^(.+)#Resource$/u.exec(quad.object.value.slice(IANA.namespace.length));
        if (match) {
          return match[1];
        }
      }
    }
  }

  private findObject(quads: Quad[], predicate: NamedNode): Term | undefined {
    return quads.find((quad): boolean => quad.predicate.equals(predicate))?.object;
  }

  /**
   * Throws an error in case one of the explicitly requested types, which this converter can not produce,
   * has a higher weight than the best type this converter can produce.
   */
  private checkStrictPreferences(outputTypes: ValuePreferences, preferred: ValuePreferences = {}): void {
    const ownWeight = Math.max(0, ...Object.keys(outputTypes).map((type): number =>
      getTypeWeight(type, preferred) * outputTypes[type]));
    for (const [ type, weight ] of Object.entries(preferred)) {
      if (type.includes('*')) {
        continue;
      }
      const supported = Object.keys(outputTypes).some((output): boolean => matchesMediaType(output, type));
      if (!supported && weight > ownWeight) {
        throw new NotImplementedHttpError(`${type} is preferred over the LWS container representation.`);
      }
    }
  }
}
