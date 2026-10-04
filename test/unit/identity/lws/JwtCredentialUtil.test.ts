import type { KeyLike } from 'jose';
import { generateKeyPair, SignJWT } from 'jose';
import {
  ASYMMETRIC_ALGORITHMS,
  decodeUnverifiedJwt,
  verifyJwtCredential,
} from '../../../../src/identity/lws/JwtCredentialUtil';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';

describe('JwtCredentialUtil', (): void => {
  const audience = 'https://as.example/';
  let privateKey: KeyLike;
  let publicKey: KeyLike;

  async function sign(payload: Record<string, unknown>, iat?: number): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt(iat)
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  beforeAll(async(): Promise<void> => {
    ({ privateKey, publicKey } = await generateKeyPair('ES256'));
  });

  it('exports the accepted asymmetric algorithms.', async(): Promise<void> => {
    expect(ASYMMETRIC_ALGORITHMS).toContain('ES256');
    expect(ASYMMETRIC_ALGORITHMS).not.toContain('HS256');
  });

  describe('#decodeUnverifiedJwt', (): void => {
    it('returns the payload of a JWT.', async(): Promise<void> => {
      const token = await sign({ sub: 'https://alice.example/' });
      expect(decodeUnverifiedJwt(token)).toEqual(expect.objectContaining({ sub: 'https://alice.example/' }));
    });

    it('errors on invalid JWTs.', async(): Promise<void> => {
      expect((): unknown => decodeUnverifiedJwt('not a jwt')).toThrow(BadRequestHttpError);
      expect((): unknown => decodeUnverifiedJwt('not a jwt')).toThrow('Invalid JWT: ');
    });
  });

  describe('#verifyJwtCredential', (): void => {
    it('returns the payload of a valid credential without audience.', async(): Promise<void> => {
      const token = await sign({ sub: 'https://alice.example/' });
      await expect(verifyJwtCredential(token, publicKey, { audiences: [ audience ], requiredClaims: [ 'sub' ]}))
        .resolves.toEqual(expect.objectContaining({ sub: 'https://alice.example/' }));
    });

    it('accepts credentials with a matching audience.', async(): Promise<void> => {
      let token = await sign({ aud: audience });
      await expect(verifyJwtCredential(token, publicKey, { audiences: [ audience ], requiredClaims: []}))
        .resolves.toEqual(expect.objectContaining({ aud: audience }));
      token = await sign({ aud: [ 'https://other.example/', audience ]});
      await expect(verifyJwtCredential(token, publicKey, {
        algorithms: [ 'ES256' ],
        audiences: [ 'https://unused.example/', audience ],
        requiredClaims: [],
        clockTolerance: 5,
      })).resolves.toEqual(expect.objectContaining({ aud: [ 'https://other.example/', audience ]}));
    });

    it('rejects credentials with a different audience.', async(): Promise<void> => {
      const token = await sign({ aud: 'https://other.example/' });
      const result = verifyJwtCredential(token, publicKey, { audiences: [ audience ], requiredClaims: []});
      await expect(result).rejects.toThrow(BadRequestHttpError);
      await expect(result).rejects.toThrow(`Invalid credential: the audience does not include ${audience}.`);
    });

    it('rejects credentials with an invalid signature or missing claims.', async(): Promise<void> => {
      const other = await generateKeyPair('ES256');
      let token = await sign({ sub: 'https://alice.example/' });
      await expect(verifyJwtCredential(token, other.publicKey, { audiences: [ audience ], requiredClaims: []}))
        .rejects.toThrow('Invalid credential: signature verification failed');
      token = await sign({});
      await expect(verifyJwtCredential(token, publicKey, { audiences: [ audience ], requiredClaims: [ 'sub' ]}))
        .rejects.toThrow('Invalid credential: ');
    });

    it('rejects credentials issued in the future.', async(): Promise<void> => {
      const token = await sign({}, Math.floor(Date.now() / 1000) + 120);
      await expect(verifyJwtCredential(token, publicKey, { audiences: [ audience ], requiredClaims: []}))
        .rejects.toThrow('Invalid credential: the iat claim is in the future.');
      await expect(verifyJwtCredential(token, publicKey, {
        audiences: [ audience ],
        requiredClaims: [],
        clockTolerance: 200,
      })).resolves.toBeDefined();
    });
  });
});
