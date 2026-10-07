import { BadRequestHttpError } from './errors/BadRequestHttpError';

/**
 * Characters that are not allowed in a decoded host of a `did:web` identifier,
 * as only a domain name with an optional port is allowed to precede the path.
 */
const HOST_PATTERN = /^[a-z0-9.-]+(?::\d+)?$/iu;

/**
 * Characters that are not allowed in a decoded path segment of a `did:web` identifier.
 */
const PATH_SEGMENT_PATTERN = /^[^/\\?#\s]+$/u;

/**
 * Resolves the URL of the DID document of a `did:web` identifier, as described by "The did:web Method".
 * The method-specific identifier is a host, optionally followed by path segments,
 * where a colon separates the parts and `%3A` encodes the port separator.
 *
 * * `did:web:example.com` resolves to `https://example.com/.well-known/did.json`.
 * * `did:web:example.com:user:alice` resolves to `https://example.com/user/alice/did.json`.
 * * `did:web:example.com%3A3000` resolves to `https://example.com:3000/.well-known/did.json`.
 *
 * Throws a 400 error if the identifier is not a valid `did:web` identifier.
 */
export function didWebDocumentUrl(did: string): string {
  const match = /^did:web:([^:?#]+(?::[^:?#]+)*)$/u.exec(did);
  if (!match) {
    throw new BadRequestHttpError(`${did} is not a valid did:web identifier.`);
  }
  let parts: string[];
  try {
    parts = match[1].split(':').map((part): string => decodeURIComponent(part));
  } catch (error: unknown) {
    throw new BadRequestHttpError(`${did} is not a valid did:web identifier.`, { cause: error });
  }
  const [ host, ...path ] = parts;
  if (!HOST_PATTERN.test(host) || !path.every((segment): boolean => PATH_SEGMENT_PATTERN.test(segment))) {
    throw new BadRequestHttpError(`${did} is not a valid did:web identifier.`);
  }
  const location = path.length === 0 ? '/.well-known/did.json' : `/${path.join('/')}/did.json`;
  return `https://${host}${location}`;
}
