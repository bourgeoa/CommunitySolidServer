import { DataFactory } from 'n3';
import { BasicRepresentation } from '../../../src/http/representation/BasicRepresentation';
import type { Representation } from '../../../src/http/representation/Representation';
import { RepresentationMetadata } from '../../../src/http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../../src/http/representation/ResourceIdentifier';
import type { WebIdStore } from '../../../src/identity/interaction/webid/util/WebIdStore';
import { ProfileCardGuard } from '../../../src/storage/ProfileCardGuard';
import type { ResourceStore } from '../../../src/storage/ResourceStore';
import { BadRequestHttpError } from '../../../src/util/errors/BadRequestHttpError';
import { ForbiddenHttpError } from '../../../src/util/errors/ForbiddenHttpError';
import { guardedStreamFrom, readableToString } from '../../../src/util/StreamUtil';
import { SOLID } from '../../../src/util/Vocabularies';

const { namedNode, quad } = DataFactory;

const CARD: ResourceIdentifier = { path: 'http://example.com/alice/profile/card' };
const WEBID = 'http://example.com/alice/profile/card#me';
const ISSUER = 'http://example.com';

const TURTLE_PREFIX = '@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n';

function cardTurtle(subject = WEBID, object = ISSUER): string {
  return `${TURTLE_PREFIX}<${subject}> solid:oidcIssuer <${object}>.`;
}

function representation(data: any, contentType: string, identifier?: string): Representation {
  const metadata = identifier ? new RepresentationMetadata({ path: identifier }) : new RepresentationMetadata();
  metadata.contentType = contentType;
  return new BasicRepresentation(data, metadata);
}

