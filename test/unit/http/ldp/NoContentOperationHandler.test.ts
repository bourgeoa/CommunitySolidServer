import type { OperationHandler, OperationHandlerInput } from '../../../../src/http/ldp/OperationHandler';
import { NoContentOperationHandler } from '../../../../src/http/ldp/NoContentOperationHandler';
import type { Operation } from '../../../../src/http/Operation';
import { OkResponseDescription } from '../../../../src/http/output/response/OkResponseDescription';
import { ResetResponseDescription } from '../../../../src/http/output/response/ResetResponseDescription';
import { ResponseDescription } from '../../../../src/http/output/response/ResponseDescription';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import { RepresentationMetadata } from '../../../../src/http/representation/RepresentationMetadata';
import { guardedStreamFrom } from '../../../../src/util/StreamUtil';

describe('A NoContentOperationHandler', (): void => {
  let input: OperationHandlerInput;
  let source: jest.Mocked<OperationHandler>;
  let handler: NoContentOperationHandler;

  beforeEach(async(): Promise<void> => {
    const operation: Operation = {
      method: 'DELETE',
      target: { path: 'http://example.com/foo' },
      preferences: {},
      body: new BasicRepresentation(),
    };
    input = { operation };

    source = {
      canHandle: jest.fn(),
      handle: jest.fn().mockResolvedValue(new ResetResponseDescription()),
    } as any;

    handler = new NoContentOperationHandler(source);
  });

  it('supports the same input as its source.', async(): Promise<void> => {
    await expect(handler.canHandle(input)).resolves.toBeUndefined();
    expect(source.canHandle).toHaveBeenLastCalledWith(input);

    source.canHandle.mockRejectedValueOnce(new Error('bad input'));
    await expect(handler.canHandle(input)).rejects.toThrow('bad input');
  });

  it('replaces 205 responses with 204 responses.', async(): Promise<void> => {
    const metadata = new RepresentationMetadata();
    source.handle.mockResolvedValueOnce(new ResponseDescription(205, metadata));
    const result = await handler.handle(input);
    expect(source.handle).toHaveBeenLastCalledWith(input);
    expect(result.statusCode).toBe(204);
    expect(result.metadata).toBe(metadata);
    expect(result.data).toBeUndefined();
  });

  it('destroys the data of 205 responses.', async(): Promise<void> => {
    const data = guardedStreamFrom('data');
    source.handle.mockResolvedValueOnce(new ResponseDescription(205, undefined, data));
    const result = await handler.handle(input);
    expect(result.statusCode).toBe(204);
    expect(result.data).toBeUndefined();
    expect(data.destroyed).toBe(true);
  });

  it('returns other responses unchanged.', async(): Promise<void> => {
    const response = new OkResponseDescription(new RepresentationMetadata());
    source.handle.mockResolvedValueOnce(response);
    await expect(handler.handle(input)).resolves.toBe(response);
  });
});
