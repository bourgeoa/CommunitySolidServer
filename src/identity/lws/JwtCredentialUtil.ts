import type { JWTPayload, JWTVerifyGetKey, KeyLike } from 'jose';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { createErrorMessage } from '../../util/errors/ErrorUtil';

/**
 * Asymmetric JWS algorithms that are accepted for LWS credentials.
 */
export const ASYMMETRIC_ALGORITHMS = [
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'PS256',
  'PS384',
  'PS512',
  'RS256',
  'RS384',
  'RS512',
];

/**
 * Decodes the payload of a JWT without verifying it.
 * Throws a 400 error if the token is not a JWT.
 */
export function decodeUnverifiedJwt(token: string): JWTPayload {
  try {
    // Throws if the header can not be parsed
    decodeProtectedHeader(token);
    return decodeJwt(token);
  } catch (error: unknown) {
    throw new BadRequestHttpError(`Invalid JWT: ${createErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Verifies the signature and the temporal claims of a JWT credential,
 * and that it contains all the required claims.
 * In case the credential has an audience restriction, one of the accepted audiences needs to be present.
 * Throws a 400 error if the credential is not valid.
 *
 * @param token - The serialized JWT.
 * @param key - The key, or function to find the key, to verify the signature with.
 * @param options - Validation options.
 * @param options.algorithms - The accepted signing algorithms. Defaults to {@link ASYMMETRIC_ALGORITHMS}.
 * @param options.audiences - The accepted audience values.
 * @param options.requiredClaims - Claims that need to be present.
 * @param options.clockTolerance - Allowed clock skew in seconds.
 */
export async function verifyJwtCredential(token: string, key: KeyLike | Uint8Array | JWTVerifyGetKey, options: {
  algorithms?: string[];
  audiences: string[];
  requiredClaims: string[];
  clockTolerance?: number;
}): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key as KeyLike, {
      algorithms: options.algorithms ?? ASYMMETRIC_ALGORITHMS,
      clockTolerance: options.clockTolerance ?? 60,
      requiredClaims: [ 'exp', 'iat', ...options.requiredClaims ],
    }));
  } catch (error: unknown) {
    throw new BadRequestHttpError(`Invalid credential: ${createErrorMessage(error)}`, { cause: error });
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number' || payload.iat > now + (options.clockTolerance ?? 60)) {
    throw new BadRequestHttpError('Invalid credential: the iat claim is in the future.');
  }

  if (payload.aud !== undefined) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [ payload.aud ];
    if (!audiences.some((aud): boolean => options.audiences.includes(aud))) {
      throw new BadRequestHttpError(`Invalid credential: the audience does not include ${options.audiences[0]}.`);
    }
  }
  return payload;
}
