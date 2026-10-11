import crypto from 'node:crypto';
import type { JWK } from 'jose';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import {
  BaseIdentityKeyStore,
  IDENTITY_KEY_STORAGE_DESCRIPTION,
  IDENTITY_KEY_STORAGE_TYPE,
} from '../../../../src/identity/lws/BaseIdentityKeyStore';
import type { IdentityKey } from '../../../../src/identity/lws/IdentityKeyStore';
import type { AccountLoginStorage } from '../../../../src/identity/interaction/account/util/LoginStorage';
import { InternalServerError } from '../../../../src/util/errors/InternalServerError';

const uuid = '4c9b88c1-7502-4107-bb79-2a3a590c7aa3';

describe('A BaseIdentityKeyStore', (): void => {
  const webId = 'http://example.com/card';
  const webIdWithFragment = `${webId}#me`;
  const id = 'id';
  const accountId = 'accountId';
  const label = 'key-1';
  const keyId = `${webId}#${label}`;
  let jwk: JWK;
  let record: { id: string; webId: string; accountId: string; keyId: string; jwk: string; label: string };
  let key: IdentityKey;
  let storage: jest.Mocked<AccountLoginStorage<any>>;
  let store: BaseIdentityKeyStore;

  beforeAll(async(): Promise<void> => {
    const { publicKey } = await generateKeyPair('ES256');
    jwk = await exportJWK(publicKey);
  });

  beforeEach(async(): Promise<void> => {
    jest.spyOn(crypto, 'randomUUID').mockReturnValue(uuid);
    record = { id, webId, accountId, keyId, label, jwk: JSON.stringify(jwk) };
    key = { id, webId, accountId, keyId, label, jwk };
    storage = {
      defineType: jest.fn().mockResolvedValue({}),
      createIndex: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue(record),
      get: jest.fn().mockResolvedValue(record),
      find: jest.fn().mockResolvedValue([ record ]),
      delete: jest.fn(),
    } satisfies Partial<AccountLoginStorage<any>> as any;

    store = new BaseIdentityKeyStore(storage);
  });

  it('defines the type and index in the storage.', async(): Promise<void> => {
    await expect(store.handle()).resolves.toBeUndefined();
    expect(storage.defineType).toHaveBeenCalledTimes(1);
    expect(storage.defineType)
      .toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, IDENTITY_KEY_STORAGE_DESCRIPTION, false);
    expect(storage.createIndex).toHaveBeenCalledTimes(1);
    expect(storage.createIndex).toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, 'webId');
  });

  it('can only initialize once.', async(): Promise<void> => {
    await expect(store.handle()).resolves.toBeUndefined();
    await expect(store.handle()).resolves.toBeUndefined();
    expect(storage.defineType).toHaveBeenCalledTimes(1);
  });

  it('throws an error if defining the type goes wrong.', async(): Promise<void> => {
    storage.defineType.mockRejectedValueOnce(new Error('bad data'));
    await expect(store.handle()).rejects.toThrow(InternalServerError);
  });

  it('returns the key it finds.', async(): Promise<void> => {
    await expect(store.get(id)).resolves.toEqual(key);
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(storage.get).toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, id);
  });

  it('returns undefined if there is no key with that identifier.', async(): Promise<void> => {
    storage.get.mockResolvedValueOnce(undefined);
    await expect(store.get(id)).resolves.toBeUndefined();
  });

  it('returns all keys of the document of a WebID.', async(): Promise<void> => {
    await expect(store.findByWebId(webIdWithFragment)).resolves.toEqual([ key ]);
    expect(storage.find).toHaveBeenCalledTimes(1);
    expect(storage.find).toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, { webId });
  });

  it('returns all keys registered by an account.', async(): Promise<void> => {
    await expect(store.findByAccount(accountId)).resolves.toEqual([ key ]);
    expect(storage.find).toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, { accountId });
  });

  it('finds a key by its identifier.', async(): Promise<void> => {
    await expect(store.findKey(webIdWithFragment, keyId)).resolves.toEqual(key);
  });

  it('finds a key by the thumbprint of its key.', async(): Promise<void> => {
    const thumbprint = await calculateJwkThumbprint(jwk);
    await expect(store.findKey(webId, thumbprint)).resolves.toEqual(key);
    await expect(store.findKey(webId, `${webId}#${thumbprint}`)).resolves.toEqual(key);
  });

  it('returns undefined if no key matches the identifier.', async(): Promise<void> => {
    await expect(store.findKey(webId, 'unknown')).resolves.toBeUndefined();
  });

  it('creates a key with the provided label.', async(): Promise<void> => {
    storage.find.mockResolvedValueOnce([]);
    await expect(store.create(webIdWithFragment, accountId, jwk, label)).resolves.toEqual(key);
    expect(storage.create).toHaveBeenCalledTimes(1);
    expect(storage.create).toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, {
      webId,
      accountId,
      keyId,
      label,
      jwk: JSON.stringify(jwk),
    });
    expect(storage.delete).toHaveBeenCalledTimes(0);
  });

  it('generates an identifier if there is no label.', async(): Promise<void> => {
    storage.find.mockResolvedValueOnce([]);
    await expect(store.create(webId, accountId, jwk)).resolves.toEqual(key);
    expect(storage.create).toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, {
      webId,
      accountId,
      keyId: `${webId}#${uuid}`,
      label: uuid,
      jwk: JSON.stringify(jwk),
    });
  });

  it('replaces a key with the same identifier.', async(): Promise<void> => {
    await expect(store.create(webId, accountId, jwk, label)).resolves.toEqual(key);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, id);
  });

  it('deletes a key.', async(): Promise<void> => {
    await expect(store.delete(id)).resolves.toBeUndefined();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenLastCalledWith(IDENTITY_KEY_STORAGE_TYPE, id);
  });

  it('deletes all keys of a WebID.', async(): Promise<void> => {
    storage.find.mockResolvedValueOnce([ record, { ...record, id: 'otherId', keyId: `${webId}#other` }]);
    await expect(store.deleteByWebId(webIdWithFragment)).resolves.toBeUndefined();
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(storage.delete).toHaveBeenNthCalledWith(1, IDENTITY_KEY_STORAGE_TYPE, id);
    expect(storage.delete).toHaveBeenNthCalledWith(2, IDENTITY_KEY_STORAGE_TYPE, 'otherId');
  });
});
