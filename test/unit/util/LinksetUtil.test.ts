import 'jest-rdf';
import { DataFactory } from 'n3';
import { UnprocessableEntityHttpError } from '../../../src/util/errors/UnprocessableEntityHttpError';
import {
  IANA_RELATION_NAMESPACE,
  linksetToLinks,
  linksToLinkset,
  linkToQuad,
  predicateToRelation,
  quadToLink,
  relationToPredicate,
} from '../../../src/util/LinksetUtil';
import { LDP, RDF } from '../../../src/util/Vocabularies';

const { blankNode, literal, namedNode, quad } = DataFactory;

describe('LinksetUtil', (): void => {
  const subject = 'http://example.com/foo';
  const target = 'http://example.com/bar';

  describe('#predicateToRelation', (): void => {
    it('converts well-known predicates to registered relations.', async(): Promise<void> => {
      expect(predicateToRelation(RDF.type)).toBe('type');
      expect(predicateToRelation(LDP.contains)).toBe('item');
    });

    it('converts IANA relation predicates to registered relations.', async(): Promise<void> => {
      expect(predicateToRelation(`${IANA_RELATION_NAMESPACE}describedby`)).toBe('describedby');
    });

    it('keeps the IANA namespace itself and other predicates as extension relations.', async(): Promise<void> => {
      expect(predicateToRelation(IANA_RELATION_NAMESPACE)).toBe(IANA_RELATION_NAMESPACE);
      expect(predicateToRelation('http://example.com/rel')).toBe('http://example.com/rel');
    });
  });

  describe('#relationToPredicate', (): void => {
    it('converts well-known relations to their predicates.', async(): Promise<void> => {
      expect(relationToPredicate('type')).toBe(RDF.type);
      expect(relationToPredicate('item')).toBe(LDP.contains);
    });

    it('keeps extension relations.', async(): Promise<void> => {
      expect(relationToPredicate('http://example.com/rel')).toBe('http://example.com/rel');
    });

    it('converts registered relations to lowercase IANA predicates.', async(): Promise<void> => {
      expect(relationToPredicate('DescribedBy')).toBe(`${IANA_RELATION_NAMESPACE}describedby`);
    });
  });

  describe('#quadToLink', (): void => {
    it('converts quads with named nodes as subject and object.', async(): Promise<void> => {
      expect(quadToLink(quad(namedNode(subject), RDF.terms.type, namedNode(target))))
        .toEqual({ anchor: subject, rel: 'type', href: target });
    });

    it('returns undefined for other quads.', async(): Promise<void> => {
      expect(quadToLink(quad(blankNode(), RDF.terms.type, namedNode(target)))).toBeUndefined();
      expect(quadToLink(quad(namedNode(subject), RDF.terms.type, literal('a')))).toBeUndefined();
    });
  });

  describe('#linkToQuad', (): void => {
    it('converts a link to a quad.', async(): Promise<void> => {
      expect(linkToQuad({ anchor: subject, rel: 'next', href: target })).toEqualRdfQuad(
        quad(namedNode(subject), namedNode(`${IANA_RELATION_NAMESPACE}next`), namedNode(target)),
      );
    });
  });

  describe('#linksToLinkset', (): void => {
    it('groups links by anchor and relation.', async(): Promise<void> => {
      expect(linksToLinkset([
        { anchor: target, rel: 'type', href: 'http://example.com/Type' },
        { anchor: subject, rel: 'type', href: 'http://example.com/A' },
        { anchor: subject, rel: 'type', href: 'http://example.com/B' },
        { anchor: subject, rel: 'type', href: 'http://example.com/B' },
        { anchor: subject, rel: 'up', href: 'http://example.com/' },
      ], subject)).toEqual({
        linkset: [
          {
            anchor: subject,
            type: [{ href: 'http://example.com/A' }, { href: 'http://example.com/B' }],
            up: [{ href: 'http://example.com/' }],
          },
          { anchor: target, type: [{ href: 'http://example.com/Type' }]},
        ],
      });
    });

    it('includes the primary anchor even without links.', async(): Promise<void> => {
      expect(linksToLinkset([], subject)).toEqual({ linkset: [{ anchor: subject }]});
    });

    it('does not require a primary anchor.', async(): Promise<void> => {
      expect(linksToLinkset([])).toEqual({ linkset: []});
      expect(linksToLinkset([{ anchor: subject, rel: 'up', href: target }]))
        .toEqual({ linkset: [{ anchor: subject, up: [{ href: target }]}]});
    });
  });

  describe('#linksetToLinks', (): void => {
    const base = 'http://example.com/foo.meta';

    it('extracts the links from a linkset document.', async(): Promise<void> => {
      expect(linksetToLinks({
        linkset: [
          { anchor: subject, type: [{ href: 'http://example.com/A' }, { href: 'B', title: 'b' }]},
          { up: [{ href: '/' }]},
          { anchor: 'bar', 'http://example.com/rel': []},
        ],
      }, base, subject)).toEqual([
        { anchor: subject, rel: 'type', href: 'http://example.com/A' },
        { anchor: subject, rel: 'type', href: 'http://example.com/B' },
        { anchor: subject, rel: 'up', href: 'http://example.com/' },
      ]);
    });

    it('resolves relative anchors.', async(): Promise<void> => {
      expect(linksetToLinks({ linkset: [{ anchor: 'bar', up: [{ href: './' }]}]}, base, subject))
        .toEqual([{ anchor: target, rel: 'up', href: 'http://example.com/' }]);
    });

    it('rejects documents without linkset array.', async(): Promise<void> => {
      expect((): any => linksetToLinks([], base, subject)).toThrow(UnprocessableEntityHttpError);
      expect((): any => linksetToLinks({ linkset: {}}, base, subject))
        .toThrow('A linkset document must be an object with a linkset array.');
    });

    it('rejects linkset entries that are not objects.', async(): Promise<void> => {
      expect((): any => linksetToLinks({ linkset: [ 'a' ]}, base, subject))
        .toThrow('Every entry of a linkset must be a link context object.');
    });

    it('rejects anchors that are not strings.', async(): Promise<void> => {
      expect((): any => linksetToLinks({ linkset: [{ anchor: 5 }]}, base, subject))
        .toThrow('The anchor of a link context object must be a string.');
    });

    it('rejects targets that are not arrays.', async(): Promise<void> => {
      expect((): any => linksetToLinks({ linkset: [{ up: { href: '/' }}]}, base, subject))
        .toThrow('The targets of relation up must be an array.');
    });

    it('rejects targets without href.', async(): Promise<void> => {
      expect((): any => linksetToLinks({ linkset: [{ up: [ 'a' ]}]}, base, subject))
        .toThrow('Every target of relation up must have an href.');
      expect((): any => linksetToLinks({ linkset: [{ up: [{ href: 5 }]}]}, base, subject))
        .toThrow('Every target of relation up must have an href.');
    });

    it('rejects invalid URI references.', async(): Promise<void> => {
      expect((): any => linksetToLinks({ linkset: [{ up: [{ href: 'http://[' }]}]}, base, subject))
        .toThrow('Invalid URI reference http://[.');
    });
  });
});
