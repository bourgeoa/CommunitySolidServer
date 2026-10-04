import { NoContentResponseDescription } from '../output/response/NoContentResponseDescription';
import type { ResponseDescription } from '../output/response/ResponseDescription';
import type { OperationHandlerInput } from './OperationHandler';
import { OperationHandler } from './OperationHandler';

/**
 * Wraps an {@link OperationHandler} and replaces all 205 (Reset Content) responses with 204 (No Content) responses.
 *
 * LWS, §Delete resource: "On success, the server MUST respond with 204 No Content."
 * LWS clients also expect 200 or 204 after successful PUT and PATCH requests.
 */
export class NoContentOperationHandler extends OperationHandler {
  private readonly source: OperationHandler;

  public constructor(source: OperationHandler) {
    super();
    this.source = source;
  }

  public async canHandle(input: OperationHandlerInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    const result = await this.source.handle(input);
    if (result.statusCode === 205) {
      result.data?.destroy();
      return new NoContentResponseDescription(result.metadata);
    }
    return result;
  }
}
