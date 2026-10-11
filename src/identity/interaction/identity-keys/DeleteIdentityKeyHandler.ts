import type { EmptyObject } from '../../../util/map/MapUtil';
import type { IdentityKeyStore } from '../../lws/IdentityKeyStore';
import { parsePath, verifyAccountId } from '../account/util/AccountUtil';
import type { JsonRepresentation } from '../InteractionUtil';
import { JsonInteractionHandler } from '../JsonInteractionHandler';
import type { JsonInteractionHandlerInput } from '../JsonInteractionHandler';
import type { IdentityKeyIdRoute } from './util/IdentityKeyRoute';

/**
 * Handles the removal of registered identity keys.
 */
export class DeleteIdentityKeyHandler extends JsonInteractionHandler<EmptyObject> {
  private readonly keyStore: IdentityKeyStore;
  private readonly keyRoute: IdentityKeyIdRoute;

  public constructor(keyStore: IdentityKeyStore, keyRoute: IdentityKeyIdRoute) {
    super();
    this.keyStore = keyStore;
    this.keyRoute = keyRoute;
  }

  public async handle({ target, accountId }: JsonInteractionHandlerInput): Promise<JsonRepresentation<EmptyObject>> {
    const match = parsePath(this.keyRoute, target.path);

    const key = await this.keyStore.get(match.identityKeyId);
    verifyAccountId(accountId, key?.accountId);

    await this.keyStore.delete(match.identityKeyId);

    return { json: {}};
  }
}
