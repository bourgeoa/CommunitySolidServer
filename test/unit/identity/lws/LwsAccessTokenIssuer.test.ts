import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from 'jose';
import { CachedJwkGenerator } from '../../../../src/identity/configuration/CachedJwkGenerator';
import { LwsAccessTokenIssuer } from '../../../../src/identity/lws/LwsAccessTokenIssuer';
import { MemoryMapStorage } from '../../../../src/storage/keyvalue/MemoryMapStorage';

describe('An LwsAccessTokenIssuer', (): void => {
  const issuerId = 'https://as.example/';
  const subject = 'https://alice.example/profile#me';
  const client = 'https://app.example/id';
  const storage = 'https://storage.example/alice/';
  const jwkGenerator = new CachedJwkGenerator('ES256', 'jwks', new MemoryMapStorage());
  let issuer: LwsAccessTokenIssuer;

  async function sign(header: Record<string, unknown>, iat?: number): Promise<string> {
    const key = await importJWK(await jwkGenerator.getPrivateKey(), 'ES256');
    return new SignJWT({ client_id: client })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', ...header })
      .setSubject(subject)
      .setIssuer(issuerId)
      .setAudience(storage)
      .setIssuedAt(iat)
      .setExpirationTime('5m')
      .setJti('jti')
      .sign(key);
  }

  beforeEach(async(): Promise<void> => {
    issuer = new LwsAccessTokenIssuer(issuerId, jwkGenerator);
  });

  it('exposes its identifier and lifetime.', async(): Promise<void> => {
    expect(issuer.issuer).toBe(issuerId);
    expect(issuer.lifetime).toBe(300);
    expect(new LwsAccessTokenIssuer(issuerId, jwkGenerator, 60).lifetime).toBe(60);
  });

  it('returns the public key with a kid and use.', async(): Promise<void> => {
    const jwk = await issuer.getPublicJwk();
    expect(jwk).toEqual(expect.objectContaining({ ...await jwkGenerator.getPublicKey(), use: 'sig' }));
    expect(typeof jwk.kid).toBe('string');
    expect(jwk.d).toBeUndefined();
  });

  it('issues access tokens.', async(): Promise<void> => {
    issuer = new LwsAccessTokenIssuer(issuerId, jwkGenerator, 60);
    const token = await issuer.issue(subject, client, storage);
    const { kid } = await issuer.getPublicJwk();
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', typ: 'at+jwt', kid });
    const { payload } = await jwtVerify(token, await importJWK(await jwkGenerator.getPublicKey(), 'ES256'));
    expect(payload).toEqual({
      sub: subject,
      iss: issuerId,
      client_id: client,
      aud: storage,
      iat: expect.any(Number),
      exp: payload.iat! + 60,
      jti: expect.any(String),
    });
  });

  it('verifies its own access tokens.', async(): Promise<void> => {
    const token = await issuer.issue(subject, client, storage);
    await expect(issuer.verify(token)).resolves.toEqual(decodeJwt(token));
  });

  it('accepts tokens without kid.', async(): Promise<void> => {
    const token = await sign({});
    await expect(issuer.verify(token)).resolves.toEqual(decodeJwt(token));
  });

  it('rejects tokens with an unknown kid.', async(): Promise<void> => {
    const token = await sign({ kid: 'unknown' });
    await expect(issuer.verify(token)).rejects.toThrow('Unknown key unknown');
  });

  it('rejects tokens of other issuers.', async(): Promise<void> => {
    const token = await issuer.issue(subject, client, storage);
    const other = new LwsAccessTokenIssuer('https://other.example/', jwkGenerator);
    await expect(other.verify(token)).rejects.toThrow('unexpected "iss" claim value');
  });

  it('rejects tokens signed by a different key.', async(): Promise<void> => {
    const token = await issuer.issue(subject, client, storage);
    const other = new LwsAccessTokenIssuer(issuerId, new CachedJwkGenerator('ES256', 'jwks', new MemoryMapStorage()));
    await expect(other.verify(token)).rejects.toThrow('signature verification failed');
  });

  it('rejects tokens issued in the future.', async(): Promise<void> => {
    const token = await sign({}, Math.floor(Date.now() / 1000) + 120);
    await expect(issuer.verify(token)).rejects.toThrow('The iat claim is in the future.');
    await expect(issuer.verify(token, 300)).resolves.toEqual(decodeJwt(token));
  });
});
