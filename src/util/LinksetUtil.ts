import type { NamedNode, Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { UnprocessableEntityHttpError } from './errors/UnprocessableEntityHttpError';
import { isJsonObject } from './JsonMergePatch';
import { LDP, RDF } from './Vocabularies';

/**
 * Namespace of the IANA link relation registry,
 * used to convert registered relation types to IRIs.
 */
export const IANA_RELATION_NAMESPACE = 'http://www.iana.org/assignments/relation/';

/**
 * A target object in a linkset document, as defined in RFC 9264.
 */
export interface LinksetTarget {
  href: string;
  [key: string]: unknown;
}

/**
 * A link context object in a linkset document, as defined in RFC 9264.
 */
export type LinksetContext = { anchor?: string } & Record<string, LinksetTarget[] | string | undefined>;

/**
 * A linkset document in the `application/linkset+json` format, as defined in RFC 9264.
 */
export interface LinksetDocument {
  linkset: LinksetContext[];
}

/**
 * A single link: a relation between a context and a target.
 */
export interface Link {
  anchor: string;
  rel: string;
  href: string;
}

const RELATION_PREDICATES: Record<string, string> = {
  type: RDF.type,
  item: LDP.contains,
};

const PREDICATE_RELATIONS: Record<string, string> = Object.fromEntries(
  Object.entries(RELATION_PREDICATES).map(([ rel, predicate ]): [string, string] => [ predicate, rel ]),
);

/**
 * Converts an RDF predicate to a link relation type.
 * Predicates in the IANA link relation namespace, and a few well-known predicates,
 * are converted to registered relation types, all others are used as extension relation types.
 */
export function predicateToRelation(predicate: string): string {
  if (PREDICATE_RELATIONS[predicate]) {
    return PREDICATE_RELATIONS[predicate];
  }
  if (predicate.startsWith(IANA_RELATION_NAMESPACE) && predicate.length > IANA_RELATION_NAMESPACE.length) {
    return predicate.slice(IANA_RELATION_NAMESPACE.length);
  }
  return predicate;
}

/**
 * Converts a link relation type to an RDF predicate.
 * This is the inverse of {@link predicateToRelation}.
 */
export function relationToPredicate(rel: string): string {
  if (RELATION_PREDICATES[rel]) {
    return RELATION_PREDICATES[rel];
  }
  // Extension relation types are URIs, registered relation types never contain a colon
  if (rel.includes(':')) {
    return rel;
  }
  return `${IANA_RELATION_NAMESPACE}${rel.toLowerCase()}`;
}

/**
 * Converts a quad to a link, if possible.
 * Only quads with named nodes as subject and object can be represented as links.
 */
export function quadToLink(quad: Quad): Link | undefined {
  if (quad.subject.termType !== 'NamedNode' || quad.object.termType !== 'NamedNode') {
    return;
  }
  return { anchor: quad.subject.value, rel: predicateToRelation(quad.predicate.value), href: quad.object.value };
}

/**
 * Converts a link to a quad.
 */
export function linkToQuad(link: Link): Quad {
  return DataFactory.quad(
    DataFactory.namedNode(link.anchor),
    DataFactory.namedNode(relationToPredicate(link.rel)) as NamedNode,
    DataFactory.namedNode(link.href),
  );
}

/**
 * Serializes the given links as a linkset document.
 * Links are grouped by anchor, and the anchors are ordered so that the `primary` anchor comes first.
 */
export function linksToLinkset(links: Link[], primary?: string): LinksetDocument {
  const contexts = new Map<string, Map<string, Set<string>>>();
  if (primary) {
    contexts.set(primary, new Map());
  }
  for (const { anchor, rel, href } of links) {
    let relations = contexts.get(anchor);
    if (!relations) {
      relations = new Map();
      contexts.set(anchor, relations);
    }
    let targets = relations.get(rel);
    if (!targets) {
      targets = new Set();
      relations.set(rel, targets);
    }
    targets.add(href);
  }

  const linkset: LinksetContext[] = [];
  for (const [ anchor, relations ] of contexts) {
    const context: LinksetContext = { anchor };
    for (const [ rel, targets ] of relations) {
      context[rel] = [ ...targets ].map((href): LinksetTarget => ({ href }));
    }
    linkset.push(context);
  }
  return { linkset };
}

/**
 * Extracts all links from a linkset document.
 * Relative anchors and targets are resolved against the given base URL.
 * Throws a 422 error if the document is not a valid linkset document.
 *
 * @param document - The parsed JSON document.
 * @param baseUrl - The base URL to resolve relative references against.
 * @param defaultAnchor - The anchor to use for link context objects without anchor.
 */
export function linksetToLinks(document: unknown, baseUrl: string, defaultAnchor: string): Link[] {
  if (!isJsonObject(document) || !Array.isArray(document.linkset)) {
    throw new UnprocessableEntityHttpError('A linkset document must be an object with a linkset array.');
  }

  const links: Link[] = [];
  for (const context of document.linkset as unknown[]) {
    if (!isJsonObject(context)) {
      throw new UnprocessableEntityHttpError('Every entry of a linkset must be a link context object.');
    }
    const { anchor: rawAnchor, ...relations } = context;
    if (rawAnchor !== undefined && typeof rawAnchor !== 'string') {
      throw new UnprocessableEntityHttpError('The anchor of a link context object must be a string.');
    }
    const anchor = rawAnchor === undefined ? defaultAnchor : resolve(rawAnchor, baseUrl);
    for (const [ rel, targets ] of Object.entries(relations)) {
      if (!Array.isArray(targets)) {
        throw new UnprocessableEntityHttpError(`The targets of relation ${rel} must be an array.`);
      }
      for (const target of targets as unknown[]) {
        if (!isJsonObject(target) || typeof target.href !== 'string') {
          throw new UnprocessableEntityHttpError(`Every target of relation ${rel} must have an href.`);
        }
        links.push({ anchor, rel, href: resolve(target.href, baseUrl) });
      }
    }
  }
  return links;
}

function resolve(reference: string, baseUrl: string): string {
  try {
    return new URL(reference, baseUrl).href;
  } catch (error: unknown) {
    throw new UnprocessableEntityHttpError(`Invalid URI reference ${reference}.`, { cause: error });
  }
}
