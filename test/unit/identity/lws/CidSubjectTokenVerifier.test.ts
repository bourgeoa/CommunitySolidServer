import { fetch } from 'cross-fetch';
import type { JWK, KeyLike } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { CidSubjectTokenVerifier } from '../../../../src/identity/lws/CidSubjectTokenVerifier';
import type { IdentityKey, IdentityKeyStore } from '../../../../src/identity/lws/IdentityKeyStore';
import { TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_JWT } from '../../../../src/identity/lws/SubjectTokenVerifier';
import { RdfToQuadConverter } from '../../../../src/storage/conversion/RdfToQuadConverter';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { SEC } from '../../../../src/util/Vocabularies';

jest.mock('cross-fetch');

interface MockResponse {
  status: number;
  url: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}

function mockResponse(body: string, contentType?: string, status = 200, url = ''): MockResponse {
  return {
    status,
    url,
    headers: { get: (name: string): string | null => name === 'content-type' ? contentType ?? null : null },
    text: async(): Promise<string> => body,
  };
}

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
  const converter = new RdfToQuadConverter();
  let privateKey: KeyLike;
  let publicJwk: JWK;
  let document: Record<string, unknown>;
  let keys: jest.Mocked<IdentityKeyStore>;
  let verifier: CidSubjectTokenVerifier;

  /**
   * The key that is registered with the store in the tests below.
   * A function since the key is only generated in the `beforeAll`.
   */
  function registeredKey(): IdentityKey {
    return {
      id: 'id',
      webId: subject,
      keyId,
      label: 'key-1',
      jwk: publicJwk,
    };
  }

  async function sign(payload: Record<string, unknown>, header?: Record<string, unknown>, iat?: number):
  Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', ...header ?? { kid }})
      .setIssuedAt(iat)
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  /**
   * A WebID profile is RDF, and a server can return it in a form other than the stored one.
   */
  function profile(statements: string): void {
    fetchMock.mockResolvedValueOnce(mockResponse(
      `@prefix sec: <${SEC.namespace}>. ${statements}`,
      'text/turtle',
      200,
      subject,
    ));
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
      mockResponse(JSON.stringify(document), 'application/json'));

    keys = {
      findByWebId: jest.fn().mockResolvedValue([]),
      findKey: jest.fn(),
    } satisfies Partial<IdentityKeyStore> as any;

    // The document of a subject is only retrieved if that is enabled explicitly
    verifier = new CidSubjectTokenVerifier({ converter, keys, documentFetch: true });
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
      fetchMock.mockResolvedValueOnce(mockResponse(JSON.stringify([ document ]), 'application/json'));
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`${subject} is not a valid controlled identifier document.`);
      document.id = 'https://other.example/id';
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`${subject} is not a valid controlled identifier document.`);
    });

    it('errors if the document has no content type.', async(): Promise<void> => {
      fetchMock.mockResolvedValueOnce(mockResponse(JSON.stringify(document)));
      const token = await sign(claims);
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
      verifier = new CidSubjectTokenVerifier({ converter, keys, documentFetch: true, clockTolerance: 300 });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .resolves.toEqual({ subject, issuer: subject, client: subject });
    });

    describe('with an RDF document', (): void => {
      it('resolves the key of a WebID profile.', async(): Promise<void> => {
        profile(`
          <${subject}> sec:verificationMethod <${keyId}>.
          <${keyId}> sec:publicKeyJwk """${JSON.stringify(publicJwk)}""".
        `);
        const token = await sign(claims);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .resolves.toEqual({ subject, issuer: subject, client: subject });
      });

      it('resolves the key of a profile that was converted to JSON-LD.', async(): Promise<void> => {
        // The form in which a server can return a stored profile
        fetchMock.mockResolvedValueOnce(mockResponse(JSON.stringify([
          {
            '@id': subject,
            [`${SEC.namespace}authentication`]: [{ '@id': keyId }],
            [`${SEC.namespace}verificationMethod`]: [{ '@id': keyId }],
          },
          {
            '@id': keyId,
            [`${SEC.namespace}controller`]: [{ '@id': subject }],
            [`${SEC.namespace}publicKeyJwk`]: [{ '@value': JSON.stringify(publicJwk) }],
          },
        ]), 'application/ld+json', 200, subject));
        const token = await sign(claims);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .resolves.toEqual({ subject, issuer: subject, client: subject });
      });

      it('resolves the key from the authentication relationship.', async(): Promise<void> => {
        profile(`
          <${subject}> sec:authentication <${keyId}>.
          <${keyId}> sec:publicKeyJwk """${JSON.stringify(publicJwk)}""".
        `);
        const token = await sign(claims, { kid: keyId });
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .resolves.toEqual({ subject, issuer: subject, client: subject });
      });

      it('rejects a profile whose key is controlled by someone else.', async(): Promise<void> => {
        profile(`
          <${subject}> sec:verificationMethod <${keyId}>.
          <${keyId}> sec:controller <https://other.example/#me>.
          <${keyId}> sec:publicKeyJwk """${JSON.stringify(publicJwk)}""".
        `);
        const token = await sign(claims);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .rejects.toThrow(`The verification method ${keyId} is not controlled by ${subject}.`);
      });

      it('rejects a profile without the verification method.', async(): Promise<void> => {
        profile(`
          <${subject}> <https://www.w3.org/ns/solid/terms#oidcIssuer> <https://idp.example/>.
          <${subject}> sec:verificationMethod <${subject}#other>.
        `);
        const token = await sign(claims);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .rejects.toThrow(`${subject} has no verification method ${keyId}.`);
      });

      it('rejects a profile that states the method about another subject.', async(): Promise<void> => {
        profile(`
          <https://other.example/#me> sec:verificationMethod <${keyId}>.
          <${keyId}> sec:publicKeyJwk """${JSON.stringify(publicJwk)}""".
        `);
        const token = await sign(claims);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .rejects.toThrow(`${subject} has no verification method ${keyId}.`);
      });

      it('rejects a verification method without a public key.', async(): Promise<void> => {
        profile(`
          <${subject}> sec:verificationMethod <${keyId}>.
          <${keyId}> sec:controller <${subject}>.
        `);
        const token = await sign(claims);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .rejects.toThrow(`${subject} has no verification method ${keyId}.`);
      });

      it('rejects a profile whose key is not a JSON Web Key.', async(): Promise<void> => {
        profile(`
          <${subject}> sec:verificationMethod <${keyId}>.
          <${keyId}> sec:publicKeyJwk "not a key".
        `);
        const token = await sign(claims);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .rejects.toThrow(`${subject} has no verification method ${keyId}.`);
      });

      it('rejects a document that can not be parsed as RDF.', async(): Promise<void> => {
        profile('<a> <b> "c');
        const token = await sign(claims);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .rejects.toThrow(`${subject} is not a valid controlled identifier document.`);
      });

      it('resolves the key of a WebID that has a fragment.', async(): Promise<void> => {
        // A WebID is the subject, so its fragment is not part of the identifier of the verification method
        const webId = `${subject}#me`;
        fetchMock.mockResolvedValueOnce(mockResponse(
          `@prefix sec: <${SEC.namespace}>. <#me> sec:verificationMethod <#key-1>.
           <#key-1> sec:publicKeyJwk """${JSON.stringify(publicJwk)}""".`,
          'text/turtle',
          200,
          subject,
        ));
        const token = await sign({ sub: webId, iss: webId, client_id: webId });
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
          .resolves.toEqual({ subject: webId, issuer: webId, client: webId });
      });
    });
  });

  describe('with registered keys', (): void => {
    it('uses the registered key without retrieving the document.', async(): Promise<void> => {
      keys.findByWebId.mockResolvedValueOnce([ registeredKey() ]);
      keys.findKey.mockResolvedValueOnce(registeredKey());
      const token = await sign({ ...claims, aud: audience });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .resolves.toEqual({ subject, issuer: subject, client: subject });
      expect(keys.findByWebId).toHaveBeenCalledTimes(1);
      expect(keys.findByWebId).toHaveBeenLastCalledWith(subject);
      expect(keys.findKey).toHaveBeenLastCalledWith(subject, keyId);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it('rejects a key that is not registered, without retrieving the document.', async(): Promise<void> => {
      keys.findByWebId.mockResolvedValueOnce([ registeredKey() ]);
      const token = await sign({ ...claims, aud: audience }, { kid: '#other' });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`${subject} has no registered verification method ${subject}#other.`);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it('rejects subjects without registered keys if document retrieval is disabled.', async(): Promise<void> => {
      verifier = new CidSubjectTokenVerifier({ converter, keys });
      const token = await sign({ ...claims, aud: audience });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(`${subject} has no registered verification methods and retrieving its document is disabled.`);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });
  });
});
