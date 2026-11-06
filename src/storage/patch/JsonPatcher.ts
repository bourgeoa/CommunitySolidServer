import { BasicRepresentation } from '../../http/representation/BasicRepresentation';
import type { Representation } from '../../http/representation/Representation';
import { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import { getLoggerFor } from '../../logging/LogUtil';
import { APPLICATION_JSON } from '../../util/ContentTypes';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { applyJsonPatchDocument, JSON_PATCH_TYPES } from '../../util/JsonPatch';
import { readableToString } from '../../util/StreamUtil';
import type { RepresentationPatcherInput } from './RepresentationPatcher';
import { RepresentationPatcher } from './RepresentationPatcher';

/**
 * Parses the body of a JSON Patch or JSON Merge Patch request.
 * Throws a 400 error if the body is not valid JSON.
 */
export async function readJsonPatchDocument(patch: Representation): Promise<unknown> {
  try {
    return JSON.parse(await readableToString(patch.data)) as unknown;
  } catch (error: unknown) {
    throw new BadRequestHttpError('Invalid JSON patch document.', { cause: error });
  }
}

/**
 * Throws a 501 error if the patch is not a JSON Patch or JSON Merge Patch document.
 */
export function assertJsonPatchType(patch: Representation): void {
  if (!JSON_PATCH_TYPES.includes(patch.metadata.contentType!)) {
    throw new NotImplementedHttpError('Only JSON Patch and JSON Merge Patch documents are supported.');
  }
}

/**
 * Checks if a media type is a JSON media type.
 */
export function isJsonMediaType(contentType?: string): boolean {
  return contentType === APPLICATION_JSON || Boolean(contentType && /^[^/]+\/[^/]+\+json$/u.test(contentType));
}

/**
 * Applies JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7386) documents to JSON resources.
 *
 * LWS, §Update resource: "LWS server MUST minimally support JSON Patch (`application/json-patch+json`)".
 * JSON Merge Patch is also supported, as earlier drafts required it.
 *
 * In case the target resource does not exist yet, it will be created as an `application/json` resource.
 */
export class JsonPatcher extends RepresentationPatcher<Representation> {
  protected readonly logger = getLoggerFor(this);

  public async canHandle({ patch, representation }: RepresentationPatcherInput<Representation>): Promise<void> {
    assertJsonPatchType(patch);
    if (representation && !isJsonMediaType(representation.metadata.contentType)) {
      throw new NotImplementedHttpError('JSON patches can only be applied to JSON resources.');
    }
  }

  public async handle({ identifier, patch, representation }: RepresentationPatcherInput<Representation>):
  Promise<Representation> {
    const patchDocument = await readJsonPatchDocument(patch);

    let target: unknown;
    let metadata: RepresentationMetadata;
    if (representation) {
      const text = await readableToString(representation.data);
      try {
        target = text.length > 0 ? JSON.parse(text) : undefined;
      } catch (error: unknown) {
        throw new BadRequestHttpError('The target resource does not contain valid JSON.', { cause: error });
      }
      ({ metadata } = representation);
    } else {
      metadata = new RepresentationMetadata(identifier, APPLICATION_JSON);
    }

    this.logger.debug(`Applying ${patch.metadata.contentType} to ${identifier.path}`);
    const result = applyJsonPatchDocument(target, patchDocument, patch.metadata.contentType);
    return new BasicRepresentation(JSON.stringify(result), metadata);
  }
}
