import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import fetch from 'cross-fetch';
import type { JWK, KeyLike } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { App } from '../../src/init/App';
import type { ResourceStore } from '../../src/storage/ResourceStore';
import { AclHelper } from '../util/AclHelper';
import { AcpHelper } from '../util/AcpHelper';
import { getPort } from '../util/Util';
import { getDefaultVariables, getPresetConfigPath, getTestConfigPath, instantiateFromConfig } from './Config';

const port = getPort('LinkedWebStorage');
const baseUrl = `http://localhost:${port}/`;
const inboxPort = getPort('LinkedWebStorageInbox');
const inbox = `http://localhost:${inboxPort}/inbox`;

const LWS = 'https://www.w3.org/ns/lws#';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let result = '';
  while (value > 0n) {
    result = BASE58[Number(value % 58n)] + result;
    value /= 58n;
  }
  return result;
}

interface Agent {
  did: string;
  key: KeyLike;
}

/**
 * Generates a P-256 key and the corresponding did:key identifier.
 */
async function createAgent(): Promise<Agent> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk: JWK = await exportJWK(publicKey);
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  const prefix = (y.at(-1)! & 1) === 1 ? 3 : 2;
  const did = `did:key:z${encodeBase58(Buffer.concat([ Buffer.from([ 0x80, 0x24, prefix ]), x ]))}`;
  return { did, key: privateKey };
}

