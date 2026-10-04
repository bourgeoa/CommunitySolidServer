import {
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_ID_TOKEN,
  TOKEN_TYPE_ID_TOKEN_ALT,
  TOKEN_TYPE_JWT,
} from '../../../../src/identity/lws/SubjectTokenVerifier';

describe('SubjectTokenVerifier', (): void => {
  it('exports the token type URIs.', async(): Promise<void> => {
    expect(TOKEN_TYPE_JWT).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(TOKEN_TYPE_ID_TOKEN).toBe('urn:ietf:params:oauth:token-type:id_token');
    expect(TOKEN_TYPE_ID_TOKEN_ALT).toBe('urn:ietf:params:oauth:token-type:id-token');
    expect(TOKEN_TYPE_ACCESS_TOKEN).toBe('urn:ietf:params:oauth:token-type:access_token');
  });
});
