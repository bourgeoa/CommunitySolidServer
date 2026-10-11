import {
  CreateIdentityKeyHandler,
} from '../../../../../src/identity/interaction/identity-keys/CreateIdentityKeyHandler';
import type {
  IdentityKeyIdRoute,
} from '../../../../../src/identity/interaction/identity-keys/util/IdentityKeyRoute';
import type { WebIdStore } from '../../../../../src/identity/interaction/webid/util/WebIdStore';
import type { IdentityKey, IdentityKeyStore } from '../../../../../src/identity/lws/IdentityKeyStore';
import { BadRequestHttpError } from '../../../../../src/util/errors/BadRequestHttpError';

describe('A CreateIdentityKeyHandler', (): void => {
  const webId = 'http://example.com/card#me';
  const id = 'id';
  const accountId = 'accountId';
  const label = 'key-1';
  const keyId = `${webId}#${label}`;
  const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
  const key: IdentityKey = { id, webId, accountId, keyId, label, jwk };
  const resource = 'http://example.com/key';
  const json = { webId, label, publicKeyJwk: jwk };
  let route: jest.Mocked<IdentityKeyIdRoute>;
  let webIdStore: jest.Mocked<WebIdStore>;
  let keyStore: jest.Mocked<IdentityKeyStore>;
  let handler: CreateIdentityKeyHandler;

  beforeEach(async(): Promise<void> => {
    route = {
      getPath: jest.fn().mockReturnValue(resource),
      matchPath: jest.fn().mockReturnValue({ accountId, identityKeyId: id }),
    };

    webIdStore = {
      isLinked: jest.fn().mockResolvedValue(true),
    } satisfies Partial<WebIdStore> as any;

    keyStore = {
      create: jest.fn().mockResolvedValue(key),
      findByAccount: jest.fn().mockResolvedValue([ key ]),
    } satisfies Partial<IdentityKeyStore> as any;

    handler = new CreateIdentityKeyHandler(webIdStore, keyStore, route);
  });

  it('shows the required fields and the keys of the WebIDs of the account.', async(): Promise<void> => {
    await expect(handler.getView({ accountId } as any)).resolves.toEqual({
      json: {
        keys: {
          [label]: keyId,
        },
        fields: {
          label: { required: false, type: 'string' },
          publicKeyJwk: {
            required: true,
            type: 'object',
            fields: { kty: { required: true, type: 'string' }},
          },
          webId: { required: true, type: 'string' },
        },
      },
    });
    expect(keyStore.findByAccount).toHaveBeenCalledTimes(1);
    expect(keyStore.findByAccount).toHaveBeenLastCalledWith(accountId);
  });

  it('registers a new key based on the provided settings.', async(): Promise<void> => {
    await expect(handler.handle({ accountId, json } as any)).resolves.toEqual({
      json: { id, keyId, label, webId, resource },
    });
    expect(webIdStore.isLinked).toHaveBeenCalledTimes(1);
    expect(webIdStore.isLinked).toHaveBeenLastCalledWith(webId, accountId);
    expect(keyStore.create).toHaveBeenCalledTimes(1);
    expect(keyStore.create).toHaveBeenLastCalledWith(webId, accountId, jwk, label);
    expect(route.getPath).toHaveBeenCalledTimes(1);
    expect(route.getPath).toHaveBeenLastCalledWith({ accountId, identityKeyId: id });
  });

  it('allows registering a key without a label.', async(): Promise<void> => {
    await expect(handler.handle({ accountId, json: { webId, publicKeyJwk: jwk }} as any))
      .resolves.toEqual({ json: { id, keyId, label, webId, resource }});
    expect(keyStore.create).toHaveBeenCalledTimes(1);
    expect(keyStore.create).toHaveBeenLastCalledWith(webId, accountId, jwk, undefined);
  });

  it('errors if no key is provided.', async(): Promise<void> => {
    await expect(handler.handle({ accountId, json: { webId }} as any)).rejects.toThrow(BadRequestHttpError);
    expect(keyStore.create).toHaveBeenCalledTimes(0);
  });

  it('errors if the account does not control the WebID.', async(): Promise<void> => {
    webIdStore.isLinked.mockResolvedValueOnce(false);
    await expect(handler.handle({ accountId, json } as any)).rejects.toThrow(BadRequestHttpError);
    expect(webIdStore.isLinked).toHaveBeenCalledTimes(1);
    expect(webIdStore.isLinked).toHaveBeenLastCalledWith(webId, accountId);
    expect(keyStore.create).toHaveBeenCalledTimes(0);
  });
});
