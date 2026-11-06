import { getLoggerFor } from '../../../logging/LogUtil';
import { getProtectedResourceMetadataUrl } from '../../../server/description/LwsProtectedResourceMetadataHttpHandler';
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
 * containing at least one conforming challenge. A conforming challenge MUST include the `resource_metadata`
 * parameter defined in Section 5.1 of [RFC9728], whose value is the URL of the protected resource metadata document
 * for the requested resource."
 * Next to `resource_metadata`, the challenge contains the `as_uri` parameter, identifying the authorization server,
 * the `realm` parameter, identifying the storage that contains the target resource,
 * and an `error` parameter in case an invalid token was presented.
 * The `as_uri` and `realm` parameters are kept for clients of earlier drafts.
 *
 * Additional parameters can be added to the challenge,
 * such as `scope="openid webid"`, which is expected by some Solid clients.
 */
export class LwsWwwAuthMetadataWriter extends MetadataWriter {
  protected readonly logger = getLoggerFor(this);

  private readonly asUri: string;
  private readonly storageStrategy: StorageLocationStrategy;
  private readonly extraParameters: string;
  private readonly baseUrl?: string;
  private readonly metadataPath?: string;

  /**
   * @param asUri - The identifier of the authorization server.
   * @param storageStrategy - Used to find the storage containing the target resource.
   * @param extraParameters - Additional auth-params to append to the challenge, such as `scope="openid webid"`.
   * @param baseUrl - The base URL of the server. Needed to add the `resource_metadata` parameter.
   * @param metadataPath - The path of the protected resource metadata documents, relative to the base URL.
   */
  public constructor(asUri: string, storageStrategy: StorageLocationStrategy, extraParameters = '', baseUrl?: string,
    metadataPath?: string) {
    super();
    this.asUri = asUri;
    this.storageStrategy = storageStrategy;
    this.extraParameters = extraParameters;
    this.baseUrl = baseUrl;
    this.metadataPath = metadataPath;
  }

  public async handle({ response, metadata }: { response: HttpResponse; metadata: RepresentationMetadata }):
  Promise<void> {
    if (metadata.get(HTTP.terms.statusCodeNumber)?.value !== '401') {
      return;
    }
    const params: string[] = [];
    const target = metadata.get(SOLID_ERROR.terms.target)?.value;
    if (target && this.baseUrl) {
      params.push(`resource_metadata="${getProtectedResourceMetadataUrl(this.baseUrl, target, this.metadataPath)}"`);
    }
    params.push(`as_uri="${this.asUri}"`);
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
