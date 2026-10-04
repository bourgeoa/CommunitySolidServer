import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { DidKeySubjectTokenVerifier } from '../../../../src/identity/lws/DidKeySubjectTokenVerifier';
import { TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_JWT } from '../../../../src/identity/lws/SubjectTokenVerifier';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function toDidKey(publicKey: KeyObject): string {
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  let value = 0n;
  for (const byte of [ 0xED, 0x01, ...raw ]) {
    value = (value * 256n) + BigInt(byte);
  }
  let result = '';
  while (value > 0n) {
    result = BASE58_ALPHABET[Number(value % 58n)] + result;
    value /= 58n;
  }
  return `did:key:z${result}`;
}

describe('A DidKeySubjectTokenVerifier', (): void => {
  const audience = 'https://as.example/';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const did = toDidKey(publicKey);
  let verifier: DidKeySubjectTokenVerifier;

  async function sign(payload: Record<string, unknown>, iat?: number): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuedAt(iat)
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  beforeEach(async(): Promise<void> => {
    verifier = new DidKeySubjectTokenVerifier();
  });

  describe('#canHandle', (): void => {
    it('rejects other token types.', async(): Promise<void> => {
      const token = await sign({ sub: did });
      await expect(verifier.canHandle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('rejects tokens without a did:key subject.', async(): Promise<void> => {
      let token = await sign({ sub: 'https://alice.example/' });
      await expect(verifier.canHandle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('Only supports credentials with a did:key subject.');
      token = await sign({});
      await expect(verifier.canHandle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('accepts JWTs with a did:key subject.', async(): Promise<void> => {
      const token = await sign({ sub: did });
      await expect(verifier.canHandle({ token, tokenType: TOKEN_TYPE_JWT, audience })).resolves.toBeUndefined();
    });
  });

  describe('#handle', (): void => {
    it('returns the verified subject.', async(): Promise<void> => {
      const token = await sign({ sub: did, iss: did, client_id: did, aud: audience });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .resolves.toEqual({ subject: did, issuer: did, client: did });
    });

    it('rejects credentials with different sub, iss, or client_id values.', async(): Promise<void> => {
      let token = await sign({ sub: did, iss: 'https://other.example/', client_id: did });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(BadRequestHttpError);
      token = await sign({ sub: did, iss: did, client_id: 'https://app.example/' });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('The sub, iss, and client_id claims of a did:key credential must be equal.');
    });

    it('rejects credentials signed with a different key.', async(): Promise<void> => {
      const other = generateKeyPairSync('ed25519');
      const token = await new SignJWT({ sub: did, iss: did, client_id: did })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(other.privateKey);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('Invalid credential: signature verification failed');
    });

    it('uses the configured clock tolerance.', async(): Promise<void> => {
      const token = await sign({ sub: did, iss: did, client_id: did }, Math.floor(Date.now() / 1000) + 120);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('the iat claim is in the future');
      verifier = new DidKeySubjectTokenVerifier(300);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .resolves.toEqual({ subject: did, issuer: did, client: did });
    });
  });
});
