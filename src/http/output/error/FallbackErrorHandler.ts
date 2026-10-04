import { getLoggerFor } from '../../../logging/LogUtil';
import { createErrorMessage } from '../../../util/errors/ErrorUtil';
import type { ResponseDescription } from '../response/ResponseDescription';
import type { ErrorHandlerArgs } from './ErrorHandler';
import { ErrorHandler } from './ErrorHandler';

/**
 * Uses the fallback handler if the source handler can not handle the error or fails while handling it.
 * An example is the case where the error can not be converted to any of the media types the client prefers.
 */
export class FallbackErrorHandler extends ErrorHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly source: ErrorHandler;
  private readonly fallback: ErrorHandler;

  public constructor(source: ErrorHandler, fallback: ErrorHandler) {
    super();
    this.source = source;
    this.fallback = fallback;
  }

  public async handle(input: ErrorHandlerArgs): Promise<ResponseDescription> {
    try {
      return await this.source.handleSafe(input);
    } catch (error: unknown) {
      this.logger.debug(`Using the fallback error handler: ${createErrorMessage(error)}`);
      return this.fallback.handleSafe(input);
    }
  }
}
