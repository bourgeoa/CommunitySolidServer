/* eslint-disable @typescript-eslint/naming-convention */
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../../logging/LogUtil';
import type { StorageLocationStrategy } from '../../server/description/StorageLocationStrategy';
import type { HttpHandlerInput } from '../../server/HttpHandler';
import { HttpHandler } from '../../server/HttpHandler';
import type { HttpResponse } from '../../server/HttpResponse';
import type { ResourceSet } from '../../storage/ResourceSet';
import { APPLICATION_JSON, APPLICATION_X_WWW_FORM_URLENCODED } from '../../util/ContentTypes';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { parseContentType } from '../../util/HeaderUtil';
import { readableToString } from '../../util/StreamUtil';
import type { LwsAccessTokenIssuer } from './LwsAccessTokenIssuer';
import type { SubjectTokenVerifier } from './SubjectTokenVerifier';

/**
 * The grant type of OAuth 2.0 Token Exchange.
 */
export const GRANT_TYPE_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';

/**
 * An OAuth 2.0 error, as described in Section 5.2 of RFC 6749.
 */
class OAuthError extends Error {
  public readonly error: string;

  public constructor(error: string, description: string) {
    super(description);
    this.error = error;
  }
}

/**
 * Arguments for the {@link LwsTokenHttpHandler}.
 */
export interface LwsTokenHttpHandlerArgs {
  /**
   * Issues the access tokens.
   */
  issuer: LwsAccessTokenIssuer;
  /**
   * Validates the subject tokens. Usually a combination of one verifier per supported authentication suite.
   */
  verifier: SubjectTokenVerifier;
  /**
   * Used to verify that the requested resource is a storage on this server.
   */
  storageStrategy: StorageLocationStrategy;
  /**
   * Used to verify that the requested storage exists.
   */
  resourceSet: ResourceSet;
}

/**
 * The token endpoint of the LWS authorization server.
 *
 * Supports the OAuth 2.0 Token Exchange grant type (RFC 8693) as described in LWS, §Token Exchange:
 * a client presents a subject token, such as an authentication credential,
 * and receives an access token for the storage identified by the `resource` parameter.
 *
 * Only storages hosted by this server are accepted as resource:
 * "The authorization server MUST reject any request in which the resource parameter identifies
 * an unknown or untrusted storage."
 *
 * Errors are returned as described in Section 5.2 of RFC 6749.
 */
export class LwsTokenHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly issuer: LwsAccessTokenIssuer;
  private readonly verifier: SubjectTokenVerifier;
  private readonly storageStrategy: StorageLocationStrategy;
  private readonly resourceSet: ResourceSet;

  public constructor(args: LwsTokenHttpHandlerArgs) {
    super();
    this.issuer = args.issuer;
    this.verifier = args.verifier;
    this.storageStrategy = args.storageStrategy;
    this.resourceSet = args.resourceSet;
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    try {
      const contentType = request.headers['content-type'];
      if (!contentType || parseContentType(contentType).value !== APPLICATION_X_WWW_FORM_URLENCODED) {
        throw new OAuthError('invalid_request', `Token requests need to use ${APPLICATION_X_WWW_FORM_URLENCODED}.`);
      }
      const params = new URLSearchParams(await readableToString(request));
      const body = await this.exchange(params);
      this.writeJson(response, 200, body);
    } catch (error: unknown) {
      if (error instanceof OAuthError) {
        this.logger.warn(`Rejected token request: ${error.message}`);
        this.writeJson(response, 400, { error: error.error, error_description: error.message });
      } else {
        throw error;
      }
    }
  }

  /**
   * Validates the token request and issues an access token.
   */
  protected async exchange(params: URLSearchParams): Promise<Record<string, unknown>> {
    const grantType = this.getParameter(params, 'grant_type');
    if (grantType !== GRANT_TYPE_TOKEN_EXCHANGE) {
      throw new OAuthError('unsupported_grant_type', `Only the ${GRANT_TYPE_TOKEN_EXCHANGE} grant type is supported.`);
    }
    const resource = this.getParameter(params, 'resource');
    const token = this.getParameter(params, 'subject_token');
    const tokenType = this.getParameter(params, 'subject_token_type');
    await this.verifyStorage(resource);

    let subject: Awaited<ReturnType<SubjectTokenVerifier['handle']>>;
    try {
      subject = await this.verifier.handleSafe({ token, tokenType, audience: this.issuer.issuer });
    } catch (error: unknown) {
      if (NotImplementedHttpError.isInstance(error)) {
        throw new OAuthError('invalid_request', `Unsupported subject token: ${error.message}`);
      }
      throw new OAuthError('invalid_request', `Invalid subject token: ${createErrorMessage(error)}`);
    }

    const accessToken = await this.issuer.issue(subject.subject, subject.client, resource);
    this.logger.info(`Issued an access token for ${resource} to ${subject.subject} using client ${subject.client}`);
    return {
      access_token: accessToken,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      expires_in: this.issuer.lifetime,
    };
  }

  /**
   * Returns the single value of a required parameter.
   */
  private getParameter(params: URLSearchParams, name: string): string {
    const values = params.getAll(name);
    if (values.length !== 1 || values[0].length === 0) {
      throw new OAuthError('invalid_request', `The ${name} parameter is required and must have a single value.`);
    }
    return values[0];
  }

  /**
   * Verifies the given URI identifies an existing storage on this server.
   */
  private async verifyStorage(resource: string): Promise<void> {
    const identifier: ResourceIdentifier = { path: resource };
    let valid = false;
    try {
      const storage = await this.storageStrategy.getStorageIdentifier(identifier);
      valid = storage.path === resource && await this.resourceSet.hasResource(storage);
    } catch {
      // Not a resource on this server
    }
    if (!valid) {
      throw new OAuthError('invalid_target', `${resource} is not a storage known to this authorization server.`);
    }
  }

  private writeJson(response: HttpResponse, status: number, body: Record<string, unknown>): void {
    response.writeHead(status, {
      'content-type': APPLICATION_JSON,
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });
    response.end(JSON.stringify(body));
  }
}
