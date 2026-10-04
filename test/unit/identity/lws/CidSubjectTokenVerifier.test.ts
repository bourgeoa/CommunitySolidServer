import { fetch } from 'cross-fetch';
import type { JWK, KeyLike } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { CidSubjectTokenVerifier } from '../../../../src/identity/lws/CidSubjectTokenVerifier';
import { TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_JWT } from '../../../../src/identity/lws/SubjectTokenVerifier';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';

jest.mock('cross-fetch');

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function unsignedToken(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${encode(header)}.${encode(payload)}.`;
}

describe('A CidSubjectTokenVerifier', (): void => {
  const fetchMock: jest.Mock = fetch as any;
  const audience = 'https://as.example/';
  const subject = 'https://alice.example/id';
  const kid = '#key-1';
  const keyId = `${subject}#key-1`;
  const claims = { sub: subject, iss: subject, client_id: subject };
  let privateKey: KeyLike;
  let publicJwk: JWK;
  let document: Record<string, unknown>;
  let verifier: CidSubjectTokenVerifier;

  async function sign(payload: Record<string, unknown>, header?: Record<string, unknown>, iat?: number):
  Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', ...header ?? { kid }})
      .setIssuedAt(iat)
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  beforeAll(async(): Promise<void> => {
    let publicKey: KeyLike;
    ({ privateKey, publicKey } = await generateKeyPair('ES256'));
    publicJwk = await exportJWK(publicKey);
  });

  beforeEach(async(): Promise<void> => {
    document = {
      '@context': 'https://www.w3.org/ns/cid/v1',
      id: subject,
      authentication: [
        'https://alice.example/id#other',
        { id: keyId, type: 'JsonWebKey' },
        { id: `${subject}#unused`, type: 'JsonWebKey', controller: subject, publicKeyJwk: publicJwk },
      ],
      verificationMethod: { id: keyId, type: 'JsonWebKey', controller: subject, publicKeyJwk: publicJwk },
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async(): Promise<unknown> =>
      ({ status: 200, json: async(): Promise<unknown> => document }));
    verifier = new CidSubjectTokenVerifier();
  });

  describe('#canHandle', (): void => {
    it('rejects other token types.', async(): Promise<void> => {
      const token = await sign(claims);
      await expect(verifier.canHandle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('rejects tokens without an HTTP(S) subject.', async(): Promise<void> => {
      let token = await sign({ sub: 'did:key:z123' });
      await expect(verifier.canHandle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('Only supports credentials with an HTTP(S) subject.');
      token = await sign({});
      await expect(verifier.canHandle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('accepts JWTs with an HTTP(S) subject.', async(): Promise<void> => {
      const token = await sign(claims);
      await expect(verifier.canHandle({ token, tokenType: TOKEN_TYPE_JWT, audience })).resolves.toBeUndefined();
    });
  });

  describe('#handle', (): void => {
    it('returns the verified subject.', async(): Promise<void> => {
      const token = await sign({ ...claims, aud: audience });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .resolves.toEqual({ subject, issuer: subject, client: subject });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenLastCalledWith(subject, expect.objectContaining({ headers: expect.any(Object) }));
    });

    it('accepts absolute key identifiers and methods without controller.', async(): Promise<void> => {
      document.authentication = { id: keyId, type: 'JsonWebKey', publicKeyJwk: publicJwk };
      delete document.verificationMethod;
      const token = await sign(claims, { kid: keyId });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .resolves.toEqual({ subject, issuer: subject, client: subject });
    });

    it('accepts key identifiers that are a fragment without #.', async(): Promise<void> => {
      const token = await sign(claims, { kid: 'key-1' });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .resolves.toEqual({ subject, issuer: subject, client: subject });
    });

    it('rejects credentials with different sub, iss, or client_id values.', async(): Promise<void> => {
      let token = await sign({ ...claims, iss: 'https://other.example/' });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(BadRequestHttpError);
      token = await sign({ ...claims, client_id: 'https://app.example/' });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('The sub, iss, and client_id claims of a self-issued credential must be equal.');
    });

    it('requires a kid header.', async(): Promise<void> => {
      const token = await sign(claims, {});
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('A self-issued credential needs a kid header.');
    });

    it('requires a signed credential.', async(): Promise<void> => {
      const token = unsignedToken({ alg: 'none', kid }, claims);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('A self-issued credential must be signed.');
      await expect(verifier.handle({ token: unsignedToken({ kid }, claims), tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('A self-issued credential must be signed.');
    });

    it('errors if the document can not be fetched.', async(): Promise<void> => {
      const token = await sign(claims);
      fetchMock.mockRejectedValueOnce(new Error('bad data'));
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`Unable to retrieve the controlled identifier document of ${subject}.`);
      fetchMock.mockResolvedValueOnce({ status: 404 });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`Unable to retrieve the controlled identifier document of ${subject}.`);
    });

    it('errors if the document is not a controlled identifier document of the subject.', async(): Promise<void> => {
      const token = await sign(claims);
      fetchMock.mockResolvedValueOnce({ status: 200, json: async(): Promise<unknown> => [ document ]});
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`${subject} is not a valid controlled identifier document.`);
      document.id = 'https://other.example/id';
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`${subject} is not a valid controlled identifier document.`);
    });

    it('errors if the verification method is controlled by someone else.', async(): Promise<void> => {
      document.verificationMethod = { id: keyId, controller: 'https://other.example/id', publicKeyJwk: publicJwk };
      const token = await sign(claims);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`The verification method ${keyId} is not controlled by ${subject}.`);
    });

    it('errors if there is no matching verification method.', async(): Promise<void> => {
      const token = await sign(claims, { kid: '#missing' });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`${subject} has no verification method ${subject}#missing.`);
    });

    it('errors if the key can not be imported.', async(): Promise<void> => {
      document.verificationMethod = { id: keyId, publicKeyJwk: { kty: 'oct' }};
      const token = await sign(claims);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`Unable to use the verification method ${kid}.`);
    });

    it('errors if the signature is invalid.', async(): Promise<void> => {
      const other = await generateKeyPair('ES256');
      document.verificationMethod = { id: keyId, publicKeyJwk: await exportJWK(other.publicKey) };
      const token = await sign(claims);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('Invalid credential: signature verification failed');
    });

    it('uses the configured clock tolerance.', async(): Promise<void> => {
      const token = await sign(claims, { kid }, Math.floor(Date.now() / 1000) + 120);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow('the iat claim is in the future');
      verifier = new CidSubjectTokenVerifier(300);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .resolves.toEqual({ subject, issuer: subject, client: subject });
    });
  });
});
