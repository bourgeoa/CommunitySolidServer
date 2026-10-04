/* eslint-disable @typescript-eslint/naming-convention */
import type { HttpHandlerInput } from '../../server/HttpHandler';
import { HttpHandler } from '../../server/HttpHandler';
import type { LwsAccessTokenIssuer } from './LwsAccessTokenIssuer';

/**
 * Serves the public key of the LWS authorization server as a JSON Web Key Set,
 * so storages can verify the access tokens it issues.
 */
export class LwsJwksHttpHandler extends HttpHandler {
  private readonly issuer: LwsAccessTokenIssuer;

  public constructor(issuer: LwsAccessTokenIssuer) {
    super();
    this.issuer = issuer;
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const jwks = { keys: [ await this.issuer.getPublicJwk() ]};
    response.writeHead(200, { 'content-type': 'application/jwk-set+json' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(jwks));
  }
}
