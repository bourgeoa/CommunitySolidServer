import { getLoggerFor } from '../../logging/LogUtil';
import { parseDidKey } from '../../util/DidKeyUtil';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { decodeUnverifiedJwt, verifyJwtCredential } from './JwtCredentialUtil';
import type { SubjectTokenVerifierInput, VerifiedSubject } from './SubjectTokenVerifier';
import { SubjectTokenVerifier, TOKEN_TYPE_JWT } from './SubjectTokenVerifier';

/**
 * Validates self-issued JWT credentials of agents identified by a `did:key` URI,
 * as described by the LWS 1.0 Authentication Suite: Self-signed Identifiers using did:key.
 *
 * The public key is extracted from the subject identifier itself,
 * and the `sub`, `iss`, and `client_id` claims all need to have that same value.
 */
export class DidKeySubjectTokenVerifier extends SubjectTokenVerifier {
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
    if (typeof sub !== 'string' || !sub.startsWith('did:key:')) {
      throw new NotImplementedHttpError('Only supports credentials with a did:key subject.');
    }
  }

  public async handle({ token, audience }: SubjectTokenVerifierInput): Promise<VerifiedSubject> {
    const { sub } = decodeUnverifiedJwt(token);
    const { key, algorithms } = parseDidKey(sub!);

    const payload = await verifyJwtCredential(token, key, {
      algorithms,
      audiences: [ audience ],
      requiredClaims: [ 'sub', 'iss', 'client_id' ],
      clockTolerance: this.clockTolerance,
    });

    // "The claims sub, iss, and client_id MUST all use the same URI value."
    if (payload.iss !== sub || payload.client_id !== sub) {
      throw new BadRequestHttpError('The sub, iss, and client_id claims of a did:key credential must be equal.');
    }

    this.logger.debug(`Verified did:key credential of ${sub}`);
    return { subject: sub!, issuer: sub!, client: sub! };
  }
}
