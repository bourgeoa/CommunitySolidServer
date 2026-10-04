import { fetch } from 'cross-fetch';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import type { TargetExtractor } from '../http/input/identifier/TargetExtractor';
import { RepresentationMetadata } from '../http/representation/RepresentationMetadata';
import { ASYMMETRIC_ALGORITHMS } from '../identity/lws/JwtCredentialUtil';
import type { LwsAccessTokenIssuer } from '../identity/lws/LwsAccessTokenIssuer';
import { getLoggerFor } from '../logging/LogUtil';
import type { StorageLocationStrategy } from '../server/description/StorageLocationStrategy';
import type { HttpRequest } from '../server/HttpRequest';
import { createErrorMessage } from '../util/errors/ErrorUtil';
import { NotImplementedHttpError } from '../util/errors/NotImplementedHttpError';
import { UnauthorizedHttpError } from '../util/errors/UnauthorizedHttpError';
import { matchesAuthorizationScheme } from '../util/HeaderUtil';
import { isJsonObject } from '../util/JsonMergePatch';
import { trimTrailingSlashes } from '../util/PathUtil';
import { SOLID_ERROR } from '../util/Vocabularies';
import type { Credentials } from './Credentials';
import { CredentialsExtractor } from './CredentialsExtractor';

/**
 * Arguments for the {@link LwsAccessTokenExtractor}.
 */
export interface LwsAccessTokenExtractorArgs {
  /**
   * The authorization server of this server.
   */
  issuer: LwsAccessTokenIssuer;
  /**
   * Used to determine the target of the request.
   */
  targetExtractor: TargetExtractor;
  /**
   * Used to determine the storage that contains the target, which needs to be the audience of the token.
   */
  storageStrategy: StorageLocationStrategy;
  /**
   * Identifiers of external LWS authorization servers whose access tokens are also accepted.
   * Their keys are found through the `jwks_uri` of their `/.well-known/lws-configuration` metadata.
   */
  trustedIssuers?: string[];
  /**
   * In case this is true, Bearer tokens that contain a `webid` claim are not handled,
   * so they can be handled by a Solid-OIDC extractor.
   * This allows Solid and LWS access tokens to be used on the same server.
   * Defaults to false.
   */
  skipWebIdTokens?: boolean;
  /**
   * Allowed clock skew in seconds. Defaults to 60.
   */
  clockTolerance?: number;
}

/**
 * Extracts the credentials from an LWS access token, presented as an RFC 6750 Bearer token.
 *
 * Validates the token as described in LWS, §Token Validation by a Storage Server:
 * the signature, the issuer, the audience, which needs to contain exactly one value identifying the storage
 * that contains the target resource, and the temporal claims.
 *
 * Invalid tokens result in a 401 error with an `invalid_token` error code,
 * which can be used to generate the `WWW-Authenticate` header.
 */
export class LwsAccessTokenExtractor extends CredentialsExtractor {
  protected readonly logger = getLoggerFor(this);

  private readonly issuer: LwsAccessTokenIssuer;
  private readonly targetExtractor: TargetExtractor;
  private readonly storageStrategy: StorageLocationStrategy;
  private readonly trustedIssuers: string[];
  private readonly skipWebIdTokens: boolean;
  private readonly clockTolerance: number;
  private readonly keySets = new Map<string, JWTVerifyGetKey>();

  public constructor(args: LwsAccessTokenExtractorArgs) {
    super();
    this.issuer = args.issuer;
    this.targetExtractor = args.targetExtractor;
    this.storageStrategy = args.storageStrategy;
    this.trustedIssuers = args.trustedIssuers ?? [];
    this.skipWebIdTokens = args.skipWebIdTokens ?? false;
    this.clockTolerance = args.clockTolerance ?? 60;
  }

  public async canHandle({ headers: { authorization }}: HttpRequest): Promise<void> {
    if (!matchesAuthorizationScheme('Bearer', authorization)) {
      throw new NotImplementedHttpError('No Bearer Authorization header specified.');
    }
    if (this.skipWebIdTokens) {
      let payload: JWTPayload | undefined;
      try {
        payload = decodeJwt(this.getToken(authorization!));
      } catch {
        // Invalid tokens are rejected in the handle call
      }
      if (payload && typeof payload.webid === 'string') {
        throw new NotImplementedHttpError('Solid-OIDC access tokens are handled by a different extractor.');
      }
    }
  }

