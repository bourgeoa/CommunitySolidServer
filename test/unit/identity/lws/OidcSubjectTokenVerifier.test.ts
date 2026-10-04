import { fetch } from 'cross-fetch';
import type { KeyLike } from 'jose';
import { createRemoteJWKSet, generateKeyPair, SignJWT } from 'jose';
import { OidcSubjectTokenVerifier } from '../../../../src/identity/lws/OidcSubjectTokenVerifier';
import {
  TOKEN_TYPE_ID_TOKEN,
  TOKEN_TYPE_ID_TOKEN_ALT,
  TOKEN_TYPE_JWT,
} from '../../../../src/identity/lws/SubjectTokenVerifier';
import { RdfToQuadConverter } from '../../../../src/storage/conversion/RdfToQuadConverter';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { LWS, SOLID } from '../../../../src/util/Vocabularies';

jest.mock('cross-fetch');
jest.mock('jose', (): any => ({
  ...jest.requireActual('jose'),
  createRemoteJWKSet: jest.fn(),
}));

interface MockResponse {
  status: number;
  url: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function mockResponse(body: string, contentType?: string, status = 200, url = ''): MockResponse {
  return {
    status,
    url,
    headers: { get: (name: string): string | null => name === 'content-type' ? contentType ?? null : null },
    text: async(): Promise<string> => body,
    json: async(): Promise<unknown> => JSON.parse(body),
  };
}

describe('An OidcSubjectTokenVerifier', (): void => {
  const fetchMock: jest.Mock = fetch as any;
  const createRemoteJWKSetMock: jest.Mock = createRemoteJWKSet as any;
  const audience = 'https://as.example/';
  const subject = 'https://alice.example/profile#me';
  const issuer = 'https://idp.example/';
  const client = 'https://app.example/id';
  const jwksUri = 'https://idp.example/jwks';
  const converter = new RdfToQuadConverter();
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let subjectDocument: MockResponse;
  let configuration: MockResponse;
  let verifier: OidcSubjectTokenVerifier;

  async function sign(payload: Record<string, unknown>, iat?: number): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt(iat)
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  function cidDocument(services: unknown): MockResponse {
    return mockResponse(JSON.stringify({ id: subject, service: services }), 'application/ld+json');
  }

  beforeAll(async(): Promise<void> => {
    ({ privateKey, publicKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async(): Promise<void> => {
    subjectDocument = cidDocument([{ type: LWS.OpenIdProvider, serviceEndpoint: issuer }]);
    configuration = mockResponse(JSON.stringify({ issuer, jwks_uri: jwksUri }), 'application/json');
    fetchMock.mockReset();
    fetchMock.mockImplementation(async(url: string): Promise<MockResponse> =>
      url.endsWith('/.well-known/openid-configuration') ? configuration : subjectDocument);
    createRemoteJWKSetMock.mockReset();
    createRemoteJWKSetMock.mockReturnValue(async(): Promise<KeyLike> => publicKey);
    verifier = new OidcSubjectTokenVerifier({ converter });
  });

  describe('#canHandle', (): void => {
    it('accepts ID tokens.', async(): Promise<void> => {
      await expect(verifier.canHandle({ token: 'token', tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .resolves.toBeUndefined();
      await expect(verifier.canHandle({ token: 'token', tokenType: TOKEN_TYPE_ID_TOKEN_ALT, audience }))
        .resolves.toBeUndefined();
    });

    it('rejects other token types.', async(): Promise<void> => {
      await expect(verifier.canHandle({ token: 'token', tokenType: TOKEN_TYPE_JWT, audience }))
        .rejects.toThrow(NotImplementedHttpError);
    });
  });

  describe('#handle', (): void => {
    it('verifies ID tokens with a matching LWS OpenID provider service.', async(): Promise<void> => {
      const token = await sign({ sub: subject, iss: issuer, aud: [ client, audience ], azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .resolves.toEqual({ subject, issuer, client });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(1, subject, expect.any(Object));
      expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://idp.example/.well-known/openid-configuration');
      expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
      expect(createRemoteJWKSetMock).toHaveBeenLastCalledWith(new URL(jwksUri));

      // The key set is cached
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .resolves.toEqual({ subject, issuer, client });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
    });

    it('uses the audience as client if there is no azp claim.', async(): Promise<void> => {
      let token = await sign({ sub: subject, iss: issuer, aud: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .resolves.toEqual({ subject, issuer, client });
      token = await sign({ sub: subject, iss: issuer, aud: [ client ]});
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .resolves.toEqual({ subject, issuer, client });
    });

    it('requires the sub, iss, and azp claims.', async(): Promise<void> => {
      const message = 'An ID token needs to contain the sub, iss, and azp claims.';
      let token = await sign({ sub: subject, iss: issuer, aud: [ client, audience ]});
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience })).rejects.toThrow(message);
      token = await sign({ sub: subject, iss: issuer });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience })).rejects.toThrow(message);
      token = await sign({ iss: issuer, azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience })).rejects.toThrow(message);
      token = await sign({ sub: subject, azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience })).rejects.toThrow(message);
    });

    it('requires HTTP(S) sub and iss claims.', async(): Promise<void> => {
      const message = 'The sub and iss claims of an ID token need to be HTTP(S) URIs.';
      let token = await sign({ sub: 'alice', iss: issuer, azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience })).rejects.toThrow(message);
      token = await sign({ sub: subject, iss: 'idp', azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience })).rejects.toThrow(message);
    });

    it('uses the webid claim of Solid-OIDC ID tokens as subject.', async(): Promise<void> => {
      let token = await sign({ sub: 'alice', webid: subject, iss: issuer, aud: 'solid', azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .rejects.toThrow('Invalid credential: the audience does not include');
      verifier = new OidcSubjectTokenVerifier({ converter, additionalAudiences: [ 'solid' ]});
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .resolves.toEqual({ subject, issuer, client });

      // The sub claim takes priority if it is a URI
      token = await sign({ sub: 'https://bob.example/#me', webid: subject, iss: issuer, azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .rejects.toThrow('https://bob.example/#me does not designate');

      verifier = new OidcSubjectTokenVerifier({ converter, acceptSolidOidcIssuer: false });
      token = await sign({ sub: 'alice', webid: subject, iss: issuer, azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .rejects.toThrow('The sub and iss claims of an ID token need to be HTTP(S) URIs.');
    });

    it('does not verify the subject document for trusted issuers.', async(): Promise<void> => {
      verifier = new OidcSubjectTokenVerifier({ converter, trustedIssuers: [ 'https://idp.example' ]});
      const token = await sign({ sub: subject, iss: issuer, azp: client });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .resolves.toEqual({ subject, issuer, client });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('uses the configured clock tolerance.', async(): Promise<void> => {
      const token = await sign({ sub: subject, iss: issuer, azp: client }, Math.floor(Date.now() / 1000) + 120);
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .rejects.toThrow('the iat claim is in the future');
      verifier = new OidcSubjectTokenVerifier({ converter, clockTolerance: 300 });
      await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
        .resolves.toEqual({ subject, issuer, client });
    });

    describe('verifying the subject document', (): void => {
      let token: string;

      beforeEach(async(): Promise<void> => {
        token = await sign({ sub: subject, iss: issuer, azp: client });
      });

      async function expectRejected(): Promise<void> {
        const result = verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience });
        await expect(result).rejects.toThrow(BadRequestHttpError);
        await expect(result).rejects.toThrow(`${subject} does not designate ${issuer} as its OpenID provider.`);
      }

      async function expectAccepted(): Promise<void> {
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
          .resolves.toEqual({ subject, issuer, client });
      }

      it('errors if the document can not be fetched.', async(): Promise<void> => {
        fetchMock.mockRejectedValueOnce(new Error('bad data'));
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
          .rejects.toThrow(`Unable to retrieve the controlled identifier document of ${subject}.`);
        subjectDocument = mockResponse('', 'text/plain', 404);
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
          .rejects.toThrow(`Unable to retrieve the controlled identifier document of ${subject}.`);
      });

      it('accepts services with multiple types and endpoints.', async(): Promise<void> => {
        subjectDocument = cidDocument([
          'https://alice.example/profile#service',
          { type: 'OtherService', serviceEndpoint: issuer },
          { type: [ 'Other', LWS.OpenIdProvider ], serviceEndpoint: [ 5, 'https://other.example/', 'https://idp.example' ]},
        ]);
        await expectAccepted();
      });

      it('rejects JSON documents without matching service.', async(): Promise<void> => {
        subjectDocument = cidDocument([{ type: LWS.OpenIdProvider, serviceEndpoint: 'https://other.example/' }]);
        await expectRejected();
      });

      it('rejects invalid JSON documents.', async(): Promise<void> => {
        subjectDocument = mockResponse('{ invalid', 'application/json');
        await expectRejected();
        subjectDocument = mockResponse('[]', 'application/json');
        await expectRejected();
        subjectDocument = mockResponse(JSON.stringify({ id: 'https://other.example/', service: []}), 'application/json');
        await expectRejected();
        subjectDocument = mockResponse(JSON.stringify({ id: subject, service: {}}), 'application/json');
        await expectRejected();
      });

      it('accepts RDF documents with a solid:oidcIssuer.', async(): Promise<void> => {
        subjectDocument = mockResponse(`<${subject}> <${SOLID.oidcIssuer}> <https://idp.example>.`, 'text/turtle');
        await expectAccepted();
      });

      it('does not accept a solid:oidcIssuer if configured to.', async(): Promise<void> => {
        verifier = new OidcSubjectTokenVerifier({ converter, acceptSolidOidcIssuer: false });
        subjectDocument = mockResponse(`<${subject}> <${SOLID.oidcIssuer}> <${issuer}>.`, 'text/turtle');
        await expectRejected();
      });

      it('accepts RDF documents with an LWS OpenID provider service.', async(): Promise<void> => {
        subjectDocument = mockResponse(`
          <${subject}> <${SOLID.oidcIssuer}> <https://other.example/>.
          <${subject}> <https://www.w3.org/ns/cid/v1#service> <https://alice.example/profile#other>.
          <${subject}> <https://www.w3.org/ns/cid/v1#service> <https://alice.example/profile#wrong>.
          <${subject}> <https://www.w3.org/ns/cid/v1#service> <https://alice.example/profile#oidc>.
          <https://alice.example/profile#wrong> a <${LWS.OpenIdProvider}>.
          <https://alice.example/profile#wrong> <https://www.w3.org/ns/cid/v1#serviceEndpoint> <https://other.example/>.
          <https://alice.example/profile#oidc> a <${LWS.OpenIdProvider}>.
          <https://alice.example/profile#oidc> <https://www.w3.org/ns/cid/v1#serviceEndpoint> <${issuer}>.
        `, 'text/turtle');
        await expectAccepted();
      });

      it('rejects RDF documents without matching service.', async(): Promise<void> => {
        subjectDocument = mockResponse(`
          <${subject}> <https://www.w3.org/ns/cid/v1#service> <https://alice.example/profile#oidc>.
          <https://alice.example/profile#oidc> a <${LWS.OpenIdProvider}>.
          <https://alice.example/profile#oidc> <https://www.w3.org/ns/cid/v1#serviceEndpoint> <https://other.example/>.
          <https://other.example/> <https://www.w3.org/ns/cid/v1#serviceEndpoint> <${issuer}>.
        `, 'text/turtle');
        await expectRejected();
      });

      it('rejects documents that can not be parsed as RDF.', async(): Promise<void> => {
        subjectDocument = mockResponse('<a> <b> "c', 'text/turtle');
        await expectRejected();
        subjectDocument = mockResponse('<a> <b> <c>.');
        await expectRejected();
      });
    });

    describe('discovering the keys of the issuer', (): void => {
      let token: string;

      beforeEach(async(): Promise<void> => {
        verifier = new OidcSubjectTokenVerifier({ converter, trustedIssuers: [ issuer ]});
        token = await sign({ sub: subject, iss: issuer, azp: client });
      });

      async function expectRejected(): Promise<void> {
        await expect(verifier.handle({ token, tokenType: TOKEN_TYPE_ID_TOKEN, audience }))
          .rejects.toThrow(`Unable to discover the keys of ${issuer}.`);
      }

      it('errors if the configuration can not be fetched.', async(): Promise<void> => {
        configuration = mockResponse('{ invalid', 'application/json');
        await expectRejected();
      });

      it('errors if the configuration is invalid.', async(): Promise<void> => {
        configuration = mockResponse('[]', 'application/json');
        await expectRejected();
        configuration = mockResponse(JSON.stringify({ issuer: 'https://other.example/', jwks_uri: jwksUri }));
        await expectRejected();
        configuration = mockResponse(JSON.stringify({ issuer }));
        await expectRejected();
      });
    });
  });
});
