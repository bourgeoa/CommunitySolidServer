import type { JWK } from 'jose';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { isJsonObject } from '../../util/JsonMergePatch';
import { ASYMMETRIC_ALGORITHMS } from './JwtCredentialUtil';

/**
 * Removes the query and fragment of a URL, as required for comparing the `htu` claim of a DPoP proof.
 */
function normalizeHtu(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

/**
 * Verifies a DPoP proof (RFC 9449) and returns the JWK SHA-256 thumbprint of the key that signed it.
 * Throws a 400 error if the proof is not valid for the given request.
 *
 * @param proof - The value of the `DPoP` header.
 * @param method - The HTTP method of the request.
 * @param url - The URL of the request.
 * @param options - Validation options.
 * @param options.clockTolerance - Allowed clock skew in seconds. Defaults to 60.
 * @param options.maxAge - The maximum age of the proof in seconds. Defaults to 300.
 */
export async function verifyDpopProof(proof: string, method: string, url: string, options: {
  clockTolerance?: number;
  maxAge?: number;
} = {}): Promise<string> {
  try {
    const header = decodeProtectedHeader(proof);
    if (header.typ !== 'dpop+jwt') {
      throw new Error('the typ header needs to be dpop+jwt');
    }
    if (typeof header.alg !== 'string' || !ASYMMETRIC_ALGORITHMS.includes(header.alg)) {
      throw new Error('an asymmetric signing algorithm is required');
    }
    if (!isJsonObject(header.jwk) || 'd' in header.jwk) {
      throw new Error('the jwk header needs to contain a public key');
    }
    const jwk = header.jwk as JWK;
    const { payload } = await jwtVerify(proof, await importJWK(jwk, header.alg), {
      typ: 'dpop+jwt',
      algorithms: [ header.alg ],
      clockTolerance: options.clockTolerance ?? 60,
      maxTokenAge: options.maxAge ?? 300,
      requiredClaims: [ 'jti', 'htm', 'htu', 'iat' ],
    });
    if (payload.htm !== method) {
      throw new Error(`the htm claim needs to be ${method}`);
    }
    if (typeof payload.htu !== 'string' || normalizeHtu(payload.htu) !== normalizeHtu(url)) {
      throw new Error(`the htu claim needs to be ${url}`);
    }
    return await calculateJwkThumbprint(jwk, 'sha256');
  } catch (error: unknown) {
    throw new BadRequestHttpError(`Invalid DPoP proof: ${createErrorMessage(error)}`, { cause: error });
  }
}
