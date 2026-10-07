import { fetch } from 'cross-fetch';
import type { JWK } from 'jose';
import { decodeProtectedHeader, importJWK } from 'jose';
import { getLoggerFor } from '../../logging/LogUtil';
import { didWebDocumentUrl } from '../../util/DidWebUtil';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { isJsonObject } from '../../util/JsonMergePatch';
import { decodeUnverifiedJwt, verifyJwtCredential } from './JwtCredentialUtil';
import type { SubjectTokenVerifierInput, VerifiedSubject } from './SubjectTokenVerifier';
import { SubjectTokenVerifier, TOKEN_TYPE_JWT } from './SubjectTokenVerifier';

/**
 * Validates self-issued JWT credentials of agents identified by a `did:web` URI.
 *
 * The subject is resolved to its DID document, which needs to have an `id` equal to the subject
 * and a verification method with the `kid` of the signed JWT,
 * as described by "The did:web Method" and the LWS 1.0 Authentication Suite on self-issued identity.
 * The `sub`, `iss`, and `client_id` claims all need to have the same value.
 *
 * Only JSON DID documents with `JsonWebKey` verification methods are supported.
 * The subject keeps its `did:web` value: no other identifier, such as a WebID, is derived from it.
 */
export class DidWebSubjectTokenVerifier extends SubjectTokenVerifier {
  protected readonly logger = getLoggerFor(this);

  private readonly clockTolerance: number;

  /**
   * @param clockTolerance - Allowed clock skew in seconds. Defaults to 60.
   */
  public constructor(clockTolerance = 60) {
    super();
    this.clockTolerance = clockTolerance;
  }

  public async canHandle({ token, tokenType }: SubjectTokenVerifierInput): Promise<void> {
    if (tokenType !== TOKEN_TYPE_JWT) {
      throw new NotImplementedHttpError(`Unsupported token type ${tokenType}`);
    }
    const { sub } = decodeUnverifiedJwt(token);
    if (typeof sub !== 'string' || !sub.startsWith('did:web:')) {
      throw new NotImplementedHttpError('Only supports credentials with a did:web subject.');
    }
  }

  public async handle({ token, audience }: SubjectTokenVerifierInput): Promise<VerifiedSubject> {
    const { sub, iss, client_id: client } = decodeUnverifiedJwt(token);
    // "The claims sub, iss, and client_id MUST all use the same URI value."
    if (iss !== sub || client !== sub) {
      throw new BadRequestHttpError('The sub, iss, and client_id claims of a self-issued credential must be equal.');
    }
    const { kid, alg } = decodeProtectedHeader(token);
    if (typeof kid !== 'string') {
      throw new BadRequestHttpError('A self-issued credential needs a kid header.');
    }
    if (!alg || alg === 'none') {
      throw new BadRequestHttpError('A self-issued credential must be signed.');
    }

    const jwk = await this.findKey(sub!, kid);
    let key: Awaited<ReturnType<typeof importJWK>>;
    try {
      key = await importJWK(jwk, alg);
    } catch (error: unknown) {
      throw new BadRequestHttpError(`Unable to use the verification method ${kid}.`, { cause: error });
    }

    await verifyJwtCredential(token, key, {
      audiences: [ audience ],
      requiredClaims: [ 'sub', 'iss', 'client_id' ],
      clockTolerance: this.clockTolerance,
    });

    this.logger.debug(`Verified did:web credential of ${sub}`);
    return { subject: sub!, issuer: sub!, client: sub! };
  }

  /**
   * Finds the public key referenced by the `kid` in the DID document of the subject.
   */
  protected async findKey(subject: string, kid: string): Promise<JWK> {
    const url = didWebDocumentUrl(subject);
    let document: unknown;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/did+ld+json, application/did+json, application/json;q=0.9' },
      });
      if (response.status !== 200) {
        throw new Error(`Received status code ${response.status}`);
      }
      document = await response.json();
    } catch (error: unknown) {
      this.logger.warn(`Unable to fetch ${url}: ${createErrorMessage(error)}`);
      throw new BadRequestHttpError(`Unable to retrieve the DID document of ${subject}.`);
    }
    if (!isJsonObject(document) || document.id !== subject) {
      throw new BadRequestHttpError(`${subject} is not a valid DID document.`);
    }

    // The kid is either the full identifier of the verification method, or its fragment
    const keyId = /^[a-z][\w+.-]*:/iu.test(kid) ? kid : `${subject}#${kid.replace(/^#/u, '')}`;
    const methods = [ document.authentication, document.assertionMethod, document.verificationMethod ]
      .flatMap((value): unknown[] => Array.isArray(value) ? value : [ value ]);
    for (const method of methods) {
      if (!isJsonObject(method) || method.id !== keyId || !isJsonObject(method.publicKeyJwk)) {
        continue;
      }
      if (method.controller !== undefined && method.controller !== subject) {
        throw new BadRequestHttpError(`The verification method ${keyId} is not controlled by ${subject}.`);
      }
      return method.publicKeyJwk as JWK;
    }
    throw new BadRequestHttpError(`${subject} has no verification method ${keyId}.`);
  }
}
