import { BasicRepresentation } from '../../http/representation/BasicRepresentation';
import type { Representation } from '../../http/representation/Representation';
import { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import { getLoggerFor } from '../../logging/LogUtil';
import { APPLICATION_JSON, APPLICATION_MERGE_PATCH_JSON } from '../../util/ContentTypes';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { applyJsonMergePatch } from '../../util/JsonMergePatch';
import { readableToString } from '../../util/StreamUtil';
import type { RepresentationPatcherInput } from './RepresentationPatcher';
import { RepresentationPatcher } from './RepresentationPatcher';

/**
 * Parses the body of a JSON Merge Patch request.
 * Throws a 400 error if the body is not valid JSON.
 */
export async function readJsonMergePatch(patch: Representation): Promise<unknown> {
  try {
    return JSON.parse(await readableToString(patch.data)) as unknown;
  } catch (error: unknown) {
    throw new BadRequestHttpError('Invalid JSON Merge Patch document.', { cause: error });
  }
}

/**
 * Checks if a media type is a JSON media type.
 */
export function isJsonMediaType(contentType?: string): boolean {
  return contentType === APPLICATION_JSON || Boolean(contentType && /^[^/]+\/[^/]+\+json$/u.test(contentType));
}

/**
 * Applies JSON Merge Patch (RFC 7386) documents to JSON resources.
 *
 * LWS, §Update resource: "LWS server MUST minimally support JSON Merge Patch (application/merge-patch+json)".
 *
 * In case the target resource does not exist yet, it will be created as an `application/json` resource.
 */
export class JsonMergePatcher extends RepresentationPatcher<Representation> {
  protected readonly logger = getLoggerFor(this);

  public async canHandle({ patch, representation }: RepresentationPatcherInput<Representation>): Promise<void> {
    if (patch.metadata.contentType !== APPLICATION_MERGE_PATCH_JSON) {
      throw new NotImplementedHttpError('Only JSON Merge Patch documents are supported.');
    }
    if (representation && !isJsonMediaType(representation.metadata.contentType)) {
      throw new NotImplementedHttpError('JSON Merge Patch can only be applied to JSON resources.');
    }
  }

  public async handle({ identifier, patch, representation }: RepresentationPatcherInput<Representation>):
  Promise<Representation> {
    const patchDocument = await readJsonMergePatch(patch);

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

    this.logger.debug(`Applying JSON Merge Patch to ${identifier.path}`);
    const result = applyJsonMergePatch(target, patchDocument);
    return new BasicRepresentation(JSON.stringify(result), metadata);
  }
}
