import type { Quad } from '@rdfjs/types';
import arrayifyStream from 'arrayify-stream';
import type { Response } from 'cross-fetch';
import { fetch } from 'cross-fetch';
import type { JWK } from 'jose';
import { decodeProtectedHeader, importJWK } from 'jose';
import { getLoggerFor } from '../../logging/LogUtil';
import type { RepresentationConverter } from '../../storage/conversion/RepresentationConverter';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { responseToDataset } from '../../util/FetchUtil';
import { isJsonObject } from '../../util/JsonMergePatch';
import { SEC } from '../../util/Vocabularies';
import type { IdentityKeyStore } from './IdentityKeyStore';
import { toDocumentId } from './IdentityKeyStore';
import { decodeUnverifiedJwt, verifyJwtCredential } from './JwtCredentialUtil';
import type { SubjectTokenVerifierInput, VerifiedSubject } from './SubjectTokenVerifier';
import { SubjectTokenVerifier, TOKEN_TYPE_JWT } from './SubjectTokenVerifier';

/**
 * Arguments for the {@link CidSubjectTokenVerifier}.
 */
export interface CidSubjectTokenVerifierArgs {
  /**
   * Used to parse RDF subject documents, such as Solid WebID profiles.
   */
  converter: RepresentationConverter;
  /**
   * The keys that agents registered with this server. These are authoritative:
   * if a subject has registered keys, its credentials are only accepted if they are signed with one of those keys.
   */
  keys: IdentityKeyStore;
  /**
   * Whether the controlled identifier document of a subject may be dereferenced,
   * which is only done if that subject has no registered keys. Defaults to `false`.
   *
   * Neither LWS nor CID requires these documents to be readable by everyone,
   * so enabling this only works if all subjects have a document this server can retrieve.
   */
  documentFetch?: boolean;
  /**
   * Allowed clock skew in seconds. Defaults to 60.
   */
  clockTolerance?: number;
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
 * Only `JsonWebKey` verification methods are supported.
 *
 * Keys that are registered for a subject are authoritative: if a subject has registered keys,
 * no document is dereferenced and the credential is only accepted if it is signed with one of those keys.
 * This follows the trust relationship that LWS allows to be established through an out-of-band mechanism,
 * and avoids depending on the subject's document being readable by this server.
 * Next to registered keys, controlled identifier documents in JSON can be used,
 * as well as RDF documents such as Solid WebID profiles:
 * such a profile is a document about the subject, so it can carry the verification method of the agent.
 * Since neither LWS nor CID requires such a document to be readable by everyone,
 * documents are only retrieved if that is explicitly enabled.
 */
export class CidSubjectTokenVerifier extends SubjectTokenVerifier {
  protected readonly logger = getLoggerFor(this);

  private readonly converter: RepresentationConverter;
  private readonly keys: IdentityKeyStore;
  private readonly documentFetch: boolean;
  private readonly clockTolerance: number;

  public constructor(args: CidSubjectTokenVerifierArgs) {
    super();
    this.converter = args.converter;
    this.keys = args.keys;
    this.documentFetch = args.documentFetch ?? false;
    this.clockTolerance = args.clockTolerance ?? 60;
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
   * Finds the public key referenced by the `kid` in the keys that are registered for the subject,
   * or, if the subject has none, in the controlled identifier document of the subject.
   */
  protected async findKey(subject: string, kid: string): Promise<JWK> {
    // The kid is either the full identifier of the verification method, or a fragment of the subject document
    const documentId = toDocumentId(subject);
    const keyId = /^[a-z][\w+.-]*:/iu.test(kid) ? kid : `${documentId}#${kid.replace(/^#/u, '')}`;

    const registered = await this.keys.findByWebId(documentId);
    if (registered.length > 0) {
      // Registered keys are authoritative, so the document is not used to verify the credential
      const match = await this.keys.findKey(documentId, keyId);
      if (!match) {
        throw new BadRequestHttpError(`${documentId} has no registered verification method ${keyId}.`);
      }
      return match.jwk;
    }

    if (!this.documentFetch) {
      throw new BadRequestHttpError(
        `${documentId} has no registered verification methods and retrieving its document is disabled.`,
      );
    }

    let response: Response;
    let body: string;
    try {
      response = await fetch(subject, {
        headers: { accept: 'application/ld+json, application/json;q=0.9, text/turtle;q=0.8' },
      });
      if (response.status !== 200) {
        throw new Error(`Received status code ${response.status}`);
      }
      body = await response.text();
    } catch (error: unknown) {
      this.logger.warn(`Unable to fetch ${subject}: ${createErrorMessage(error)}`);
      throw new BadRequestHttpError(`Unable to retrieve the controlled identifier document of ${subject}.`);
    }

    // A controlled identifier document is JSON, but a WebID profile is RDF,
    // and the form in which a server returns it is not necessarily the form in which it is stored.
    const contentType = response.headers.get('content-type') ?? '';
    const isJsonDocument = contentType.startsWith('application/json');
    let jwk: JWK | undefined;
    if (contentType.includes('json')) {
      const document = this.parseJson(body);
      if (isJsonObject(document) && document.id === subject) {
        jwk = this.findJsonKey(document, subject, keyId);
      } else if (isJsonDocument) {
        throw new BadRequestHttpError(`${subject} is not a valid controlled identifier document.`);
      }
    }
    if (!jwk && !isJsonDocument) {
      jwk = await this.findRdfKey(response, body, subject, keyId);
    }

    if (!jwk) {
      throw new BadRequestHttpError(`${subject} has no verification method ${keyId}.`);
    }
    return jwk;
  }

  private parseJson(body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  /**
   * Finds the verification method with the `kid` in a controlled identifier document in JSON.
   */
  private findJsonKey(document: Record<string, unknown>, subject: string, keyId: string): JWK | undefined {
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
    return undefined;
  }

  /**
   * Finds the verification method with the `kid` in an RDF document, such as a Solid WebID profile.
   * The verification method is a resource of the subject, stated with one of the key relationships,
   * which has the public key as a JSON Web Key.
   */
  private async findRdfKey(response: Response, body: string, subject: string, keyId: string):
  Promise<JWK | undefined> {
    let quads: Quad[];
    try {
      const representation = await responseToDataset(response, this.converter, body);
      quads = await arrayifyStream<Quad>(representation.data);
    } catch (error: unknown) {
      this.logger.warn(`Unable to parse ${subject}: ${createErrorMessage(error)}`);
      throw new BadRequestHttpError(`${subject} is not a valid controlled identifier document.`);
    }

    const relationships = [ SEC.verificationMethod, SEC.authentication, SEC.assertionMethod ];
    function statesMethod(predicate: string): boolean {
      return quads.some((quad): boolean => quad.subject.value === subject &&
        quad.predicate.value === predicate && quad.object.value === keyId);
    }
    if (!relationships.some(statesMethod)) {
      return undefined;
    }

    function find(predicate: string): Quad | undefined {
      return quads.find((quad): boolean => quad.subject.value === keyId && quad.predicate.value === predicate);
    }
    const key = find(SEC.publicKeyJwk);
    if (!key) {
      return undefined;
    }
    const controller = find(SEC.controller);
    if (controller !== undefined && controller.object.value !== subject) {
      throw new BadRequestHttpError(`The verification method ${keyId} is not controlled by ${subject}.`);
    }
    const jwk = this.parseJson(key.object.value);
    return isJsonObject(jwk) ? jwk as JWK : undefined;
  }
}
