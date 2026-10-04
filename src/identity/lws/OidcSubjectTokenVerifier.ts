import type { Quad } from '@rdfjs/types';
import arrayifyStream from 'arrayify-stream';
import type { Response } from 'cross-fetch';
import { fetch } from 'cross-fetch';
import type { JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet } from 'jose';
import { getLoggerFor } from '../../logging/LogUtil';
import type { RepresentationConverter } from '../../storage/conversion/RepresentationConverter';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { responseToDataset } from '../../util/FetchUtil';
import { isJsonObject } from '../../util/JsonMergePatch';
import { trimTrailingSlashes } from '../../util/PathUtil';
import { LWS, SOLID } from '../../util/Vocabularies';
import { decodeUnverifiedJwt, verifyJwtCredential } from './JwtCredentialUtil';
import type { SubjectTokenVerifierInput, VerifiedSubject } from './SubjectTokenVerifier';
import { SubjectTokenVerifier, TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_ID_TOKEN_ALT } from './SubjectTokenVerifier';

const CID_SERVICE = 'https://www.w3.org/ns/cid/v1#service';
const CID_SERVICE_ENDPOINT = 'https://www.w3.org/ns/cid/v1#serviceEndpoint';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface OidcSubjectTokenVerifierArgs {
  /**
   * Used to parse RDF subject documents, such as Solid WebID profiles.
   */
  converter: RepresentationConverter;
  /**
   * Issuers that are trusted without verifying the controlled identifier document of the subject,
   * such as the identity provider of this server.
   */
  trustedIssuers?: string[];
  /**
   * Additional audience values that are accepted in ID tokens,
   * next to the identifier of the authorization server.
   * Solid-OIDC ID tokens, for example, have the `solid` audience.
   */
  additionalAudiences?: string[];
  /**
   * Whether a `solid:oidcIssuer` triple in the subject document is accepted
   * as an alternative to an `lws:OpenIdProvider` service.
   * This allows agents with a Solid WebID to use their existing identity provider.
   * Defaults to true.
   */
  acceptSolidOidcIssuer?: boolean;
  /**
   * Allowed clock skew in seconds. Defaults to 60.
   */
  clockTolerance?: number;
}

/**
 * Validates OpenID Connect ID tokens as LWS authentication credentials,
 * as described by the LWS 1.0 Authentication Suite: OpenID Connect.
 *
 * "In the absence of a pre-existing trust relationship, the validator MUST dereference the sub (subject) claim
 * in the authentication credential. [...] The verifier MUST use the subject's controlled identifier document
 * to locate a service object whose serviceEndpoint value is equal to the value of the iss claim
 * from the authentication credential, and whose type value is equal to `https://www.w3.org/ns/lws#OpenIdProvider`.
 * The verifier MUST perform OpenID Connect Discovery to locate the public portion of the JSON Web Key (JWK)
 * used to sign the authentication credential."
 */
export class OidcSubjectTokenVerifier extends SubjectTokenVerifier {
  protected readonly logger = getLoggerFor(this);

  private readonly converter: RepresentationConverter;
  private readonly trustedIssuers: Set<string>;
  private readonly additionalAudiences: string[];
  private readonly acceptSolidOidcIssuer: boolean;
  private readonly clockTolerance: number;
  private readonly keySets = new Map<string, JWTVerifyGetKey>();

  public constructor(args: OidcSubjectTokenVerifierArgs) {
    super();
    this.converter = args.converter;
    this.trustedIssuers = new Set((args.trustedIssuers ?? []).map(trimTrailingSlashes));
    this.additionalAudiences = args.additionalAudiences ?? [];
    this.acceptSolidOidcIssuer = args.acceptSolidOidcIssuer ?? true;
    this.clockTolerance = args.clockTolerance ?? 60;
  }

  public async canHandle({ tokenType }: SubjectTokenVerifierInput): Promise<void> {
    if (tokenType !== TOKEN_TYPE_ID_TOKEN && tokenType !== TOKEN_TYPE_ID_TOKEN_ALT) {
      throw new NotImplementedHttpError(`Unsupported token type ${tokenType}`);
    }
  }

  public async handle({ token, audience }: SubjectTokenVerifierInput): Promise<VerifiedSubject> {
    const claims = decodeUnverifiedJwt(token);
    const { iss, aud } = claims;
    let { sub, azp } = claims;
    // Solid-OIDC ID tokens identify the agent with the webid claim, the sub claim does not need to be a URI
    if (this.acceptSolidOidcIssuer && typeof claims.webid === 'string' && !/^https?:\/\//u.test(String(sub))) {
      sub = claims.webid;
    }
    // OpenID Connect only requires azp in case there are multiple audiences, otherwise the audience is the client
    if (azp === undefined && (typeof aud === 'string' || (Array.isArray(aud) && aud.length === 1))) {
      azp = Array.isArray(aud) ? aud[0] : aud;
    }
    if (typeof sub !== 'string' || typeof iss !== 'string' || typeof azp !== 'string') {
      throw new BadRequestHttpError('An ID token needs to contain the sub, iss, and azp claims.');
    }
    if (!/^https?:\/\//u.test(sub) || !/^https?:\/\//u.test(iss)) {
      throw new BadRequestHttpError('The sub and iss claims of an ID token need to be HTTP(S) URIs.');
    }

    if (!this.trustedIssuers.has(trimTrailingSlashes(iss))) {
      await this.verifySubjectDocument(sub, iss);
    }

    await verifyJwtCredential(token, await this.getKeySet(iss), {
      // "The aud claim SHOULD include the client identifier and any additional target audience
      // such as an authorization server." Regular ID tokens, which only have the client as audience, are accepted.
      audiences: [ audience, azp, ...this.additionalAudiences ],
      requiredClaims: [ 'sub', 'iss' ],
      clockTolerance: this.clockTolerance,
    });

    this.logger.debug(`Verified ID token of ${sub} issued by ${iss}`);
    return { subject: sub, issuer: iss, client: azp };
  }

