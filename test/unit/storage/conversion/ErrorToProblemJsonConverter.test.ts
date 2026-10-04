import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import { ErrorToProblemJsonConverter } from '../../../../src/storage/conversion/ErrorToProblemJsonConverter';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { HttpError } from '../../../../src/util/errors/HttpError';
import { errorTermsToMetadata } from '../../../../src/util/errors/HttpErrorUtil';
import type { OAuthErrorFields } from '../../../../src/util/errors/OAuthHttpError';
import { OAuthHttpError } from '../../../../src/util/errors/OAuthHttpError';
import { readJsonStream } from '../../../../src/util/StreamUtil';

describe('An ErrorToProblemJsonConverter', (): void => {
  const identifier = { path: 'http://test.com/error' };
  const converter = new ErrorToProblemJsonConverter();
  const preferences = {};

  async function convert(error: unknown): Promise<unknown> {
    const representation = new BasicRepresentation([ error ], 'internal/error', false);
    const result = await converter.handle({ identifier, representation, preferences });
    expect(result.binary).toBe(true);
    expect(result.metadata.contentType).toBe('application/problem+json');
    return readJsonStream(result.data);
  }

  it('supports going from errors to problem details.', async(): Promise<void> => {
    await expect(converter.getOutputTypes('internal/error')).resolves.toEqual({ 'application/problem+json': 1 });
    await expect(new ErrorToProblemJsonConverter(0.5).getOutputTypes('internal/error'))
      .resolves.toEqual({ 'application/problem+json': 0.5 });
  });

  it('converts HttpErrors.', async(): Promise<void> => {
    const error = new BadRequestHttpError('error text');
    await expect(convert(error)).resolves.toEqual({
      type: 'urn:solid-server:error:H400',
      title: 'Bad Request',
      status: 400,
      detail: 'error text',
      stack: error.stack,
    });
  });

  it('adds the HttpError details.', async(): Promise<void> => {
    const metadata = errorTermsToMetadata({ important: 'detail' });
    const error = new BadRequestHttpError('error text', { metadata, errorCode: 'E0001' });
    delete error.stack;
    await expect(convert(error)).resolves.toEqual({
      type: 'urn:solid-server:error:E0001',
      title: 'Bad Request',
      status: 400,
      detail: 'error text',
      details: { important: 'detail' },
    });
  });

  it('adds OAuth fields if present.', async(): Promise<void> => {
    const fields: OAuthErrorFields = {
      error: 'error',
      error_description: 'error_description',
      scope: 'scope',
      state: 'state',
    };
    const error = new OAuthHttpError(fields, 'InvalidRequest', 400, 'error text');
    await expect(convert(error)).resolves.toEqual({
      type: 'urn:solid-server:error:H400',
      title: 'Bad Request',
      status: 400,
      detail: 'error text',
      stack: error.stack,
      ...fields,
    });
  });

  it('uses the error name as title for unknown status codes.', async(): Promise<void> => {
    const error = new HttpError(599, 'StrangeError');
    delete error.stack;
    await expect(convert(error)).resolves.toEqual({
      type: 'urn:solid-server:error:H599',
      title: 'StrangeError',
      status: 599,
    });
  });

  it('converts other errors to internal server errors.', async(): Promise<void> => {
    const error = new Error('error text');
    await expect(convert(error)).resolves.toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'error text',
      stack: error.stack,
    });
  });

  it('converts values that are not errors to a generic problem.', async(): Promise<void> => {
    await expect(convert('not an error')).resolves.toEqual({
      title: 'Internal Server Error',
      status: 500,
    });
  });
});
