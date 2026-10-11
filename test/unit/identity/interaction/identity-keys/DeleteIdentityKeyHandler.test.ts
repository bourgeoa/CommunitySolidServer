import {
  DeleteIdentityKeyHandler,
} from '../../../../../src/identity/interaction/identity-keys/DeleteIdentityKeyHandler';
import type {
  IdentityKeyIdRoute,
} from '../../../../../src/identity/interaction/identity-keys/util/IdentityKeyRoute';
import type { IdentityKey, IdentityKeyStore } from '../../../../../src/identity/lws/IdentityKeyStore';
import { NotFoundHttpError } from '../../../../../src/util/errors/NotFoundHttpError';

describe('A DeleteIdentityKeyHandler', (): void => {
  const webId = 'http://example.com/card';
  const id = 'id';
  const accountId = 'accountId';
  const label = 'key-1';
  const keyId = `${webId}#${label}`;
  const key: IdentityKey = { id, webId, accountId, keyId, label, jwk: { kty: 'EC' }};
  const target = { path: `http://example.com/.account/${accountId}/identity-keys/${id}` };
  let route: jest.Mocked<IdentityKeyIdRoute>;
  let keyStore: jest.Mocked<IdentityKeyStore>;
  let handler: DeleteIdentityKeyHandler;

  beforeEach(async(): Promise<void> => {
    route = {
      getPath: jest.fn(),
      matchPath: jest.fn().mockReturnValue({ accountId, identityKeyId: id }),
    };

    keyStore = {
      get: jest.fn().mockResolvedValue(key),
      delete: jest.fn(),
    } satisfies Partial<IdentityKeyStore> as any;

    handler = new DeleteIdentityKeyHandler(keyStore, route);
  });

  it('deletes the key of the account.', async(): Promise<void> => {
    await expect(handler.handle({ target, accountId } as any)).resolves.toEqual({ json: {}});
    expect(keyStore.get).toHaveBeenCalledTimes(1);
    expect(keyStore.get).toHaveBeenLastCalledWith(id);
    expect(keyStore.delete).toHaveBeenCalledTimes(1);
    expect(keyStore.delete).toHaveBeenLastCalledWith(id);
  });

  it('throws a 404 if the key does not exist.', async(): Promise<void> => {
    keyStore.get.mockResolvedValueOnce(undefined);
    await expect(handler.handle({ target, accountId } as any)).rejects.toThrow(NotFoundHttpError);
    expect(keyStore.delete).toHaveBeenCalledTimes(0);
  });

  it('throws a 404 if the account is not the owner of the key.', async(): Promise<void> => {
    await expect(handler.handle({ target, accountId: 'otherId' } as any)).rejects.toThrow(NotFoundHttpError);
    expect(keyStore.get).toHaveBeenCalledTimes(1);
    expect(keyStore.delete).toHaveBeenCalledTimes(0);
  });

  it('throws a 404 if there is no account.', async(): Promise<void> => {
    await expect(handler.handle({ target } as any)).rejects.toThrow(NotFoundHttpError);
    expect(keyStore.delete).toHaveBeenCalledTimes(0);
  });
});