  public async handle(request: HttpRequest): Promise<Credentials> {
    const token = this.getToken(request.headers.authorization!);
    let payload: JWTPayload;
    try {
      payload = await this.verify(token);
    } catch (error: unknown) {
      const message = `Invalid LWS access token: ${createErrorMessage(error)}`;
      this.logger.warn(message);
      throw this.createError(message, error);
    }

    // "Verify the aud claim contains exactly one value and this value is a URI identifying the storage server
    // which logically contains the target resource."
    const audiences = Array.isArray(payload.aud) ? payload.aud : [ payload.aud ];
    if (audiences.length !== 1 || typeof audiences[0] !== 'string') {
      throw this.createError('The audience of an LWS access token needs to contain exactly one value.');
    }
    const target = await this.targetExtractor.handleSafe({ request });
    let storage: string | undefined;
    try {
      storage = (await this.storageStrategy.getStorageIdentifier(target)).path;
    } catch {
      // No storage contains the target
    }
    if (!storage || audiences[0] !== storage) {
      throw this.createError(`The LWS access token is not intended for the storage containing ${target.path}.`);
    }

    const { sub, client_id: clientId, iss } = payload;
    this.logger.info(`Verified LWS access token. Agent: ${sub}, client: ${String(clientId)}, issuer: ${iss}`);
    const credentials: Credentials = { agent: { webId: sub! }, issuer: { url: iss! }};
    if (typeof clientId === 'string') {
      credentials.client = { clientId };
    }
    return credentials;
  }

  private getToken(authorization: string): string {
    return authorization.replace(/^Bearer\s+/iu, '').trim();
  }

  /**
   * Verifies the signature, issuer, and temporal claims of the token.
   */
  private async verify(token: string): Promise<JWTPayload> {
    const { iss } = decodeJwt(token);
    if (iss === this.issuer.issuer) {
      return this.issuer.verify(token, this.clockTolerance);
    }
    const trusted = typeof iss === 'string' &&
      this.trustedIssuers.some((issuer): boolean => trimTrailingSlashes(issuer) === trimTrailingSlashes(iss));
    if (!trusted) {
      throw new Error(`Untrusted issuer ${iss}`);
    }
    const { payload } = await jwtVerify(token, await this.getKeySet(iss), {
      algorithms: ASYMMETRIC_ALGORITHMS,
      issuer: iss,
      typ: 'at+jwt',
      clockTolerance: this.clockTolerance,
      requiredClaims: [ 'sub', 'aud', 'exp', 'iat' ],
    });
    if (typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + this.clockTolerance) {
      throw new Error('The iat claim is in the future.');
    }
    return payload;
  }

  /**
   * Finds the keys of an external authorization server through its metadata.
   */
  private async getKeySet(issuer: string): Promise<JWTVerifyGetKey> {
    const cached = this.keySets.get(issuer);
    if (cached) {
      return cached;
    }
    // RFC 8414, §3.1: the well-known path is inserted between the host and the path of the issuer
    const url = new URL(issuer);
    const metadataUrl = `${url.origin}/.well-known/lws-configuration${trimTrailingSlashes(url.pathname)}`;
    const response = await fetch(metadataUrl, { headers: { accept: 'application/json' }});
    const metadata = await response.json() as unknown;
    if (!isJsonObject(metadata) || metadata.issuer !== issuer || typeof metadata.jwks_uri !== 'string') {
      throw new Error(`Invalid authorization server metadata at ${metadataUrl}`);
    }
    const keySet = createRemoteJWKSet(new URL(metadata.jwks_uri));
    this.keySets.set(issuer, keySet);
    return keySet;
  }

  private createError(message: string, cause?: unknown): UnauthorizedHttpError {
    const metadata = new RepresentationMetadata();
    metadata.add(SOLID_ERROR.terms.bearerError, 'invalid_token');
    return new UnauthorizedHttpError(message, { cause, metadata });
  }
}
