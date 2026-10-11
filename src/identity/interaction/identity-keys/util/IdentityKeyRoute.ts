import type { AccountIdKey, AccountIdRoute } from '../../account/AccountIdRoute';
import { IdInteractionRoute } from '../../routing/IdInteractionRoute';
import type { ExtendedRoute } from '../../routing/InteractionRoute';

export type IdentityKeyIdKey = 'identityKeyId';

/**
 * An {@link AccountIdRoute} that also includes an identity key identifier.
 */
export type IdentityKeyIdRoute = ExtendedRoute<AccountIdRoute, IdentityKeyIdKey>;

/**
 * Implementation of an {@link IdentityKeyIdRoute}
 * that adds the identifier relative to a base {@link AccountIdRoute}.
 */
export class BaseIdentityKeyIdRoute extends IdInteractionRoute<AccountIdKey, IdentityKeyIdKey> {
  public constructor(base: AccountIdRoute) {
    super(base, 'identityKeyId');
  }
}
