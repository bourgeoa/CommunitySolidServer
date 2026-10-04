/* eslint-disable @typescript-eslint/naming-convention */
import { randomUUID } from 'node:crypto';
import type { JWK, JWTPayload } from 'jose';
import { calculateJwkThumbprint, importJWK, jwtVerify, SignJWT } from 'jose';
import type { JwkGenerator } from '../configuration/JwkGenerator';

/**
 * The claims of an LWS access token, as defined in LWS, §Token Exchange.
 */
export type LwsAccessTokenClaims = JWTPayload & {
  sub: string;
  iss: string;
  client_id: string;
  aud: string | string[];
  exp: number;
  iat: number;
  jti: string;
};

/**
 * Issues and verifies the access tokens of the LWS authorization server of this server.
 * Access tokens conform to the JSON Web Token Profile for OAuth 2.0 Access Tokens (RFC 9068),
 * and are signed with the key provided by the {@link JwkGenerator}.
 */
export class LwsAccessTokenIssuer {
  /**
   * The identifier of the authorization server, used as `iss` claim.
   */
  public readonly issuer: string;
  /**
   * The lifetime of issued access tokens in seconds.
   */
  public readonly lifetime: number;

  private readonly jwkGenerator: JwkGenerator;

  /**
   * @param issuer - The identifier of the authorization server. Usually the base URL of the server.
   * @param jwkGenerator - Generates the key used to sign tokens.
   * @param lifetime - Lifetime of the access tokens in seconds. LWS recommends 300 seconds or less.
   */
  public constructor(issuer: string, jwkGenerator: JwkGenerator, lifetime = 300) {
    this.issuer = issuer;
    this.jwkGenerator = jwkGenerator;
    this.lifetime = lifetime;
  }

  /**
   * Returns the public signing key, with a `kid` and `use` parameter.
   */
  public async getPublicJwk(): Promise<JWK> {
    const jwk: JWK = { ...await this.jwkGenerator.getPublicKey() };
    jwk.kid = await calculateJwkThumbprint(jwk);
    jwk.use = 'sig';
    return jwk;
  }

  /**
   * Issues a new access token.
   *
   * @param subject - The URI of the agent.
   * @param client - The URI of the client.
   * @param audience - The URI of the storage the token is intended for.
   */
  public async issue(subject: string, client: string, audience: string): Promise<string> {
    const privateJwk = await this.jwkGenerator.getPrivateKey();
    const key = await importJWK(privateJwk, this.jwkGenerator.alg);
    const kid = (await this.getPublicJwk()).kid;
    return new SignJWT({ client_id: client })
      .setProtectedHeader({ alg: this.jwkGenerator.alg, typ: 'at+jwt', kid })
      .setSubject(subject)
      .setIssuer(this.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${this.lifetime}s`)
      .setJti(randomUUID())
      .sign(key);
  }

  /**
   * Verifies the signature, issuer, type, and temporal claims of an access token issued by this server.
   * Throws an error if the token is not valid.
   *
   * @param token - The serialized access token.
   * @param clockTolerance - Allowed clock skew in seconds.
   */
  public async verify(token: string, clockTolerance = 60): Promise<LwsAccessTokenClaims> {
    const publicJwk = await this.getPublicJwk();
    const key = await importJWK(publicJwk, this.jwkGenerator.alg);
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: [ this.jwkGenerator.alg ],
      issuer: this.issuer,
      typ: 'at+jwt',
      clockTolerance,
      requiredClaims: [ 'sub', 'client_id', 'aud', 'exp', 'iat', 'jti' ],
    });
    if (protectedHeader.kid && protectedHeader.kid !== publicJwk.kid) {
      throw new Error(`Unknown key ${protectedHeader.kid}`);
    }
    if (typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + clockTolerance) {
      throw new Error('The iat claim is in the future.');
    }
    return payload as LwsAccessTokenClaims;
  }
}
