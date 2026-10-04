import { NoContentResponseDescription } from '../../../../../src/http/output/response/NoContentResponseDescription';
import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';

describe('A NoContentResponseDescription', (): void => {
  it('has status code 204 and no data.', async(): Promise<void> => {
    const metadata = new RepresentationMetadata();
    const description = new NoContentResponseDescription(metadata);
    expect(description.statusCode).toBe(204);
    expect(description.metadata).toBe(metadata);
    expect(description.data).toBeUndefined();
  });

  it('does not require metadata.', async(): Promise<void> => {
    const description = new NoContentResponseDescription();
    expect(description.statusCode).toBe(204);
    expect(description.metadata).toBeUndefined();
  });
});
