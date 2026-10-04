import { fetch } from 'cross-fetch';
import type { KeyLike } from 'jose';
import { createRemoteJWKSet, generateKeyPair, SignJWT } from 'jose';
import { LwsAccessTokenExtractor } from '../../../src/authentication/LwsAccessTokenExtractor';
import type { TargetExtractor } from '../../../src/http/input/identifier/TargetExtractor';
import { CachedJwkGenerator } from '../../../src/identity/configuration/CachedJwkGenerator';
import { LwsAccessTokenIssuer } from '../../../src/identity/lws/LwsAccessTokenIssuer';
import type { StorageLocationStrategy } from '../../../src/server/description/StorageLocationStrategy';
import type { HttpRequest } from '../../../src/server/HttpRequest';
import { MemoryMapStorage } from '../../../src/storage/keyvalue/MemoryMapStorage';
import { NotImplementedHttpError } from '../../../src/util/errors/NotImplementedHttpError';
import { UnauthorizedHttpError } from '../../../src/util/errors/UnauthorizedHttpError';
import { SOLID_ERROR } from '../../../src/util/Vocabularies';

jest.mock('cross-fetch');
jest.mock('jose', (): any => ({
  ...jest.requireActual('jose'),
  createRemoteJWKSet: jest.fn(),
}));

function createRequest(token?: string): HttpRequest {
  return { method: 'GET', headers: token === undefined ? {} : { authorization: `Bearer ${token}` }} as HttpRequest;
}

