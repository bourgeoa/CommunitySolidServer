import { createHash, createPublicKey, verify } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import type { AlgJwk, JwkGenerator } from '../../../../../src/identity/configuration/JwkGenerator';
import {
  createContentDigest,
  HttpMessageSigner,
  SIGNATURE_COMPONENTS,
} from '../../../../../src/server/notifications/lws/HttpMessageSigner';

describe('A HttpMessageSigner', (): void => {
  const url = 'https://example.org:8443/inbox/foo?query=1';
  const contentType = 'application/lws+json';
  const body = '{"type":"Notification"}';
  const keyId = 'http://example.com/alice/#lws-notification-key';
  let privateJwk: AlgJwk;
  let publicJwk: AlgJwk;
  let jwkGenerator: jest.Mocked<JwkGenerator>;
  let signer: HttpMessageSigner;

  beforeEach(async(): Promise<void> => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    privateJwk = { ...await exportJWK(privateKey), alg: 'ES256' };
    publicJwk = { ...await exportJWK(publicKey), alg: 'ES256' };

    jwkGenerator = {
      alg: 'ES256',
      getPrivateKey: jest.fn().mockResolvedValue(Object.freeze(privateJwk)),
      getPublicKey: jest.fn().mockResolvedValue(Object.freeze(publicJwk)),
    };

    signer = new HttpMessageSigner(jwkGenerator);
  });

  afterEach(async(): Promise<void> => {
    jest.useRealTimers();
  });

  it('computes the Content-Digest of a body.', async(): Promise<void> => {
    const expected = createHash('sha256').update(body).digest('base64');
    expect(createContentDigest(body)).toBe(`sha-256=:${expected}:`);
    expect(createContentDigest('')).toBe('sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:');
  });

  it('returns a copy of the public key.', async(): Promise<void> => {
    const key = await signer.getPublicKey();
    expect(key).toEqual(publicJwk);
    expect(key).not.toBe(publicJwk);
  });

  it('creates a valid RFC 9421 signature.', async(): Promise<void> => {
    const now = Date.now();
    const created = Math.floor(now / 1000);
    jest.useFakeTimers();
    jest.setSystemTime(now);

    const headers = await signer.sign(url, contentType, body, keyId);
    expect(Object.keys(headers).sort()).toEqual([ 'content-digest', 'content-type', 'signature', 'signature-input' ]);
    expect(headers['content-type']).toBe(contentType);
    expect(headers['content-digest']).toBe(`sha-256=:${createHash('sha256').update(body).digest('base64')}:`);

    const parameters = '("@method" "@scheme" "@authority" "@path" "content-type" "content-digest")' +
      `;created=${created};keyid="${keyId}";alg="ecdsa-p256-sha256"`;
    expect(headers['signature-input']).toBe(`sig1=${parameters}`);

    const match = /^sig1=:([A-Za-z0-9+/=]+):$/u.exec(headers.signature);
    expect(match).not.toBeNull();
    const signature = Buffer.from(match![1], 'base64');
    // ES256 signatures in IEEE P1363 format are always 64 bytes
    expect(signature).toHaveLength(64);

    const values: Record<string, string> = {
      '@method': 'POST',
      '@scheme': 'https',
      '@authority': 'example.org:8443',
      '@path': '/inbox/foo',
      'content-type': headers['content-type'],
      'content-digest': headers['content-digest'],
    };
    const signatureBase = [
      ...SIGNATURE_COMPONENTS.map((component): string => `"${component}": ${values[component]}`),
      `"@signature-params": ${headers['signature-input'].slice('sig1='.length)}`,
    ].join('\n');

    const publicKey = createPublicKey({ key: { ...publicJwk }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(signatureBase), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature))
      .toBe(true);

    // A modified base should not verify
    expect(verify(
      'sha256',
      Buffer.from(signatureBase.replace('"@method": POST', '"@method": PUT')),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    )).toBe(false);
  });
});
