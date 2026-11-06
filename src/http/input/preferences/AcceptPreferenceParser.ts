import type { HttpRequest } from '../../../server/HttpRequest';
import type { Accept, AcceptHeader } from '../../../util/Header';
import {
  parseAccept,
  parseAcceptCharset,
  parseAcceptDateTime,
  parseAcceptEncoding,
  parseAcceptLanguage,
} from '../../../util/HeaderUtil';
import type { RepresentationPreferences } from '../../representation/RepresentationPreferences';
import { PreferenceParser } from './PreferenceParser';

const parsers: {
  name: Exclude<keyof RepresentationPreferences, 'range' | 'profiles'>;
  header: string;
  parse: (value: string) => AcceptHeader[];
}[] = [
  { name: 'type', header: 'accept', parse: parseAccept },
  { name: 'charset', header: 'accept-charset', parse: parseAcceptCharset },
  { name: 'encoding', header: 'accept-encoding', parse: parseAcceptEncoding },
  { name: 'language', header: 'accept-language', parse: parseAcceptLanguage },
  { name: 'datetime', header: 'accept-datetime', parse: parseAcceptDateTime },
];

/**
 * Extracts preferences from the Accept-* headers from an incoming {@link HttpRequest}.
 * Supports Accept, Accept-Charset, Accept-Encoding, Accept-Language and Accept-DateTime.
 * The `profile` parameters of the Accept header are stored in the `profiles` preferences.
 */
export class AcceptPreferenceParser extends PreferenceParser {
  public async handle({ request: { headers }}: { request: HttpRequest }): Promise<RepresentationPreferences> {
    const preferences: RepresentationPreferences = {};
    for (const { name, header, parse } of parsers) {
      const value = headers[header];
      if (typeof value === 'string') {
        const result = Object.fromEntries(parse(value)
          .map(({ range, weight }): [string, number] => [ range, weight ]));
        // Interpret empty headers (or headers with no valid values) the same as missing headers
        if (Object.keys(result).length > 0) {
          preferences[name] = result;
        }
      }
    }
    if (typeof headers.accept === 'string') {
      this.addProfiles(preferences, parseAccept(headers.accept));
    }
    return preferences;
  }

  /**
   * Stores the media ranges with a `profile` parameter, which can contain multiple space-separated URIs.
   */
  private addProfiles(preferences: RepresentationPreferences, accepts: Accept[]): void {
    for (const { range, weight, parameters } of accepts) {
      const profiles = parameters.mediaType.profile?.split(/\s+/u).filter((profile): boolean => profile.length > 0);
      for (const profile of profiles ?? []) {
        preferences.profiles ??= {};
        preferences.profiles[profile] = { ...preferences.profiles[profile], [range]: weight };
      }
    }
  }
}