async function exchange(agent: Agent, resource = baseUrl): Promise<Response> {
  const credential = await new SignJWT({ client_id: agent.did })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setSubject(agent.did)
    .setIssuer(agent.did)
    .setAudience(baseUrl)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(agent.key);
  return fetch(`${baseUrl}.well-known/lws/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      resource,
      subject_token: credential,
      subject_token_type: TOKEN_TYPE_JWT,
    }).toString(),
  });
}

async function getAccessToken(agent: Agent): Promise<string> {
  const response = await exchange(agent);
  expect(response.status).toBe(200);
  return (await response.json() as { access_token: string }).access_token;
}

interface Delivery {
  headers: IncomingMessage['headers'];
  body: Record<string, any>;
}

/**
 * Starts a server that stores all POST requests it receives.
 */
async function startInbox(deliveries: Delivery[]): Promise<Server> {
  const server = createServer((request, response): void => {
    let body = '';
    request.on('data', (chunk: Buffer): void => {
      body += chunk.toString();
    });
    request.on('end', (): void => {
      deliveries.push({ headers: request.headers, body: JSON.parse(body) as Record<string, any> });
      response.writeHead(202);
      response.end();
    });
  });
  await new Promise<void>((resolve): void => {
    server.listen(inboxPort, resolve);
  });
  return server;
}

/**
 * Waits until a delivery matches the given predicate.
 */
async function waitForDelivery(deliveries: Delivery[], predicate: (delivery: Delivery) => boolean):
Promise<Delivery> {
  for (let i = 0; i < 50; i++) {
    const match = deliveries.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve): unknown => setTimeout(resolve, 100));
  }
  throw new Error('No matching delivery');
}

function getLinks(response: Response): string[] {
  return (response.headers.get('link') ?? '').split(/,\s*(?=<)/u);
}

const protocols: [string, { dual: boolean; configs: string[] }][] = [
  [ 'LWS', { dual: false, configs: [
    'ldp/authentication/lws.json',
    'ldp/handler/lws.json',
    'ldp/metadata-writer/lws.json',
    'util/representation-conversion/lws.json',
  ]}],
  [ 'Solid and LWS', { dual: true, configs: [
    'ldp/authentication/solid-lws.json',
    'ldp/handler/solid-lws.json',
    'ldp/metadata-writer/solid-lws.json',
    'util/representation-conversion/solid-lws.json',
  ]}],
];

const authorizations: [string, { configs: string[]; grant: (store: ResourceStore, agent: string) => Promise<void> }][] =
  [
    [ 'WAC', {
      configs: [ 'ldp/authorization/webacl.json', 'util/auxiliary/acl.json' ],
      grant: async(store, agent): Promise<void> => new AclHelper(store).setSimpleAcl(baseUrl, {
        permissions: { read: true, write: true, append: true, control: true },
        agent: `<${agent}>`,
        accessTo: true,
        default: true,
      }),
    }],
    [ 'ACP', {
      configs: [ 'ldp/authorization/acp.json', 'util/auxiliary/acr.json' ],
      grant: async(store, agent): Promise<void> => {
        const helper = new AcpHelper(store);
        const policy = helper.createPolicy({
          allow: [ 'read', 'append', 'write', 'control' ],
          anyOf: [ helper.createMatcher({ agent: `<${agent}>` }) ],
        });
        await helper.setAcp(baseUrl, helper.createAcr({
          resource: baseUrl,
          policies: [ policy ],
          memberPolicies: [ policy ],
        }));
      },
    }],
  ];

const combinations = protocols.flatMap(([ protocol, protocolArgs ]): [string, string, any, any][] =>
  authorizations.map(([ authorization, authArgs ]): [string, string, any, any] =>
    [ protocol, authorization, protocolArgs, authArgs ]));

describe.each(combinations)('A %s server using %s', (protocol, authorization, protocolArgs, authArgs): void => {
  let app: App;
  let inboxServer: Server;
  const deliveries: Delivery[] = [];
  let alice: Agent;
  let bob: Agent;
  let aliceToken: string;
  const container = `${baseUrl}container/`;
  let resource: string;

  beforeAll(async(): Promise<void> => {
    const instances = await instantiateFromConfig(
      'urn:solid-server:test:Instances',
      [
        getTestConfigPath('lws-server.json'),
        ...[ ...protocolArgs.configs, ...authArgs.configs ].map(getPresetConfigPath),
      ],
      getDefaultVariables(port, baseUrl),
    ) as Record<string, any>;
    let store: ResourceStore;
    ({ app, store } = instances);
    await app.start();
    inboxServer = await startInbox(deliveries);

    alice = await createAgent();
    bob = await createAgent();
    await authArgs.grant(store, alice.did);
  });

  afterAll(async(): Promise<void> => {
    await app.stop();
    inboxServer.close();
  });

  it('serves the storage description on the storage URI.', async(): Promise<void> => {
    const response = await fetch(baseUrl, { headers: { accept: 'application/lws+cid' }});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/lws+cid');
    expect(getLinks(response)).toContain(`<${baseUrl}>; rel="${LWS}storage"`);
    const description = await response.json();
    expect(description).toEqual(expect.objectContaining({
      id: baseUrl,
      type: 'Storage',
      service: expect.arrayContaining([{ type: 'StorageRoot', serviceEndpoint: baseUrl }]),
    }));
  });

  it('serves the authorization server metadata.', async(): Promise<void> => {
    const response = await fetch(`${baseUrl}.well-known/lws-configuration`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      issuer: baseUrl,
      token_endpoint: `${baseUrl}.well-known/lws/token`,
      jwks_uri: `${baseUrl}.well-known/lws/jwks`,
      grant_types_supported: [ TOKEN_EXCHANGE ],
    }));
  });

  it('challenges unauthenticated requests.', async(): Promise<void> => {
    const response = await fetch(container);
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate');
    expect(challenge).toContain(`as_uri="${baseUrl}"`);
    expect(challenge).toContain(`realm="${baseUrl}"`);
    expect(challenge).not.toContain('error=');
  });

  it('exchanges a did:key credential for an access token.', async(): Promise<void> => {
    const response = await exchange(alice);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, string>;
    expect(body.token_type).toBe('Bearer');
    aliceToken = body.access_token;
  });

  it('rejects token requests for unknown storages.', async(): Promise<void> => {
    const response = await exchange(alice, 'https://unknown.example/');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: 'invalid_target' }));
  });

  it('rejects invalid access tokens.', async(): Promise<void> => {
    const response = await fetch(container, { headers: { authorization: `Bearer ${aliceToken}x` }});
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('allows the owner to create a container.', async(): Promise<void> => {
    const response = await fetch(container, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceToken}`, link: `<${LWS}Container>; rel="type"` },
    });
    expect(response.status).toBe(201);
  });

  it('allows the owner to create a data resource.', async(): Promise<void> => {
    const response = await fetch(container, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'text/plain' },
      body: 'some content',
    });
    expect(response.status).toBe(201);
    resource = response.headers.get('location')!;
    const links = getLinks(response);
    expect(links).toContain(`<${container}>; rel="up"`);
    expect(links).toContain(`<${LWS}DataResource>; rel="type"`);
    expect(links).toContain(`<${baseUrl}>; rel="${LWS}storage"`);
  });

  it('represents containers as application/lws+json.', async(): Promise<void> => {
    const response = await fetch(container, {
      headers: { authorization: `Bearer ${aliceToken}`, accept: 'application/lws+json' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/lws+json');
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ id: container, type: 'Container', totalItems: 1 }));
    expect(body.items[0]).toEqual(
      expect.objectContaining({ id: resource, type: 'DataResource', format: 'text/plain' }),
    );
  });

  it(`${protocolArgs.dual ? 'keeps the LDP' : 'uses the LWS'} representation for JSON-LD.`, async(): Promise<void> => {
    const response = await fetch(container, {
      headers: { authorization: `Bearer ${aliceToken}`, accept: 'application/ld+json' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // The LDP representation is a JSON-LD array, the LWS representation an object
    expect(Array.isArray(body)).toBe(protocolArgs.dual);
  });

  const wildcardResult = protocolArgs.dual ? 'the root container' : 'the storage description';

  it(`returns ${wildcardResult} for */*.`, async(): Promise<void> => {
    const response = await fetch(baseUrl, { headers: { authorization: `Bearer ${aliceToken}`, accept: '*/*' }});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(protocolArgs.dual ? 'text/turtle' : 'application/lws+cid');
  });

  it('modifies linksets with JSON Merge Patch.', async(): Promise<void> => {
    const head = await fetch(resource, { method: 'HEAD', headers: { authorization: `Bearer ${aliceToken}` }});
    const linkset = /<([^>]+)>; rel="linkset"/u.exec(head.headers.get('link')!)![1];

    let response = await fetch(linkset, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ linkset: [{ anchor: resource, author: [{ href: 'https://example.com/alice' }]}]}),
    });
    expect(response.status).toBe(204);

    response = await fetch(linkset, {
      headers: { authorization: `Bearer ${aliceToken}`, accept: 'application/linkset+json' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.linkset[0].author).toEqual([{ href: 'https://example.com/alice' }]);
  });

  it('returns 204 after modifying a resource.', async(): Promise<void> => {
    const response = await fetch(resource, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'text/plain' },
      body: 'new content',
    });
    expect(response.status).toBe(204);
  });

  it('denies access to other agents.', async(): Promise<void> => {
    const bobToken = await getAccessToken(bob);
    const response = await fetch(resource, { headers: { authorization: `Bearer ${bobToken}` }});
    expect(response.status).toBe(403);
  });

  it('allows the owner to delete resources.', async(): Promise<void> => {
    const response = await fetch(resource, { method: 'DELETE', headers: { authorization: `Bearer ${aliceToken}` }});
    expect(response.status).toBe(204);
  });

  it('advertises the access and notification services in the storage description.', async(): Promise<void> => {
    const response = await fetch(baseUrl, { headers: { accept: 'application/lws+cid' }});
    const description = await response.json();
    expect(description.service).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'AccessGrantService', serviceEndpoint: `${baseUrl}.lws/grants/` }),
      expect.objectContaining({ type: 'AccessRequestService', serviceEndpoint: `${baseUrl}.lws/requests/` }),
      expect.objectContaining({ type: 'NotificationService', serviceEndpoint: `${baseUrl}.notifications/lws/` }),
    ]));
    expect(description.authentication).toEqual([ `${baseUrl}#lws-notification-key` ]);
    expect(description.verificationMethod[0].id).toBe(`${baseUrl}#lws-notification-key`);
  });

  describe('with access grants', (): void => {
    const grants = `${baseUrl}.lws/grants/`;
    let target: string;
    let bobToken: string;

    function createGrant(assignee: string, action: string[], value: string[]): Record<string, unknown> {
      return {
        '@context': [ 'https://www.w3.org/ns/lws/v1' ],
        type: [ 'AccessGrant' ],
        storage: baseUrl,
        access: [{ type: [ 'AccessPolicy' ], action, assignee, target: { type: 'StorageResource', value }}],
      };
    }

    beforeAll(async(): Promise<void> => {
      bobToken = await getAccessToken(bob);
      const response = await fetch(container, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'text/plain' },
        body: 'shared content',
      });
      target = response.headers.get('location')!;
    });

    it('grants access until the grant is deleted.', async(): Promise<void> => {
      let response = await fetch(target, { headers: { authorization: `Bearer ${bobToken}` }});
      expect(response.status).toBe(403);

      response = await fetch(grants, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/lws+json' },
        body: JSON.stringify(createGrant(bob.did, [ 'read' ], [ target ])),
      });
      expect(response.status).toBe(201);
      const grant = response.headers.get('location')!;

      response = await fetch(target, { headers: { authorization: `Bearer ${bobToken}` }});
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('shared content');

      response = await fetch(target, {
        method: 'PUT',
        headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'text/plain' },
        body: 'changed',
      });
      expect(response.status).toBe(403);

      response = await fetch(grant, { headers: { authorization: `Bearer ${aliceToken}` }});
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(createGrant(bob.did, [ 'read' ], [ target ]));

      response = await fetch(grant, { method: 'DELETE', headers: { authorization: `Bearer ${aliceToken}` }});
      expect(response.status).toBe(204);

      response = await fetch(target, { headers: { authorization: `Bearer ${bobToken}` }});
      expect(response.status).toBe(403);
    });

    it('grants public access with foaf:Agent.', async(): Promise<void> => {
      const response = await fetch(grants, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/lws+json' },
        body: JSON.stringify(createGrant('http://xmlns.com/foaf/0.1/Agent', [ 'read' ], [ target ])),
      });
      expect(response.status).toBe(201);
      await expect(fetch(target)).resolves.toEqual(expect.objectContaining({ status: 200 }));
      await fetch(response.headers.get('location')!, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      await expect(fetch(target)).resolves.toEqual(expect.objectContaining({ status: 401 }));
    });

    it('rejects invalid grants.', async(): Promise<void> => {
      const response = await fetch(grants, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/lws+json' },
        body: JSON.stringify({ ...createGrant(bob.did, [ 'read' ], [ target ]), access: []}),
      });
      expect(response.status).toBe(400);
    });

    it('does not allow other agents to create grants.', async(): Promise<void> => {
      const response = await fetch(grants, {
        method: 'POST',
        headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/lws+json' },
        body: JSON.stringify(createGrant(bob.did, [ 'read' ], [ target ])),
      });
      expect(response.status).toBe(403);
    });

    it('allows authenticated agents to request access.', async(): Promise<void> => {
      const request = {
        '@context': [ 'https://www.w3.org/ns/lws/v1' ],
        type: [ 'AccessRequest' ],
        storage: baseUrl,
        access: [{ type: [ 'AccessPolicy' ], action: [ 'read' ], assignee: bob.did }],
      };
      let response = await fetch(`${baseUrl}.lws/requests/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/lws+json' },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(201);
      const location = response.headers.get('location')!;

      response = await fetch(location, { headers: { authorization: `Bearer ${aliceToken}` }});
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(request);

      response = await fetch(location, {
        method: 'PUT',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/lws+json' },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(405);
    });
  });

  describe('with webhook notifications', (): void => {
    const endpoint = `${baseUrl}.notifications/lws/`;
    let subscription: string;

    it('creates subscriptions for readable topics.', async(): Promise<void> => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/lws+json' },
        body: JSON.stringify({ type: 'WebhookSubscription', topic: [ container ], inbox }),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toEqual(expect.objectContaining({ type: 'WebhookSubscription', topic: [ container ], inbox }));
      subscription = body.subscription;
      expect(response.headers.get('location')).toBe(subscription);
    });

    it('rejects subscriptions for topics the subscriber can not read.', async(): Promise<void> => {
      const bobToken = await getAccessToken(bob);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/lws+json' },
        body: JSON.stringify({ type: 'WebhookSubscription', topic: [ container ], inbox }),
      });
      expect(response.status).toBe(403);
    });

    it('sends signed notifications when resources change.', async(): Promise<void> => {
      const response = await fetch(container, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'text/plain' },
        body: 'notify me',
      });
      const created = response.headers.get('location')!;
      const delivery = await waitForDelivery(deliveries, ({ body }): boolean => body.activity?.object?.id === created);
      expect(delivery.headers['content-type']).toBe('application/lws+json');
      expect(delivery.headers['signature-input']).toContain(`keyid="${baseUrl}#lws-notification-key"`);
      expect(delivery.body).toEqual(expect.objectContaining({ type: 'Notification', storage: baseUrl }));
      expect(delivery.body.activity).toEqual(expect.objectContaining({
        type: [ 'Create' ],
        object: { id: created, type: [ 'DataResource' ]},
        target: container,
      }));
      expect(delivery.body.activity.actor).toBeUndefined();
    });

    it('lists and deletes subscriptions.', async(): Promise<void> => {
      let response = await fetch(endpoint, { headers: { authorization: `Bearer ${aliceToken}` }});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toEqual([{ id: subscription, type: [ 'DataResource' ]}]);

      response = await fetch(subscription, { method: 'DELETE', headers: { authorization: `Bearer ${aliceToken}` }});
      expect(response.status).toBe(204);
      response = await fetch(subscription, { headers: { authorization: `Bearer ${aliceToken}` }});
      expect(response.status).toBe(404);
    });
  });

  it('deletes containers recursively with Depth: infinity.', async(): Promise<void> => {
    const outer = `${container}outer/`;
    await fetch(`${outer}inner/leaf`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'text/plain' },
      body: 'leaf',
    });
    let response = await fetch(outer, { method: 'DELETE', headers: { authorization: `Bearer ${aliceToken}` }});
    expect(response.status).toBe(409);

    response = await fetch(outer, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${aliceToken}`, depth: 'infinity' },
    });
    expect(response.status).toBe(204);
    response = await fetch(`${outer}inner/leaf`, { headers: { authorization: `Bearer ${aliceToken}` }});
    expect(response.status).toBe(404);
  });

  it('describes errors with problem details.', async(): Promise<void> => {
    const response = await fetch(`${container}missing`, {
      headers: { authorization: `Bearer ${aliceToken}`, accept: 'application/lws+json' },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ status: 404 }));
  });
});
