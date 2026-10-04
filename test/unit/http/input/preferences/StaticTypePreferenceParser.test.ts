import { StaticTypePreferenceParser } from '../../../../../src/http/input/preferences/StaticTypePreferenceParser';

describe('A StaticTypePreferenceParser', (): void => {
  const parser = new StaticTypePreferenceParser('application/problem+json');

  it('always returns the configured type preference.', async(): Promise<void> => {
    await expect(parser.handle()).resolves.toEqual({ type: { 'application/problem+json': 1 }});
    await expect(parser.handleSafe({ request: { headers: { accept: 'text/html' }}} as any))
      .resolves.toEqual({ type: { 'application/problem+json': 1 }});
  });
});
