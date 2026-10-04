import { DataFactory } from 'n3';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { Representation } from '../../../../src/http/representation/Representation';
import type { RepresentationPreferences } from '../../../../src/http/representation/RepresentationPreferences';
import {
  ContainerToLwsJsonConverter,
  LWS_CONTEXT,
  PAGINATION_RELATIONS,
} from '../../../../src/storage/conversion/ContainerToLwsJsonConverter';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { readableToString } from '../../../../src/util/StreamUtil';
import { CONTENT_TYPE_TERM, DC, IANA, LDP, POSIX, RDF } from '../../../../src/util/Vocabularies';

const { namedNode: nn, literal, quad } = DataFactory;

function itemIds(json: any): string[] {
  return json.items.map((item: any): string => item.id);
}

describe('A ContainerToLwsJsonConverter', (): void => {
  const container = { path: 'http://test.com/container/' };
  const document = { path: 'http://test.com/document' };
  let representation: Representation;
  let converter: ContainerToLwsJsonConverter;

  beforeEach(async(): Promise<void> => {
    representation = new BasicRepresentation([], 'internal/quads', false);
    converter = new ContainerToLwsJsonConverter();
  });

  describe('canHandle', (): void => {
    it('supports containers.', async(): Promise<void> => {
      const preferences: RepresentationPreferences = { type: { 'application/lws+json': 1 }};
      await expect(converter.canHandle({ identifier: container, representation, preferences }))
        .resolves.toBeUndefined();
    });

    it('does not support documents.', async(): Promise<void> => {
      const preferences: RepresentationPreferences = { type: { 'application/lws+json': 1 }};
      await expect(converter.canHandle({ identifier: document, representation, preferences }))
        .rejects.toThrow('Can only convert containers.');
    });

    it('rejects requests where internal quads are acceptable.', async(): Promise<void> => {
      const preferences: RepresentationPreferences = { type: { 'internal/quads': 1 }};
      await expect(converter.canHandle({ identifier: container, representation, preferences }))
        .rejects.toThrow('Internal quads are acceptable so no conversion is needed.');
    });

    it('rejects requests the output types do not match.', async(): Promise<void> => {
      const preferences: RepresentationPreferences = { type: { 'text/turtle': 1 }};
      await expect(converter.canHandle({ identifier: container, representation, preferences }))
        .rejects.toThrow(NotImplementedHttpError);
    });

    it('accepts wildcard requests by default.', async(): Promise<void> => {
      const preferences: RepresentationPreferences = { type: { '*/*': 1 }};
      await expect(converter.canHandle({ identifier: container, representation, preferences }))
        .resolves.toBeUndefined();
    });

    it('can require one of the output types to be requested explicitly.', async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter({ requireExplicit: true });
      await expect(converter.canHandle({ identifier: container, representation, preferences: { type: { '*/*': 1 }}}))
        .rejects.toThrow('The LWS container representation was not explicitly requested.');
      await expect(converter.canHandle({ identifier: container, representation, preferences: {}}))
        .rejects.toThrow('The LWS container representation was not explicitly requested.');
      await expect(converter.canHandle({
        identifier: container,
        representation,
        preferences: { type: { 'application/json': 0, '*/*': 1 }},
      })).rejects.toThrow('The LWS container representation was not explicitly requested.');
      await expect(converter.canHandle({
        identifier: container,
        representation,
        preferences: { type: { 'application/json': 1 }},
      })).resolves.toBeUndefined();
    });

    it('can reject requests preferring an unsupported type when preferences are strict.', async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter({ strictPreferences: true });
      await expect(converter.canHandle({
        identifier: container,
        representation,
        preferences: { type: { 'text/turtle': 1, 'application/json': 0.5 }},
      })).rejects.toThrow('text/turtle is preferred over the LWS container representation.');
      await expect(converter.canHandle({
        identifier: container,
        representation,
        preferences: { type: { 'text/turtle': 0.5, 'application/json': 1 }},
      })).resolves.toBeUndefined();
      await expect(converter.canHandle({
        identifier: container,
        representation,
        preferences: { type: { 'text/*': 1, 'application/json': 0.5, 'application/ld+json': 1 }},
      })).resolves.toBeUndefined();
      await expect(converter.canHandle({ identifier: container, representation, preferences: {}}))
        .resolves.toBeUndefined();
    });

    it('can be configured with custom output preferences.', async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter({ outputPreferences: { 'application/lws+json': 1 }});
      await expect(converter.canHandle({
        identifier: container,
        representation,
        preferences: { type: { 'application/ld+json': 1 }},
      })).rejects.toThrow(NotImplementedHttpError);
      await expect(converter.canHandle({
        identifier: container,
        representation,
        preferences: { type: { 'application/lws+json': 1 }},
      })).resolves.toBeUndefined();
    });
  });

  describe('handle', (): void => {
    it('generates an LWS container representation.', async(): Promise<void> => {
      const c = container.path;
      representation = new BasicRepresentation([
        quad(nn(c), RDF.terms.type, LDP.terms.BasicContainer),
        quad(nn(c), LDP.terms.contains, nn(`${c}b`)),
        quad(nn(c), LDP.terms.contains, nn(`${c}a/`)),
        quad(nn(c), LDP.terms.contains, nn(`${c}c`)),
        quad(nn(c), LDP.terms.contains, nn(`${c}d`)),
        quad(nn(c), LDP.terms.contains, nn(`${c}e`)),
        // Container with a size and modification date
        quad(nn(`${c}a/`), POSIX.terms.size, literal('12')),
        quad(nn(`${c}a/`), DC.terms.modified, literal('2024-01-02T03:04:05Z')),
        // Content type triple
        quad(nn(`${c}b`), CONTENT_TYPE_TERM, literal('text/turtle')),
        quad(nn(`${c}b`), POSIX.terms.size, literal('123')),
        quad(nn(`${c}b`), DC.terms.modified, literal('invalid date')),
        // IANA type
        quad(nn(`${c}c`), RDF.terms.type, LDP.terms.Resource),
        quad(nn(`${c}c`), RDF.terms.type, nn(`${IANA.namespace}text/plain`)),
        quad(nn(`${c}c`), RDF.terms.type, nn(`${IANA.namespace}text/html#Resource`)),
        quad(nn(`${c}c`), POSIX.terms.size, literal('-5')),
        // No format information
        quad(nn(`${c}d`), POSIX.terms.mtime, literal('5')),
      ], 'internal/quads', false);

      const result = await converter.handle({
        identifier: container,
        representation,
        preferences: { type: { 'application/lws+json': 1 }},
      });
      expect(result.metadata.contentType).toBe('application/lws+json');
      expect(JSON.parse(await readableToString(result.data))).toEqual({
        '@context': LWS_CONTEXT,
        id: c,
        type: 'Container',
        totalItems: 5,
        items: [
          { id: `${c}a/`, type: 'Container', modified: '2024-01-02T03:04:05.000Z' },
          { id: `${c}b`, type: 'DataResource', format: 'text/turtle', size: 123 },
          { id: `${c}c`, type: 'DataResource', format: 'text/html' },
          { id: `${c}d`, type: 'DataResource', format: 'application/octet-stream' },
          { id: `${c}e`, type: 'DataResource', format: 'application/octet-stream' },
        ],
      });
    });

    it('uses the best matching content type.', async(): Promise<void> => {
      const result = await converter.handle({
        identifier: container,
        representation,
        preferences: { type: { 'application/ld+json': 1, 'application/lws+json': 0.5 }},
      });
      expect(result.metadata.contentType).toBe('application/ld+json');
      expect(JSON.parse(await readableToString(result.data))).toEqual({
        '@context': LWS_CONTEXT,
        id: container.path,
        type: 'Container',
        totalItems: 0,
        items: [],
      });
    });

    it('defaults to the LWS content type if no type matches.', async(): Promise<void> => {
      const result = await converter.handle({
        identifier: container,
        representation,
        preferences: { type: { 'text/html': 1 }},
      });
      expect(result.metadata.contentType).toBe('application/lws+json');
    });
  });

  describe('pagination', (): void => {
    const c = container.path;
    const members = [ 'a', 'b', 'c', 'd', 'e' ].map((name): string => `${c}${name}`);
    const preferences: RepresentationPreferences = { type: { 'application/lws+json': 1 }};

    function createRepresentation(): Representation {
      return new BasicRepresentation(
        members.map((member): any => quad(nn(c), LDP.terms.contains, nn(member))),
        'internal/quads',
        false,
      );
    }

    function pageRange(page: number): RepresentationPreferences['range'] {
      return { unit: 'lws-page', parts: [{ start: page }]};
    }

    beforeEach(async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter({ pageSize: 2 });
    });

    it('does not paginate containers with at most pageSize members.', async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter({ pageSize: 5 });
      const result = await converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences,
      });
      const json = JSON.parse(await readableToString(result.data));
      expect(json.totalItems).toBe(5);
      expect(itemIds(json)).toEqual(members);
      expect(result.metadata.get(PAGINATION_RELATIONS.first)).toBeUndefined();
      expect(result.metadata.get(PAGINATION_RELATIONS.last)).toBeUndefined();
    });

    it('accepts the first page of containers that are not paginated.', async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter({ pageSize: 5 });
      const result = await converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences: { ...preferences, range: pageRange(1) },
      });
      const json = JSON.parse(await readableToString(result.data));
      expect(itemIds(json)).toEqual(members);
    });

    it('throws a 404 for other pages of containers that are not paginated.', async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter({ pageSize: 5 });
      const promise = converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences: { ...preferences, range: pageRange(2) },
      });
      await expect(promise).rejects.toThrow(NotFoundHttpError);
      await expect(promise).rejects.toThrow(`Page 2 of ${c} does not exist.`);
    });

    it('returns the first page by default.', async(): Promise<void> => {
      const result = await converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences,
      });
      const json = JSON.parse(await readableToString(result.data));
      expect(json.totalItems).toBe(5);
      expect(itemIds(json)).toEqual([ `${c}a`, `${c}b` ]);
      expect(result.metadata.contentType).toBe('application/lws+json');
      expect(result.metadata.get(PAGINATION_RELATIONS.first)?.value).toBe(`${c}?page=1`);
      expect(result.metadata.get(PAGINATION_RELATIONS.last)?.value).toBe(`${c}?page=3`);
      expect(result.metadata.get(PAGINATION_RELATIONS.prev)).toBeUndefined();
      expect(result.metadata.get(PAGINATION_RELATIONS.next)?.value).toBe(`${c}?page=2`);
    });

    it('ignores ranges with a different unit.', async(): Promise<void> => {
      const result = await converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences: { ...preferences, range: { unit: 'bytes', parts: [{ start: 3 }]}},
      });
      const json = JSON.parse(await readableToString(result.data));
      expect(itemIds(json)).toEqual([ `${c}a`, `${c}b` ]);
    });

    it('returns the requested middle page.', async(): Promise<void> => {
      const result = await converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences: { ...preferences, range: pageRange(2) },
      });
      const json = JSON.parse(await readableToString(result.data));
      expect(json.totalItems).toBe(5);
      expect(itemIds(json)).toEqual([ `${c}c`, `${c}d` ]);
      expect(result.metadata.get(PAGINATION_RELATIONS.first)?.value).toBe(`${c}?page=1`);
      expect(result.metadata.get(PAGINATION_RELATIONS.last)?.value).toBe(`${c}?page=3`);
      expect(result.metadata.get(PAGINATION_RELATIONS.prev)?.value).toBe(`${c}?page=1`);
      expect(result.metadata.get(PAGINATION_RELATIONS.next)?.value).toBe(`${c}?page=3`);
    });

    it('returns the requested last page.', async(): Promise<void> => {
      const result = await converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences: { ...preferences, range: pageRange(3) },
      });
      const json = JSON.parse(await readableToString(result.data));
      expect(json.totalItems).toBe(5);
      expect(itemIds(json)).toEqual([ `${c}e` ]);
      expect(result.metadata.get(PAGINATION_RELATIONS.prev)?.value).toBe(`${c}?page=2`);
      expect(result.metadata.get(PAGINATION_RELATIONS.next)).toBeUndefined();
    });

    it('throws a 404 for pages that are out of range.', async(): Promise<void> => {
      const promise = converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences: { ...preferences, range: pageRange(4) },
      });
      await expect(promise).rejects.toThrow(NotFoundHttpError);
      await expect(promise).rejects.toThrow(`Page 4 of ${c} does not exist.`);
    });

    it('can use a different page parameter.', async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter({ pageSize: 2, pageParameter: 'p' });
      const result = await converter.handle({
        identifier: container,
        representation: createRepresentation(),
        preferences,
      });
      expect(result.metadata.get(PAGINATION_RELATIONS.first)?.value).toBe(`${c}?p=1`);
      expect(result.metadata.get(PAGINATION_RELATIONS.next)?.value).toBe(`${c}?p=2`);
    });

    it('defaults to a page size of 1000.', async(): Promise<void> => {
      converter = new ContainerToLwsJsonConverter();
      const quads = [];
      for (let i = 0; i < 1001; i++) {
        quads.push(quad(nn(c), LDP.terms.contains, nn(`${c}${String(i).padStart(4, '0')}`)));
      }
      const result = await converter.handle({
        identifier: container,
        representation: new BasicRepresentation(quads, 'internal/quads', false),
        preferences: { ...preferences, range: pageRange(2) },
      });
      const json = JSON.parse(await readableToString(result.data));
      expect(json.totalItems).toBe(1001);
      expect(itemIds(json)).toEqual([ `${c}1000` ]);
      expect(result.metadata.get(PAGINATION_RELATIONS.last)?.value).toBe(`${c}?page=2`);
    });
  });
});
