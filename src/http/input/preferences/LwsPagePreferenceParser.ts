import type { HttpRequest } from '../../../server/HttpRequest';
import { BadRequestHttpError } from '../../../util/errors/BadRequestHttpError';
import type { RepresentationPreferences } from '../../representation/RepresentationPreferences';
import { PreferenceParser } from './PreferenceParser';

/**
 * The range unit used to indicate which page of a paginated container listing is requested.
 */
export const LWS_PAGE_UNIT = 'lws-page';

/**
 * Parses the page query parameter of LWS container page URIs into range preferences,
 * using the {@link LWS_PAGE_UNIT} unit and the page number as start value.
 * The parameter is ignored if the request has a `Range` header.
 *
 * Page URIs are opaque to LWS clients, which only discover them through pagination links.
 * The query string is not part of the target identifier,
 * so the page URIs of a container identify the container itself.
 */
export class LwsPagePreferenceParser extends PreferenceParser {
  private readonly parameter: string;

  /**
   * @param parameter - The name of the query parameter. Defaults to `page`.
   */
  public constructor(parameter = 'page') {
    super();
    this.parameter = parameter;
  }

  public async handle({ request: { url, headers }}: { request: HttpRequest }): Promise<RepresentationPreferences> {
    const query = url?.split('?')[1];
    const page = query ? new URLSearchParams(query).get(this.parameter) : null;
    // Byte ranges take precedence, as only one range can be requested
    if (page === null || headers.range) {
      return {};
    }
    if (!/^[1-9]\d*$/u.test(page)) {
      throw new BadRequestHttpError(`Invalid page ${page}`);
    }
    return { range: { unit: LWS_PAGE_UNIT, parts: [{ start: Number.parseInt(page, 10) }]}};
  }
}