describe('A ProfileCardGuard', (): void => {
  const source: jest.Mocked<ResourceStore> = {
    getRepresentation: jest.fn(async(): Promise<any> => 'get'),
    addResource: jest.fn(async(): Promise<any> => 'add'),
    setRepresentation: jest.fn(async(): Promise<any> => 'set'),
    deleteResource: jest.fn(async(): Promise<any> => 'delete'),
    modifyResource: jest.fn(),
  } as any;
  const webIdStore: jest.Mocked<WebIdStore> = {
    hasWebId: jest.fn(async(): Promise<boolean> => true),
  } as any;
  let guard: ProfileCardGuard;

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    guard = new ProfileCardGuard(source, webIdStore, ISSUER);
  });

  it('passes through writes to unrelated documents.', async(): Promise<void> => {
    const target = { path: 'http://example.com/alice/other' };
    const rep = representation('data', 'text/plain');
    await guard.setRepresentation(target, rep);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(webIdStore.hasWebId).toHaveBeenCalledTimes(0);
  });

  it('passes through writes to cards that are not registered.', async(): Promise<void> => {
    webIdStore.hasWebId.mockResolvedValueOnce(false);
    const rep = representation('not turtle', 'text/turtle');
    await guard.setRepresentation(CARD, rep);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(webIdStore.hasWebId).toHaveBeenCalledTimes(1);
    expect(webIdStore.hasWebId).toHaveBeenLastCalledWith(WEBID);
  });

  it('passes through a valid card write that keeps the issuer triple.', async(): Promise<void> => {
    const rep = representation(cardTurtle(), 'text/turtle');
    await guard.setRepresentation(CARD, rep);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenLastCalledWith(CARD, rep, undefined);
    // The original data is still streamable
    await expect(readableToString(rep.data)).resolves.toBe(cardTurtle());
  });

  it('also guards cards with a .ttl extension.', async(): Promise<void> => {
    const target = { path: 'http://example.com/alice/profile/card.ttl' };
    await guard.setRepresentation(target, representation(cardTurtle(), 'text/turtle'));
    expect(webIdStore.hasWebId).toHaveBeenLastCalledWith(WEBID);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
  });

  it('accepts a card write where the issuer has a trailing slash.', async(): Promise<void> => {
    await guard.setRepresentation(CARD, representation(cardTurtle(WEBID, 'http://example.com/'), 'text/turtle'));
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
  });

  it('accepts a card write provided as internal quads, as produced by a PATCH.', async(): Promise<void> => {
    const quads = [ quad(namedNode(WEBID), namedNode(SOLID.terms.oidcIssuer.value), namedNode(ISSUER)) ];
    const rep = representation(guardedStreamFrom(quads), 'internal/quads');
    await guard.setRepresentation(CARD, rep);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenLastCalledWith(CARD, rep, undefined);
    expect(webIdStore.hasWebId).toHaveBeenLastCalledWith(WEBID);
  });

  it('rejects a card write without the issuer triple.', async(): Promise<void> => {
    const rep = representation(cardTurtle('http://example.com/alice/profile/card#other'), 'text/turtle');
    await expect(guard.setRepresentation(CARD, rep)).rejects.toThrow(BadRequestHttpError);
    expect(source.setRepresentation).toHaveBeenCalledTimes(0);
    expect(rep.data.destroyed).toBe(true);
  });

  it('rejects a card write pointing to another issuer.', async(): Promise<void> => {
    await expect(guard.setRepresentation(CARD, representation(cardTurtle(WEBID, 'http://other.example/'), 'text/turtle')))
      .rejects.toThrow(BadRequestHttpError);
  });

  it('rejects a card write that is not valid Turtle.', async(): Promise<void> => {
    const rep = representation('<http://example.com/alice/profile/card#me> solid:oidcIssuer', 'text/turtle');
    await expect(guard.setRepresentation(CARD, rep)).rejects.toThrow(BadRequestHttpError);
    expect(source.setRepresentation).toHaveBeenCalledTimes(0);
    expect(rep.data.destroyed).toBe(true);
  });

  it('rejects a card write that is not sent as Turtle.', async(): Promise<void> => {
    const rep = representation('{ "@id": "https://example.com/me" }', 'application/ld+json');
    await expect(guard.setRepresentation(CARD, rep)).rejects.toThrow(BadRequestHttpError);
    expect(source.setRepresentation).toHaveBeenCalledTimes(0);
    expect(rep.data.destroyed).toBe(true);
  });

  it('validates a card created through addResource.', async(): Promise<void> => {
    const container = { path: 'http://example.com/alice/profile/' };
    const rep = representation(cardTurtle(), 'text/turtle', CARD.path);
    await guard.addResource(container, rep);
    expect(source.addResource).toHaveBeenCalledTimes(1);
    expect(webIdStore.hasWebId).toHaveBeenLastCalledWith(WEBID);
  });

  it('does not validate addResource calls without a card identifier.', async(): Promise<void> => {
    const container = { path: 'http://example.com/alice/profile/' };
    const rep = representation(cardTurtle(), 'text/turtle', 'http://example.com/alice/profile/other');
    await guard.addResource(container, rep);
    expect(source.addResource).toHaveBeenCalledTimes(1);
    expect(webIdStore.hasWebId).toHaveBeenCalledTimes(0);
  });

  it('falls back to the container path when the representation has no metadata identifier.', async(): Promise<void> => {
    const container = { path: 'http://example.com/alice/profile/' };
    const rep = { metadata: { identifier: undefined }} as any;
    await guard.addResource(container, rep);
    expect(source.addResource).toHaveBeenCalledTimes(1);
    expect(webIdStore.hasWebId).toHaveBeenCalledTimes(0);
  });

  it('forbids deleting the card of a registered WebID.', async(): Promise<void> => {
    await expect(guard.deleteResource(CARD)).rejects.toThrow(ForbiddenHttpError);
    expect(source.deleteResource).toHaveBeenCalledTimes(0);
  });

  it('allows deleting unrelated or unregistered resources.', async(): Promise<void> => {
    webIdStore.hasWebId.mockResolvedValueOnce(false);
    await guard.deleteResource(CARD);
    expect(source.deleteResource).toHaveBeenCalledTimes(1);
    await guard.deleteResource({ path: 'http://example.com/alice/other' });
    expect(source.deleteResource).toHaveBeenCalledTimes(2);
    expect(webIdStore.hasWebId).toHaveBeenCalledTimes(1);
  });
});
