import type { RepresentationPreferences } from '../../representation/RepresentationPreferences';
import { PreferenceParser } from './PreferenceParser';

/**
 * Always returns the same media type preference, independent of the request.
 * Can be used to generate a fallback representation if the media types the client prefers are not available,
 * such as problem details documents for errors.
 */
export class StaticTypePreferenceParser extends PreferenceParser {
  private readonly type: string;

  /**
   * @param type - The media type to prefer.
   */
  public constructor(type: string) {
    super();
    this.type = type;
  }

  public async handle(): Promise<RepresentationPreferences> {
    return { type: { [this.type]: 1 }};
  }
}
