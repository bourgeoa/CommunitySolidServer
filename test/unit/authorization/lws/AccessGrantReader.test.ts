import type { Credentials } from '../../../../src/authentication/Credentials';
import type { AccessGrantIndex, StoredAccessGrant } from '../../../../src/authorization/lws/AccessGrantIndex';
import { AccessGrantReader } from '../../../../src/authorization/lws/AccessGrantReader';
import type { AccessConstraint, AccessPolicy } from '../../../../src/authorization/lws/AccessGrantUtil';
import { LWS_CONTEXT_URI } from '../../../../src/authorization/lws/AccessGrantUtil';
import type { AccessMap } from '../../../../src/authorization/permissions/Permissions';
import { AccessMode } from '../../../../src/authorization/permissions/Permissions';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { ResourceIdentifier } from '../../../../src/http/representation/ResourceIdentifier';
import type { StorageLocationStrategy } from '../../../../src/server/description/StorageLocationStrategy';
import type { ResourceStore } from '../../../../src/storage/ResourceStore';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';
import { SingleRootIdentifierStrategy } from '../../../../src/util/identifiers/SingleRootIdentifierStrategy';
import { IdentifierSetMultiMap } from '../../../../src/util/map/IdentifierMap';
import { FOAF, LWS, RDF } from '../../../../src/util/Vocabularies';

function constraint(leftOperand: string, operator: string, rightOperand: unknown): AccessConstraint {
  return { leftOperand, operator, rightOperand };
}

