/* eslint-disable @typescript-eslint/naming-convention */
import type { HttpHandlerInput } from '../../server/HttpHandler';
import { HttpHandler } from '../../server/HttpHandler';
import { APPLICATION_JSON } from '../../util/ContentTypes';
import { joinUrl } from '../../util/PathUtil';
import type { LwsAccessTokenIssuer } from './LwsAccessTokenIssuer';
import { GRANT_TYPE_TOKEN_EXCHANGE } from './LwsTokenHttpHandler';
import { TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_JWT } from './SubjectTokenVerifier';

/**
 * Arguments for the {@link LwsAuthorizationServerMetadataHttpHandler}.
 */
export interface LwsAuthorizationServerMetadataHttpHandlerArgs {
  /**
   * The issuer of the access tokens. Its identifier is used as `issuer` value.
   */
  issuer: LwsAccessTokenIssuer;
  /**
   * Path of the token endpoint, relative to the issuer identifier.
   */
  tokenPath: string;
  /**
   * Path of the JWKS, relative to the issuer identifier.
   */
  jwksPath: string;
  /**
   * The supported subject token types. Defaults to JWT and ID token.
   */
  subjectTokenTypes?: string[];
  /**
   * The supported subject identifier types. Defaults to `https`, `did:key`, and `did:web`.
   */
  subjectIdentifierTypes?: string[];
}

/**
 * Serves the metadata of the LWS authorization server.
 *
 * LWS, §Authorization Server Metadata: "An authorization server MUST provide a metadata resource to allow clients
 * to discover endpoint locations and capabilities as described in [RFC8414]. This metadata resource MUST be
 * available at a URL with the path `/.well-known/lws-configuration`."
 */
export class LwsAuthorizationServerMetadataHttpHandler extends HttpHandler {
  private readonly metadata: string;

  public constructor(args: LwsAuthorizationServerMetadataHttpHandlerArgs) {
    super();
    const issuer = args.issuer.issuer;
    this.metadata = JSON.stringify({
      issuer,
      token_endpoint: joinUrl(issuer, args.tokenPath),
      jwks_uri: joinUrl(issuer, args.jwksPath),
      grant_types_supported: [ GRANT_TYPE_TOKEN_EXCHANGE ],
      token_endpoint_auth_methods_supported: [ 'none' ],
      response_types_supported: [ 'token' ],
      claims_supported: [ 'sub', 'iss', 'client_id', 'aud', 'exp', 'iat', 'jti' ],
      subject_token_types_supported: args.subjectTokenTypes ?? [ TOKEN_TYPE_JWT, TOKEN_TYPE_ID_TOKEN ],
      subject_identifier_types_supported: args.subjectIdentifierTypes ?? [ 'https', 'did:key', 'did:web' ],
    });
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    response.writeHead(200, { 'content-type': APPLICATION_JSON });
    response.end(request.method === 'HEAD' ? undefined : this.metadata);
  }
}
