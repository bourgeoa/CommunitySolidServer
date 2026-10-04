import { LwsContainerTypeParser } from '../../../../../src/http/input/metadata/LwsContainerTypeParser';
import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import type { HttpRequest } from '../../../../../src/server/HttpRequest';
import { LDP, LWS, RDF } from '../../../../../src/util/Vocabularies';

describe('A LwsContainerTypeParser', (): void => {
  const parser = new LwsContainerTypeParser();
  let request: HttpRequest;
  let metadata: RepresentationMetadata;

  beforeEach(async(): Promise<void> => {
    request = { headers: {}} as HttpRequest;
    metadata = new RepresentationMetadata();
  });

  it('does nothing if there are no link headers.', async(): Promise<void> => {
    await expect(parser.handle({ request, metadata })).resolves.toBeUndefined();
    expect(metadata.quads()).toHaveLength(0);
  });

  it('does nothing if the container type has a different rel.', async(): Promise<void> => {
    request.headers.link = `<${LWS.Container}>; rel="describedby"`;
    await expect(parser.handle({ request, metadata })).resolves.toBeUndefined();
    expect(metadata.quads()).toHaveLength(0);
  });

  it('does nothing if the type is not the LWS container type.', async(): Promise<void> => {
    request.headers.link = `<${LWS.DataResource}>; rel="type"`;
    await expect(parser.handle({ request, metadata })).resolves.toBeUndefined();
    expect(metadata.quads()).toHaveLength(0);
  });

  it('adds the basic container type if the LWS container type is present.', async(): Promise<void> => {
    request.headers.link = [ '<http://example.com/other>; rel="type"', `<${LWS.Container}>; rel="type"` ];
    await expect(parser.handle({ request, metadata })).resolves.toBeUndefined();
    expect(metadata.quads()).toHaveLength(1);
    expect(metadata.has(RDF.terms.type, LDP.terms.BasicContainer)).toBe(true);
  });
});
