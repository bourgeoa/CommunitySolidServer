/* eslint-disable @typescript-eslint/naming-convention */
import type { TargetExtractor } from '../../http/input/identifier/TargetExtractor';
import { NotFoundHttpError } from '../../util/errors/NotFoundHttpError';
import { ensureTrailingSlash, joinUrl } from '../../util/PathUtil';
import type { HttpHandlerInput } from '../HttpHandler';
import { HttpHandler } from '../HttpHandler';

/**
 * The default path of protected resource metadata documents, relative to the base URL of the server.
 */
export const PROTECTED_RESOURCE_METADATA_PATH = '.well-known/oauth-protected-resource';

/**
 * Returns the URL of the protected resource metadata document of a resource,
 * as described in Section 3.1 of RFC 9728:
 * the well-known path is inserted between the base URL of the server and the rest of the resource URL.
 *
 * @param baseUrl - The base URL of the server.
 * @param resource - The URL of the resource.
 * @param metadataPath - The well-known path, relative to the base URL.
 */
export function getProtectedResourceMetadataUrl(baseUrl: string, resource: string,
  metadataPath = PROTECTED_RESOURCE_METADATA_PATH): string {
  const base = ensureTrailingSlash(baseUrl);
  const metadataBase = joinUrl(base, metadataPath);
  if (!resource.startsWith(base)) {
    return metadataBase;
  }
  const remainder = resource.slice(base.length);
  return remainder.length > 0 ? `${metadataBase}/${remainder}` : metadataBase;
}

/**
 * Arguments for the {@link LwsProtectedResourceMetadataHttpHandler}.
 */
export interface LwsProtectedResourceMetadataHttpHandlerArgs {
  /**
   * The base URL of the server.
   */
  baseUrl: string;
  /**
   * Finds the URL of the request.
   */
  targetExtractor: TargetExtractor;
  /**
   * The issuer identifiers of the authorization servers that issue access tokens for this server.
   */
  authorizationServers: string[];
  /**
   * The path of the metadata documents, relative to the base URL.
   * Defaults to {@link PROTECTED_RESOURCE_METADATA_PATH}.
   */
  metadataPath?: string;
}

/**
 * Serves the OAuth 2.0 Protected Resource Metadata (RFC 9728) documents of the resources on this server,
 * as described in LWS, §Protected Resource Metadata.
 *
 * "This specification extends [RFC9728] as follows: the `authorization_servers` parameter is REQUIRED [...]
 * The `resource` value in a protected resource metadata document identifies the requested resource,
 * not the storage that contains it."
 *
 * A document is served for every URL on this server, whether a resource exists there or not,
 * as clients also need to find an authorization server before creating a resource.
 */
export class LwsProtectedResourceMetadataHttpHandler extends HttpHandler {
  private readonly baseUrl: string;
  private readonly targetExtractor: TargetExtractor;
  private readonly authorizationServers: string[];
  private readonly metadataBase: string;

  public constructor(args: LwsProtectedResourceMetadataHttpHandlerArgs) {
    super();
    this.baseUrl = ensureTrailingSlash(args.baseUrl);
    this.targetExtractor = args.targetExtractor;
    this.authorizationServers = args.authorizationServers;
    this.metadataBase = joinUrl(this.baseUrl, args.metadataPath ?? PROTECTED_RESOURCE_METADATA_PATH);
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const { path } = await this.targetExtractor.handleSafe({ request });
    let resource: string;
    if (path === this.metadataBase || path === `${this.metadataBase}/`) {
      resource = this.baseUrl;
    } else if (path.startsWith(`${this.metadataBase}/`)) {
      resource = `${this.baseUrl}${path.slice(this.metadataBase.length + 1)}`;
    } else {
      throw new NotFoundHttpError();
    }

    const metadata = {
      resource,
      authorization_servers: this.authorizationServers,
      bearer_methods_supported: [ 'header' ],
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(metadata));
  }
}
