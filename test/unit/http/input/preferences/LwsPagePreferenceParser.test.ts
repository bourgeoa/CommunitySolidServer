import {
  LWS_PAGE_UNIT,
  LwsPagePreferenceParser,
} from '../../../../../src/http/input/preferences/LwsPagePreferenceParser';
import { BadRequestHttpError } from '../../../../../src/util/errors/BadRequestHttpError';

describe('A LwsPagePreferenceParser', (): void => {
  const parser = new LwsPagePreferenceParser();

  it('parses the page query parameter.', async(): Promise<void> => {
    await expect(parser.handle({ request: { url: '/container/?page=3', headers: {}}} as any))
      .resolves.toEqual({ range: { unit: LWS_PAGE_UNIT, parts: [{ start: 3 }]}});
    await expect(parser.handle({ request: { url: '/container/?foo=bar&page=12', headers: {}}} as any))
      .resolves.toEqual({ range: { unit: 'lws-page', parts: [{ start: 12 }]}});
  });

  it('returns an empty object if there is no page parameter.', async(): Promise<void> => {
    await expect(parser.handle({ request: { url: '/container/', headers: {}}} as any)).resolves.toEqual({});
    await expect(parser.handle({ request: { url: '/container/?foo=bar', headers: {}}} as any)).resolves.toEqual({});
    await expect(parser.handle({ request: { headers: {}}} as any)).resolves.toEqual({});
  });

  it('ignores the page parameter if there is a Range header.', async(): Promise<void> => {
    await expect(parser.handle({ request: { url: '/container/?page=3', headers: { range: 'bytes=0-5' }}} as any))
      .resolves.toEqual({});
  });

  it('rejects invalid page values.', async(): Promise<void> => {
    for (const page of [ '0', '-1', 'abc', '1.5', '01', '' ]) {
      await expect(parser.handle({ request: { url: `/container/?page=${page}`, headers: {}}} as any))
        .rejects.toThrow(BadRequestHttpError);
    }
    await expect(parser.handle({ request: { url: '/container/?page=abc', headers: {}}} as any))
      .rejects.toThrow('Invalid page abc');
  });

  it('can use a different query parameter.', async(): Promise<void> => {
    const customParser = new LwsPagePreferenceParser('p');
    await expect(customParser.handle({ request: { url: '/container/?p=2', headers: {}}} as any))
      .resolves.toEqual({ range: { unit: LWS_PAGE_UNIT, parts: [{ start: 2 }]}});
    await expect(customParser.handle({ request: { url: '/container/?page=2', headers: {}}} as any))
      .resolves.toEqual({});
  });
});
