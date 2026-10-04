import type { HttpRequest } from '../../../server/HttpRequest';
import { SOLID_HTTP } from '../../../util/Vocabularies';
import type { RepresentationMetadata } from '../../representation/RepresentationMetadata';
import { MetadataParser } from './MetadataParser';

/**
 * Parses the `Depth` header (RFC 4918), which LWS clients use to request a recursive delete of a container.
 * Only the `infinity` value is stored, as that is the only value that changes the behaviour.
 */
export class DepthParser extends MetadataParser {
  public async handle(input: { request: HttpRequest; metadata: RepresentationMetadata }): Promise<void> {
    const depth = input.request.headers.depth;
    if (typeof depth === 'string' && depth.trim().toLowerCase() === 'infinity') {
      input.metadata.set(SOLID_HTTP.terms.depth, 'infinity');
    }
  }
}
