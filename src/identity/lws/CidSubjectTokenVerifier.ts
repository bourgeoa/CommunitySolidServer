import { fetch } from 'cross-fetch';
import type { JWK } from 'jose';
import { decodeProtectedHeader, importJWK } from 'jose';
import { getLoggerFor } from '../../logging/LogUtil';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { isJsonObject } from '../../util/JsonMergePatch';
import { decodeUnverifiedJwt, verifyJwtCredential } from './JwtCredentialUtil';
import type { SubjectTokenVerifierInput, VerifiedSubject } from './SubjectTokenVerifier';
import { SubjectTokenVerifier, TOKEN_TYPE_JWT } from './SubjectTokenVerifier';

/**
 * Resolves a, possibly relative, identifier in a controlled identifier document.
 * Returns undefined for values that are not valid identifiers.
 */
function resolveId(id: unknown, base: string): string | undefined {
  try {
    return typeof id === 'string' ? new URL(id, base).href : undefined;
  } catch {
    // Invalid identifiers do not match any key
  }
}

/**
 * Returns the identifier of an entry of a verification relationship: either a reference or an embedded method.
 */
function getId(entry: unknown, base: string): string | undefined {
  return resolveId(isJsonObject(entry) ? entry.id : entry, base);
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [ value ];
}

/**
 * Validates self-issued JWT credentials of agents identified by an HTTPS URI,
 * as described by the LWS 1.0 Authentication Suite: Self-issued Identity using Controlled Identifiers.
 *
 * "In the absence of a pre-existing trust relationship, the verifier MUST dereference the sub (subject) claim
 * in the authentication credential. The resulting resource MUST be formatted as a valid controlled identifier
 * document with an id value equal to the subject identifier. [...] The verifier MUST use the kid (key id) value
 * from the signed JWT header to identify a verification method from the subject's controlled identifier document."
 *
 * Only JSON(-LD) controlled identifier documents with `JsonWebKey` verification methods are supported.
 */
export class CidSubjectTokenVerifier extends SubjectTokenVerifier {
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
    if (typeof sub !== 'string' || !/^https?:\/\//u.test(sub)) {
      throw new NotImplementedHttpError('Only supports credentials with an HTTP(S) subject.');
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

    this.logger.debug(`Verified self-issued credential of ${sub}`);
    return { subject: sub!, issuer: sub!, client: sub! };
  }

  /**
   * Finds the public key referenced by the `kid` in the controlled identifier document of the subject.
   */
  protected async findKey(subject: string, kid: string): Promise<JWK> {
    let document: unknown;
    try {
      const response = await fetch(subject, { headers: { accept: 'application/ld+json, application/json;q=0.9' }});
      if (response.status !== 200) {
        throw new Error(`Received status code ${response.status}`);
      }
      document = await response.json();
    } catch (error: unknown) {
      this.logger.warn(`Unable to fetch ${subject}: ${createErrorMessage(error)}`);
      throw new BadRequestHttpError(`Unable to retrieve the controlled identifier document of ${subject}.`);
    }
    if (!isJsonObject(document) || document.id !== subject) {
      throw new BadRequestHttpError(`${subject} is not a valid controlled identifier document.`);
    }

    // The kid is either the full identifier of the verification method, or its fragment
    const keyId = /^[a-z][\w+.-]*:/iu.test(kid) ? kid : `${subject}#${kid.replace(/^#/u, '')}`;
    // CID 1.0, §3.3: the method needs to be one of the authentication verification relationship,
    // either embedded in it or referenced from it.
    const authentication = toArray(document.authentication);
    if (!authentication.some((entry): boolean => getId(entry, subject) === keyId)) {
      throw new BadRequestHttpError(`${subject} has no authentication verification method ${keyId}.`);
    }
    const method = [ ...authentication, ...toArray(document.verificationMethod) ]
      .find((entry): boolean =>
        isJsonObject(entry) && isJsonObject(entry.publicKeyJwk) && getId(entry, subject) === keyId);
    if (!isJsonObject(method)) {
      throw new BadRequestHttpError(`${subject} has no authentication verification method ${keyId}.`);
    }
    if (method.controller !== undefined && resolveId(method.controller, subject) !== subject) {
      throw new BadRequestHttpError(`The verification method ${keyId} is not controlled by ${subject}.`);
    }
    // CID 1.0, §2.2: methods are not used after their revoked or expires time
    for (const [ bound, state ] of [[ 'revoked', 'revoked' ], [ 'expires', 'expired' ]]) {
      const time = method[bound];
      if (time !== undefined && !(typeof time === 'string' && Date.parse(time) > Date.now())) {
        throw new BadRequestHttpError(`The verification method ${keyId} is ${state}.`);
      }
    }
    return method.publicKeyJwk as JWK;
  }
}