describe('An AccessGrantReader', (): void => {
  const baseUrl = 'http://example.com/';
  const storage = { path: `${baseUrl}alice/` };
  const container = { path: `${storage.path}foo/` };
  const document = { path: `${container.path}doc` };
  const nested = { path: `${container.path}sub/doc` };
  const both = [ container, document ];
  const webId = 'http://example.com/bob/profile#me';
  const otherWebId = 'http://example.com/carol/profile#me';
  const clientId = 'http://client.example/';
  const identifierStrategy = new SingleRootIdentifierStrategy(baseUrl);
  let credentials: Credentials;
  let requestedModes: AccessMap;
  let policies: AccessPolicy[];
  let index: jest.Mocked<AccessGrantIndex>;
  let storageStrategy: jest.Mocked<StorageLocationStrategy>;
  let store: jest.Mocked<ResourceStore>;
  let reader: AccessGrantReader;

  function createPolicy(
    action: string[],
    targetType: string,
    targets: ResourceIdentifier[],
    constraints?: AccessConstraint[],
    assignee = webId,
  ): AccessPolicy {
    return {
      type: 'AccessPolicy',
      action,
      assignee,
      target: { type: targetType, value: targets.map((target): string => target.path) },
      constraint: constraints,
    };
  }

  function request(identifier: ResourceIdentifier, ...modes: AccessMode[]): void {
    requestedModes.set(identifier, new Set(modes));
  }

  beforeEach(async(): Promise<void> => {
    credentials = { agent: { webId }, client: { clientId }};
    requestedModes = new IdentifierSetMultiMap();
    policies = [];

    index = {
      getGrants: jest.fn(async(): Promise<StoredAccessGrant[]> => [{
        id: `${storage.path}.lws/grants/grant`,
        grant: { '@context': LWS_CONTEXT_URI, type: 'AccessGrant', storage: storage.path, access: policies },
      }]),
    } as any;

    storageStrategy = {
      getStorageIdentifier: jest.fn().mockResolvedValue(storage),
    };

    store = {
      getRepresentation: jest.fn(async(identifier: ResourceIdentifier): Promise<BasicRepresentation> => {
        const representation = new BasicRepresentation('data', identifier, 'text/turtle');
        representation.metadata.add(RDF.terms.type, 'http://example.com/Type');
        return representation;
      }),
    } as any;

    reader = new AccessGrantReader(index, storageStrategy, identifierStrategy, store);
  });

  it('grants nothing if there are no grants.', async(): Promise<void> => {
    index.getGrants.mockResolvedValueOnce([]);
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.size).toBe(0);
    expect(index.getGrants).toHaveBeenLastCalledWith(storage);
  });

  it('grants nothing if the storage can not be determined.', async(): Promise<void> => {
    storageStrategy.getStorageIdentifier.mockRejectedValueOnce(new NotFoundHttpError());
    policies.push(createPolicy([ 'read' ], 'DataResource', [ document ]));
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.size).toBe(0);
    expect(index.getGrants).toHaveBeenCalledTimes(0);
  });

  it('only uses policies of which the agent is the assignee.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read' ], 'DataResource', [ document ], undefined, otherWebId));
    request(document, AccessMode.read);
    expect((await reader.handle({ credentials, requestedModes })).size).toBe(0);

    policies.push(createPolicy([ 'read' ], 'DataResource', [ document ]));
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(document)).toEqual({ read: true });
  });

  it('grants access to everyone with the foaf:Agent assignee.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read' ], 'DataResource', [ document ], undefined, FOAF.Agent));
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials: {}, requestedModes });
    expect(result.get(document)).toEqual({ read: true });
  });

  it('maps the actions to access modes.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read', 'modify', 'create', 'delete' ], 'DataResource', [ document ]));
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(document)).toEqual({ read: true, write: true, append: true, delete: true });
  });

  it('ignores unknown actions.', async(): Promise<void> => {
    policies.push(createPolicy([ 'unknown' ], 'DataResource', [ document ]));
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.size).toBe(0);
  });

  it('only applies policies to the exact targets.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read' ], 'Container', [ container ]));
    request(container, AccessMode.read);
    request(document, AccessMode.read);
    request(nested, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(container)).toEqual({ read: true });
    expect(result.get(document)).toBeUndefined();
    expect(result.get(nested)).toBeUndefined();
  });

  it('ignores policies without a target.', async(): Promise<void> => {
    policies.push({ type: 'AccessPolicy', action: [ 'read' ], assignee: webId });
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.size).toBe(0);
  });

  it('requires the resource to match the target type.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read' ], 'Container', [ document ]));
    policies.push(createPolicy([ 'delete' ], 'DataResource', [ container ]));
    policies.push(createPolicy([ 'modify' ], `${LWS.namespace}DataResource`, [ document ]));
    request(container, AccessMode.read);
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(container)).toBeUndefined();
    expect(result.get(document)).toEqual({ write: true, append: true });
  });

  it('matches both containers and documents with the StorageResource type.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read' ], 'StorageResource', [ container, document ]));
    request(container, AccessMode.read);
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(container)).toEqual({ read: true });
    expect(result.get(document)).toEqual({ read: true });
  });

  it('grants create on the direct children of a container with the create action.', async(): Promise<void> => {
    policies.push(createPolicy([ 'create' ], 'Container', [ container ]));
    request(container, AccessMode.append);
    request(document, AccessMode.create);
    request(nested, AccessMode.create);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(container)).toEqual({ append: true });
    expect(result.get(document)).toEqual({ create: true });
    expect(result.get(nested)).toBeUndefined();
  });

  it('only grants create on children if the create mode is requested.', async(): Promise<void> => {
    policies.push(createPolicy([ 'create' ], 'Container', [ container ]));
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(document)).toBeUndefined();
  });

  it('does not grant create on children for other actions.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read', 'modify' ], 'Container', [ container ]));
    request(document, AccessMode.create);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(document)).toBeUndefined();
  });

  it('supports the root container.', async(): Promise<void> => {
    const root = { path: baseUrl };
    storageStrategy.getStorageIdentifier.mockResolvedValue(root);
    policies.push(createPolicy([ 'read', 'create' ], 'StorageResource', [ root ]));
    request(root, AccessMode.read, AccessMode.create);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(root)).toEqual({ read: true, append: true });
  });

  it('evaluates client constraints.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read' ], 'DataResource', [ document ], [ constraint('client', 'eq', clientId) ]));
    request(document, AccessMode.read);
    expect((await reader.handle({ credentials, requestedModes })).get(document)).toEqual({ read: true });
    credentials.client = { clientId: 'http://other.example/' };
    expect((await reader.handle({ credentials, requestedModes })).size).toBe(0);
    delete credentials.client;
    expect((await reader.handle({ credentials, requestedModes })).size).toBe(0);
  });

  it('evaluates format constraints.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read' ], 'StorageResource', both, [ constraint('format', 'eq', 'text/turtle') ]));
    policies.push(createPolicy([ 'delete' ], 'StorageResource', both, [ constraint('format', 'eq', 'text/plain') ]));
    request(container, AccessMode.read);
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    // Containers have no format
    expect(result.get(container)).toBeUndefined();
    expect(result.get(document)).toEqual({ read: true });
    // The resource info is only requested once per resource
    expect(store.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('evaluates type constraints.', async(): Promise<void> => {
    const typeConstraint = constraint('type', 'isAnyOf', [ 'http://example.com/Type' ]);
    policies.push(createPolicy([ 'read' ], 'StorageResource', both, [ typeConstraint ]));
    policies.push(createPolicy([ 'modify' ], 'StorageResource', both, [ constraint('type', 'eq', LWS.Container) ]));
    policies.push(createPolicy([ 'delete' ], 'StorageResource', both, [ constraint('type', 'eq', LWS.DataResource) ]));
    request(container, AccessMode.read);
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(container)).toEqual({ read: true, write: true, append: true });
    expect(result.get(document)).toEqual({ read: true, delete: true });
  });

  it('evaluates the constraints on the new resource when creating it.', async(): Promise<void> => {
    const typeConstraint = constraint('type', 'eq', LWS.DataResource);
    policies.push(createPolicy([ 'create' ], 'Container', [ container ], [ typeConstraint ]));
    store.getRepresentation.mockRejectedValue(new NotFoundHttpError());
    request(document, AccessMode.create);
    request({ path: `${container.path}sub/` }, AccessMode.create);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(document)).toEqual({ create: true });
    expect(result.get({ path: `${container.path}sub/` })).toBeUndefined();
  });

  it('only uses the default types if the metadata can not be read.', async(): Promise<void> => {
    const typeConstraint = constraint('type', 'eq', 'http://example.com/Type');
    policies.push(createPolicy([ 'read' ], 'DataResource', [ document ], [ typeConstraint ]));
    const formatConstraint = constraint('format', 'neq', 'text/turtle');
    policies.push(createPolicy([ 'delete' ], 'DataResource', [ document ], [ formatConstraint ]));
    store.getRepresentation.mockRejectedValue(new NotFoundHttpError());
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(document)).toEqual({ delete: true });
  });

  it('accepts purpose constraints and evaluates dateTime constraints.', async(): Promise<void> => {
    policies.push(createPolicy([ 'read' ], 'DataResource', [ document ], [
      { leftOperand: 'purpose', operator: 'eq', rightOperand: 'http://example.com/purpose' },
      { leftOperand: 'dateTime', operator: 'lt', rightOperand: new Date(Date.now() + 60_000).toISOString() },
    ]));
    policies.push(createPolicy([ 'delete' ], 'DataResource', [ document ], [
      { leftOperand: 'dateTime', operator: 'lt', rightOperand: new Date(Date.now() - 60_000).toISOString() },
    ]));
    request(document, AccessMode.read);
    const result = await reader.handle({ credentials, requestedModes });
    expect(result.get(document)).toEqual({ read: true });
    expect(store.getRepresentation).toHaveBeenCalledTimes(0);
  });

  describe('with an access request container', (): void => {
    const requestContainer = { path: `${storage.path}.lws/requests/` };
    const requestResource = { path: `${requestContainer.path}request` };

    beforeEach(async(): Promise<void> => {
      index.getGrants.mockResolvedValue([]);
      reader = new AccessGrantReader(index, storageStrategy, identifierStrategy, store, '.lws/requests/');
    });

    it('allows authenticated agents to create access requests.', async(): Promise<void> => {
      request(requestContainer, AccessMode.append);
      request(requestResource, AccessMode.create);
      request(document, AccessMode.create);
      const result = await reader.handle({ credentials, requestedModes });
      expect(result.get(requestContainer)).toEqual({ append: true });
      expect(result.get(requestResource)).toEqual({ create: true });
      expect(result.get(document)).toBeUndefined();
    });

    it('does not allow unauthenticated agents to create access requests.', async(): Promise<void> => {
      request(requestContainer, AccessMode.append);
      request(requestResource, AccessMode.create);
      const result = await reader.handle({ credentials: {}, requestedModes });
      expect(result.size).toBe(0);
    });

    it('supports the root container.', async(): Promise<void> => {
      const root = { path: baseUrl };
      storageStrategy.getStorageIdentifier.mockResolvedValue(root);
      request(root, AccessMode.append);
      request({ path: `${baseUrl}.lws/requests/` }, AccessMode.append);
      const result = await reader.handle({ credentials, requestedModes });
      expect(result.get(root)).toBeUndefined();
      expect(result.get({ path: `${baseUrl}.lws/requests/` })).toEqual({ append: true });
    });
  });
});
