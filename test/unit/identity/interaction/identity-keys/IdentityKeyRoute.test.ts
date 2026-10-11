import { BaseAccountIdRoute } from '../../../../../src/identity/interaction/account/AccountIdRoute';
import {
  BaseIdentityKeyIdRoute,
} from '../../../../../src/identity/interaction/identity-keys/util/IdentityKeyRoute';
import {
  AbsolutePathInteractionRoute,
} from '../../../../../src/identity/interaction/routing/AbsolutePathInteractionRoute';

describe('A BaseIdentityKeyIdRoute', (): void => {
  it('uses the identity key ID key.', async(): Promise<void> => {
    const keyIdRoute = new BaseIdentityKeyIdRoute(new BaseAccountIdRoute(
      new AbsolutePathInteractionRoute('http://example.com/'),
    ));
    expect(keyIdRoute.matchPath('http://example.com/123/456/'))
      .toEqual({ accountId: '123', identityKeyId: '456' });
  });
});
