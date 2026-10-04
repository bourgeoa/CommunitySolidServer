import { getLoggerFor } from '../../../logging/LogUtil';
import type { StorageLocationStrategy } from '../../../server/description/StorageLocationStrategy';
import type { HttpResponse } from '../../../server/HttpResponse';
import { addHeader } from '../../../util/HeaderUtil';
import { HTTP, SOLID_ERROR } from '../../../util/Vocabularies';
import type { RepresentationMetadata } from '../../representation/RepresentationMetadata';
import { MetadataWriter } from './MetadataWriter';

/**
 * Adds a `WWW-Authenticate` header to 401 responses that conforms to LWS, §Authorization Server Discovery.
 *
 * "A storage server generating a 401 (Unauthorized) response MUST send a WWW-Authenticate header field
 * containing at least one conforming challenge."
 * The challenge contains the `as_uri` parameter, identifying the authorization server,
 * the `realm` parameter, identifying the storage that contains the target resource,
 * and an `error` parameter in case an invalid token was presented.
 *
 * Additional parameters can be added to the challenge,
 * such as `scope="openid webid"`, which is expected by some Solid clients.
 */
export class LwsWwwAuthMetadataWriter extends MetadataWriter {
  protected readonly logger = getLoggerFor(this);

  private readonly asUri: string;
  private readonly storageStrategy: StorageLocationStrategy;
  private readonly extraParameters: string;

  /**
   * @param asUri - The identifier of the authorization server.
   * @param storageStrategy - Used to find the storage containing the target resource.
   * @param extraParameters - Additional auth-params to append to the challenge, such as `scope="openid webid"`.
   */
  public constructor(asUri: string, storageStrategy: StorageLocationStrategy, extraParameters = '') {
    super();
    this.asUri = asUri;
    this.storageStrategy = storageStrategy;
    this.extraParameters = extraParameters;
  }

  public async handle({ response, metadata }: { response: HttpResponse; metadata: RepresentationMetadata }):
  Promise<void> {
    if (metadata.get(HTTP.terms.statusCodeNumber)?.value !== '401') {
      return;
    }
    const params = [ `as_uri="${this.asUri}"` ];
    const target = metadata.get(SOLID_ERROR.terms.target)?.value;
    if (target) {
      try {
        const storage = await this.storageStrategy.getStorageIdentifier({ path: target });
        params.push(`realm="${storage.path}"`);
      } catch {
        this.logger.debug(`No storage found for ${target}`);
      }
    }
    const error = metadata.get(SOLID_ERROR.terms.bearerError)?.value;
    if (error) {
      params.push(`error="${error}"`);
    }
    if (this.extraParameters.length > 0) {
      params.push(this.extraParameters);
    }
    addHeader(response, 'WWW-Authenticate', `Bearer ${params.join(', ')}`);
  }
}
