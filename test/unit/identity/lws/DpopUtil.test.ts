import type { JWK, KeyLike } from 'jose';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyDpopProof } from '../../../../src/identity/lws/DpopUtil';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';

describe('DpopUtil', (): void => {
  const url = 'https://as.example/.well-known/lws/token';
  let privateKey: KeyLike;
  let jwk: JWK;

  async function createProof(
    claims: Record<string, unknown> = { htm: 'POST', htu: url },
    header: Record<string, unknown> = {},
  ): Promise<string> {
    return new SignJWT({ jti: 'id', ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk, ...header })
      .setIssuedAt()
      .sign(privateKey);
  }

  beforeAll(async(): Promise<void> => {
    let publicKey: KeyLike;
    ({ privateKey, publicKey } = await generateKeyPair('ES256'));
    jwk = await exportJWK(publicKey);
  });

  it('returns the thumbprint of a valid proof.', async(): Promise<void> => {
    await expect(verifyDpopProof(await createProof(), 'POST', url))
      .resolves.toBe(await calculateJwkThumbprint(jwk, 'sha256'));
    await expect(verifyDpopProof(await createProof({ htm: 'POST', htu: `${url}?a=b#c` }), 'POST', url))
      .resolves.toBe(await calculateJwkThumbprint(jwk, 'sha256'));
  });

  it('rejects proofs with the wrong type, algorithm, or key.', async(): Promise<void> => {
    await expect(verifyDpopProof(await createProof(undefined, { typ: 'JWT' }), 'POST', url))
      .rejects.toThrow('the typ header needs to be dpop+jwt');
    await expect(verifyDpopProof(await createProof(undefined, { jwk: undefined }), 'POST', url))
      .rejects.toThrow('the jwk header needs to contain a public key');
    await expect(verifyDpopProof(await createProof(undefined, { jwk: { ...jwk, d: 'secret' }}), 'POST', url))
      .rejects.toThrow('the jwk header needs to contain a public key');
    const [ header, payload ] = (await createProof()).split('.');
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>;
    const hs256 = Buffer.from(JSON.stringify({ ...decoded, alg: 'HS256' })).toString('base64url');
    await expect(verifyDpopProof(`${hs256}.${payload}.sig`, 'POST', url))
      .rejects.toThrow('an asymmetric signing algorithm is required');
  });

  it('rejects proofs for other requests.', async(): Promise<void> => {
    await expect(verifyDpopProof(await createProof({ htm: 'GET', htu: url }), 'POST', url))
      .rejects.toThrow('the htm claim needs to be POST');
    await expect(verifyDpopProof(await createProof({ htm: 'POST', htu: 'https://other.example/' }), 'POST', url))
      .rejects.toThrow(`the htu claim needs to be ${url}`);
    await expect(verifyDpopProof(await createProof({ htm: 'POST' }), 'POST', url))
      .rejects.toThrow(BadRequestHttpError);
  });

  it('rejects invalid tokens.', async(): Promise<void> => {
    await expect(verifyDpopProof('invalid', 'POST', url)).rejects.toThrow('Invalid DPoP proof');
  });
});