  /**
   * Verifies that the controlled identifier document of the subject designates the issuer as its OpenID provider.
   */
  protected async verifySubjectDocument(subject: string, issuer: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(subject, {
        headers: { accept: 'application/ld+json, application/json;q=0.9, text/turtle;q=0.8' },
      });
    } catch (error: unknown) {
      this.logger.warn(`Unable to fetch ${subject}: ${createErrorMessage(error)}`);
      throw new BadRequestHttpError(`Unable to retrieve the controlled identifier document of ${subject}.`);
    }
    if (response.status !== 200) {
      throw new BadRequestHttpError(`Unable to retrieve the controlled identifier document of ${subject}.`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    let valid = contentType.includes('json') && this.hasJsonIssuer(body, subject, issuer);
    // JSON-LD documents, such as WebID profiles, are not necessarily in the compact form of a CID document
    if (!valid && !contentType.startsWith('application/json')) {
      valid = await this.hasRdfIssuer(response, body, subject, issuer);
    }
    if (!valid) {
      throw new BadRequestHttpError(`${subject} does not designate ${issuer} as its OpenID provider.`);
    }
  }

  private hasJsonIssuer(body: string, subject: string, issuer: string): boolean {
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      return false;
    }
    if (!isJsonObject(document) || document.id !== subject || !Array.isArray(document.service)) {
      return false;
    }
    return (document.service as unknown[]).some((service): boolean => {
      if (!isJsonObject(service)) {
        return false;
      }
      const types = Array.isArray(service.type) ? service.type : [ service.type ];
      const endpoints = Array.isArray(service.serviceEndpoint) ? service.serviceEndpoint : [ service.serviceEndpoint ];
      return types.includes(LWS.OpenIdProvider) &&
        endpoints.some((endpoint): boolean => typeof endpoint === 'string' && this.sameIssuer(endpoint, issuer));
    });
  }

  private async hasRdfIssuer(response: Response, body: string, subject: string, issuer: string): Promise<boolean> {
    let quads: Quad[];
    try {
      const representation = await responseToDataset(response, this.converter, body);
      quads = await arrayifyStream<Quad>(representation.data);
    } catch {
      return false;
    }
    const subjectQuads = quads.filter((quad): boolean => quad.subject.value === subject);
    if (this.acceptSolidOidcIssuer && subjectQuads.some((quad): boolean =>
      quad.predicate.value === SOLID.oidcIssuer && this.sameIssuer(quad.object.value, issuer))) {
      return true;
    }
    const services = subjectQuads.filter((quad): boolean => quad.predicate.value === CID_SERVICE)
      .map((quad): string => quad.object.value);
    return services.some((service): boolean =>
      quads.some((quad): boolean => quad.subject.value === service && quad.predicate.value === RDF_TYPE &&
        quad.object.value === LWS.OpenIdProvider) &&
        quads.some((quad): boolean => quad.subject.value === service && quad.predicate.value === CID_SERVICE_ENDPOINT &&
          this.sameIssuer(quad.object.value, issuer)));
  }

  private sameIssuer(first: string, second: string): boolean {
    return trimTrailingSlashes(first) === trimTrailingSlashes(second);
  }

  /**
   * Finds the JWKS of the issuer through OpenID Connect Discovery.
   */
  protected async getKeySet(issuer: string): Promise<JWTVerifyGetKey> {
    const cached = this.keySets.get(issuer);
    if (cached) {
      return cached;
    }
    let jwksUri: unknown;
    try {
      const response = await fetch(`${trimTrailingSlashes(issuer)}/.well-known/openid-configuration`);
      const configuration = await response.json() as unknown;
      if (isJsonObject(configuration) && this.sameIssuer(String(configuration.issuer), issuer)) {
        jwksUri = configuration.jwks_uri;
      }
    } catch (error: unknown) {
      this.logger.warn(`Unable to perform OpenID Connect Discovery for ${issuer}: ${createErrorMessage(error)}`);
    }
    if (typeof jwksUri !== 'string') {
      throw new BadRequestHttpError(`Unable to discover the keys of ${issuer}.`);
    }
    const keySet = createRemoteJWKSet(new URL(jwksUri));
    this.keySets.set(issuer, keySet);
    return keySet;
  }
}