describe('An LwsAccessTokenExtractor', (): void => {
  const fetchMock: jest.Mock = fetch as any;
  const createRemoteJWKSetMock: jest.Mock = createRemoteJWKSet as any;
  const storage = 'https://storage.example/alice/';
  const target = { path: `${storage}foo` };
  const subject = 'https://alice.example/profile#me';
  const client = 'https://app.example/id';
  const externalIssuer = 'https://as.example/lws/';
  const jwksUri = 'https://as.example/jwks';
  const issuer = new LwsAccessTokenIssuer('https://storage.example/', new CachedJwkGenerator('ES256', 'jwks', new MemoryMapStorage()));
  let externalKey: KeyLike;
  let externalPublicKey: KeyLike;
  let metadata: unknown;
  let targetExtractor: jest.Mocked<TargetExtractor>;
  let storageStrategy: jest.Mocked<StorageLocationStrategy>;
  let extractor: LwsAccessTokenExtractor;

  async function signExternal(payload: Record<string, unknown>, iat?: number): Promise<string> {
    return new SignJWT({ sub: subject, aud: storage, ...payload })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
      .setIssuer(externalIssuer)
      .setIssuedAt(iat)
      .setExpirationTime('5m')
      .sign(externalKey);
  }

  async function expectInvalid(request: HttpRequest, message: string): Promise<void> {
    const result = extractor.handle(request);
    await expect(result).rejects.toThrow(UnauthorizedHttpError);
    await expect(result).rejects.toThrow(message);
    const error: UnauthorizedHttpError = await result.catch((err: unknown): any => err);
    expect(error.metadata.get(SOLID_ERROR.terms.bearerError)?.value).toBe('invalid_token');
  }

  beforeAll(async(): Promise<void> => {
    ({ privateKey: externalKey, publicKey: externalPublicKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async(): Promise<void> => {
    metadata = { issuer: externalIssuer, jwks_uri: jwksUri };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async(): Promise<unknown> => ({ json: async(): Promise<unknown> => metadata }));
    createRemoteJWKSetMock.mockReset();
    createRemoteJWKSetMock.mockReturnValue(async(): Promise<KeyLike> => externalPublicKey);

    targetExtractor = {
      handleSafe: jest.fn().mockResolvedValue(target),
    } as any;
    storageStrategy = {
      getStorageIdentifier: jest.fn().mockResolvedValue({ path: storage }),
    };

    extractor = new LwsAccessTokenExtractor({ issuer, targetExtractor, storageStrategy });
  });

  describe('#canHandle', (): void => {
    it('requires a Bearer Authorization header.', async(): Promise<void> => {
      await expect(extractor.canHandle(createRequest())).rejects.toThrow(NotImplementedHttpError);
      await expect(extractor.canHandle({ headers: { authorization: 'DPoP token' }} as HttpRequest))
        .rejects.toThrow('No Bearer Authorization header specified.');
      await expect(extractor.canHandle(createRequest('token'))).resolves.toBeUndefined();
    });

    it('does not check the token if Solid-OIDC tokens are not skipped.', async(): Promise<void> => {
      const token = await signExternal({ webid: subject });
      await expect(extractor.canHandle(createRequest(token))).resolves.toBeUndefined();
    });

    it('can skip tokens with a webid claim.', async(): Promise<void> => {
      extractor = new LwsAccessTokenExtractor({ issuer, targetExtractor, storageStrategy, skipWebIdTokens: true });
      await expect(extractor.canHandle(createRequest(await signExternal({ webid: subject }))))
        .rejects.toThrow('Solid-OIDC access tokens are handled by a different extractor.');
      await expect(extractor.canHandle(createRequest(await signExternal({})))).resolves.toBeUndefined();
      await expect(extractor.canHandle(createRequest('invalid'))).resolves.toBeUndefined();
    });
  });

  describe('#handle', (): void => {
    it('returns the credentials of tokens issued by this server.', async(): Promise<void> => {
      const token = await issuer.issue(subject, client, storage);
      await expect(extractor.handle(createRequest(token))).resolves.toEqual({
        agent: { webId: subject },
        client: { clientId: client },
        issuer: { url: 'https://storage.example/' },
      });
      expect(targetExtractor.handleSafe).toHaveBeenLastCalledWith({ request: expect.any(Object) });
      expect(storageStrategy.getStorageIdentifier).toHaveBeenLastCalledWith(target);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it('rejects invalid tokens.', async(): Promise<void> => {
      await expectInvalid(createRequest('invalid'), 'Invalid LWS access token: ');
      const token = await new SignJWT({ sub: subject, aud: storage, client_id: client })
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
        .setIssuer(issuer.issuer)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti('jti')
        .sign(externalKey);
      await expectInvalid(createRequest(token), 'Invalid LWS access token: signature verification failed');
    });

    it('rejects tokens of untrusted issuers.', async(): Promise<void> => {
      await expectInvalid(
        createRequest(await signExternal({})),
        `Invalid LWS access token: Untrusted issuer ${externalIssuer}`,
      );
      const token = await new SignJWT({ sub: subject, aud: storage })
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(externalKey);
      await expectInvalid(createRequest(token), 'Invalid LWS access token: Untrusted issuer undefined');
    });

    it('requires exactly one string audience.', async(): Promise<void> => {
      const message = 'The audience of an LWS access token needs to contain exactly one value.';
      await expectInvalid(createRequest(await issuer.issue(subject, client, [ storage, 'https://other.example/' ] as any)), message);
      await expectInvalid(createRequest(await issuer.issue(subject, client, 5 as any)), message);
    });

    it('requires the audience to be the storage containing the target.', async(): Promise<void> => {
      const message = `The LWS access token is not intended for the storage containing ${target.path}.`;
      const token = await issuer.issue(subject, client, 'https://storage.example/bob/');
      await expectInvalid(createRequest(token), message);
      storageStrategy.getStorageIdentifier.mockRejectedValueOnce(new Error('no storage'));
      await expectInvalid(createRequest(await issuer.issue(subject, client, storage)), message);
    });

    describe('with trusted issuers', (): void => {
      beforeEach(async(): Promise<void> => {
        extractor = new LwsAccessTokenExtractor({
          issuer,
          targetExtractor,
          storageStrategy,
          trustedIssuers: [ 'https://as.example/lws' ],
          clockTolerance: 30,
        });
      });

      it('accepts tokens of trusted issuers.', async(): Promise<void> => {
        const token = await signExternal({ client_id: client });
        await expect(extractor.handle(createRequest(token))).resolves.toEqual({
          agent: { webId: subject },
          client: { clientId: client },
          issuer: { url: externalIssuer },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenLastCalledWith('https://as.example/.well-known/lws-configuration/lws', { headers: { accept: 'application/json' }});
        expect(createRemoteJWKSetMock).toHaveBeenLastCalledWith(new URL(jwksUri));

        // The keys are cached
        await expect(extractor.handle(createRequest(await signExternal({})))).resolves.toEqual({
          agent: { webId: subject },
          issuer: { url: externalIssuer },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
      });

      it('rejects tokens of trusted issuers with an invalid signature.', async(): Promise<void> => {
        createRemoteJWKSetMock.mockReturnValue(async(): Promise<KeyLike> => (await generateKeyPair('ES256')).publicKey);
        await expectInvalid(
          createRequest(await signExternal({})),
          'Invalid LWS access token: signature verification failed',
        );
      });

      it('rejects tokens issued in the future.', async(): Promise<void> => {
        const token = await signExternal({}, Math.floor(Date.now() / 1000) + 60);
        await expectInvalid(createRequest(token), 'Invalid LWS access token: The iat claim is in the future.');
      });

      it('rejects issuers with invalid metadata.', async(): Promise<void> => {
        const message = 'Invalid LWS access token: Invalid authorization server metadata at ' +
          'https://as.example/.well-known/lws-configuration/lws';
        const token = await signExternal({});
        metadata = [];
        await expectInvalid(createRequest(token), message);
        metadata = { issuer: 'https://as.example/lws', jwks_uri: jwksUri };
        await expectInvalid(createRequest(token), message);
        metadata = { issuer: externalIssuer };
        await expectInvalid(createRequest(token), message);
      });
    });
  });
});
