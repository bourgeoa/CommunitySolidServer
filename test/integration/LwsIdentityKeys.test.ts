import fetch from 'cross-fetch';
import type { JWK, KeyLike } from 'jose';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AccountStore } from '../../src/identity/interaction/account/util/AccountStore';
import type { PasswordStore } from '../../src/identity/interaction/password/util/PasswordStore';
import type { WebIdStore } from '../../src/identity/interaction/webid/util/WebIdStore';
import type { IdentityKeyStore } from '../../src/identity/lws/IdentityKeyStore';
import type { App } from '../../src/init/App';
import type { ResourceStore } from '../../src/storage/ResourceStore';
import { AclHelper } from '../util/AclHelper';
import { getPort } from '../util/Util';
import { getDefaultVariables, getPresetConfigPath, getTestConfigPath, instantiateFromConfig } from './Config';

const port = getPort('LwsIdentityKeys');
const baseUrl = `http://localhost:${port}/`;

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt';

// This document is not served by the test server,
// so a credential for this subject can only be verified with a registered key.
const webId = 'https://alice.example/profile/card#me';
const documentId = 'https://alice.example/profile/card';

describe('A server with registered identity keys', (): void => {
  let app: App;
  let store: ResourceStore;
  let keyStore: IdentityKeyStore;
  let accountStore: AccountStore;
  let webIdStore: WebIdStore;
  let passwordStore: PasswordStore;
  let accountId: string;
  let privateKey: KeyLike;
  let publicJwk: JWK;

  async function exchange(kid: string, key: KeyLike = privateKey, subject = webId): Promise<Response> {
    const credential = await new SignJWT({ client_id: subject })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setSubject(subject)
      .setIssuer(subject)
      .setAudience(baseUrl)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
    return fetch(`${baseUrl}.well-known/lws/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        resource: baseUrl,
        subject_token: credential,
        subject_token_type: TOKEN_TYPE_JWT,
      }).toString(),
    });
  }

  beforeAll(async(): Promise<void> => {
    const instances = await instantiateFromConfig(
      'urn:solid-server:test:Instances',
      [
        getTestConfigPath('lws-server.json'),
        getPresetConfigPath('ldp/authentication/lws.json'),
        getPresetConfigPath('ldp/handler/lws.json'),
        getPresetConfigPath('ldp/metadata-writer/lws.json'),
        getPresetConfigPath('util/representation-conversion/lws.json'),
        getPresetConfigPath('ldp/authorization/webacl.json'),
        getPresetConfigPath('util/auxiliary/acl.json'),
      ],
      getDefaultVariables(port, baseUrl),
    ) as Record<string, any>;
    ({ app, store, keyStore, accountStore, webIdStore, passwordStore } = instances);
    await app.start();

    // The storage needs to exist for the authorization server to accept it as a target
    await new AclHelper(store).setSimpleAcl(baseUrl, {
      permissions: { read: true, write: true, append: true, control: true },
      agentClass: 'agent',
      accessTo: true,
      default: true,
    });

    const keys = await generateKeyPair('ES256');
    privateKey = keys.privateKey;
    publicJwk = await exportJWK(keys.publicKey);

    // Keys are registered for a WebID by the account that controls it,
    // which needs a login method before it can be used to store data
    accountId = await accountStore.create();
    await passwordStore.create('alice@example.com', accountId, 'password123!');
    await webIdStore.create(webId, accountId);
  });

  afterAll(async(): Promise<void> => {
    await app.stop();
  });

  it('rejects a credential of a subject without registered keys.', async(): Promise<void> => {
    const response = await exchange('#key-1');
    expect(response.status).toBe(400);
    await expect(response.text()).resolves
      .toContain(`${documentId} has no registered verification methods and retrieving its document is disabled.`);
  });

  it('registers a key for the document of a WebID.', async(): Promise<void> => {
    const key = await keyStore.create(webId, accountId, publicJwk, 'key-1');
    expect(key.keyId).toBe(`${documentId}#key-1`);
    expect(key.label).toBe('key-1');
    await expect(keyStore.findByWebId(webId)).resolves.toHaveLength(1);
    await expect(keyStore.findByAccount(accountId)).resolves.toHaveLength(1);
  });

  it('accepts a credential signed with a registered key.', async(): Promise<void> => {
    const response = await exchange('#key-1');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      token_type: 'Bearer',
      access_token: expect.any(String),
    }));
  });

  it('accepts the thumbprint of a registered key as the key identifier.', async(): Promise<void> => {
    const thumbprint = await calculateJwkThumbprint(publicJwk);
    const response = await exchange(thumbprint);
    expect(response.status).toBe(200);
  });

  it('rejects a credential signed with a different key.', async(): Promise<void> => {
    const { privateKey: otherKey } = await generateKeyPair('ES256');
    const response = await exchange('#key-1', otherKey);
    expect(response.status).toBe(400);
  });

  it('rejects a credential of another subject.', async(): Promise<void> => {
    const response = await exchange('#key-1', privateKey, 'https://bob.example/profile/card#me');
    expect(response.status).toBe(400);
  });

  it('rejects a credential after the key is removed.', async(): Promise<void> => {
    const keys = await keyStore.findByWebId(webId);
    for (const key of keys) {
      await keyStore.delete(key.id);
    }
    const response = await exchange('#key-1');
    expect(response.status).toBe(400);
  });

  it('rejects a credential after the keys of the WebID are removed.', async(): Promise<void> => {
    await keyStore.create(webId, accountId, publicJwk, 'key-1');
    await keyStore.deleteByWebId(webId);
    await expect(keyStore.findByWebId(webId)).resolves.toHaveLength(0);
    const response = await exchange('#key-1');
    expect(response.status).toBe(400);
  });
});
