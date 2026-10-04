import type { ErrorHandler, ErrorHandlerArgs } from '../../../../../src/http/output/error/ErrorHandler';
import { FallbackErrorHandler } from '../../../../../src/http/output/error/FallbackErrorHandler';
import type { ResponseDescription } from '../../../../../src/http/output/response/ResponseDescription';
import { NotFoundHttpError } from '../../../../../src/util/errors/NotFoundHttpError';

describe('A FallbackErrorHandler', (): void => {
  const input: ErrorHandlerArgs = { error: new NotFoundHttpError(), request: {} as any };
  const sourceResult: ResponseDescription = { statusCode: 404 };
  const fallbackResult: ResponseDescription = { statusCode: 500 };
  let source: jest.Mocked<ErrorHandler>;
  let fallback: jest.Mocked<ErrorHandler>;
  let handler: FallbackErrorHandler;

  beforeEach(async(): Promise<void> => {
    source = {
      handleSafe: jest.fn().mockResolvedValue(sourceResult),
    } as any;
    fallback = {
      handleSafe: jest.fn().mockResolvedValue(fallbackResult),
    } as any;
    handler = new FallbackErrorHandler(source, fallback);
  });

  it('returns the result of the source handler.', async(): Promise<void> => {
    await expect(handler.handle(input)).resolves.toBe(sourceResult);
    expect(source.handleSafe).toHaveBeenLastCalledWith(input);
    expect(fallback.handleSafe).toHaveBeenCalledTimes(0);
  });

  it('uses the fallback handler if the source handler fails.', async(): Promise<void> => {
    source.handleSafe.mockRejectedValueOnce(new Error('bad data'));
    await expect(handler.handle(input)).resolves.toBe(fallbackResult);
    expect(fallback.handleSafe).toHaveBeenLastCalledWith(input);
  });

  it('throws the error of the fallback handler if both fail.', async(): Promise<void> => {
    source.handleSafe.mockRejectedValueOnce(new Error('bad data'));
    fallback.handleSafe.mockRejectedValueOnce(new Error('fallback failed'));
    await expect(handler.handle(input)).rejects.toThrow('fallback failed');
  });
});
