import { DataFactory } from 'n3';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { Representation } from '../../../../src/http/representation/Representation';
import type { RepresentationPreferences } from '../../../../src/http/representation/RepresentationPreferences';
import { LinksetMapper } from '../../../../src/storage/conversion/LinksetMapper';
import { QuadToLinksetConverter } from '../../../../src/storage/conversion/QuadToLinksetConverter';
import { SingleRootIdentifierStrategy } from '../../../../src/util/identifiers/SingleRootIdentifierStrategy';
import { readableToString } from '../../../../src/util/StreamUtil';
import { LWS, RDF } from '../../../../src/util/Vocabularies';
import { SimpleSuffixStrategy } from '../../../util/SimpleSuffixStrategy';

const { namedNode, quad } = DataFactory;

describe('A QuadToLinksetConverter', (): void => {
  const subject = 'http://test.com/foo';
  const identifier = { path: 'http://test.com/foo.meta' };
  const preferences: RepresentationPreferences = { type: { 'application/linkset+json': 1 }};
  const metadataStrategy = new SimpleSuffixStrategy('.meta');
  const mapper = new LinksetMapper(metadataStrategy, new SingleRootIdentifierStrategy('http://test.com/'));
  let representation: Representation;
  let converter: QuadToLinksetConverter;

  beforeEach(async(): Promise<void> => {
    representation = new BasicRepresentation([
      quad(namedNode(subject), RDF.terms.type, namedNode('http://example.com/Type')),
    ], identifier, 'internal/quads');
    converter = new QuadToLinksetConverter(metadataStrategy, mapper);
  });

  it('supports metadata resources.', async(): Promise<void> => {
    await expect(converter.canHandle({ identifier, representation, preferences })).resolves.toBeUndefined();
  });

  it('rejects other resources.', async(): Promise<void> => {
    await expect(converter.canHandle({ identifier: { path: subject }, representation, preferences }))
      .rejects.toThrow('Only metadata resources can be converted to a linkset.');
  });

  it('rejects requests for other types.', async(): Promise<void> => {
    await expect(converter.canHandle({ identifier, representation, preferences: { type: { 'text/turtle': 1 }}}))
      .rejects.toThrow('Cannot convert from internal/quads to text/turtle');
  });

  it('converts the metadata to a linkset.', async(): Promise<void> => {
    const result = await converter.handle({ identifier, representation, preferences });
    expect(result.metadata.contentType).toBe('application/linkset+json');
    expect(result.metadata.identifier.value).toBe(identifier.path);
    expect(JSON.parse(await readableToString(result.data))).toEqual({
      linkset: [{
        anchor: subject,
        type: [{ href: 'http://example.com/Type' }, { href: LWS.DataResource }],
        up: [{ href: 'http://test.com/' }],
      }],
    });
  });
});
