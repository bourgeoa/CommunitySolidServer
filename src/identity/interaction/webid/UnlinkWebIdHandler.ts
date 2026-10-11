import { NotFoundHttpError } from '../../../util/errors/NotFoundHttpError';
import type { EmptyObject } from '../../../util/map/MapUtil';
import type { IdentityKeyStore } from '../../lws/IdentityKeyStore';
import { parsePath, verifyAccountId } from '../account/util/AccountUtil';
import type { JsonRepresentation } from '../InteractionUtil';
import type { JsonInteractionHandlerInput } from '../JsonInteractionHandler';
import { JsonInteractionHandler } from '../JsonInteractionHandler';
import type { WebIdStore } from './util/WebIdStore';
import type { WebIdLinkRoute } from './WebIdLinkRoute';

/**
 * Allows users to remove WebIDs linked to their account.
 */
export class UnlinkWebIdHandler extends JsonInteractionHandler<EmptyObject> {
  private readonly webIdStore: WebIdStore;
  private readonly webIdRoute: WebIdLinkRoute;
  private readonly keyStore: IdentityKeyStore;

  public constructor(webIdStore: WebIdStore, webIdRoute: WebIdLinkRoute, keyStore: IdentityKeyStore) {
    super();
    this.webIdStore = webIdStore;
    this.webIdRoute = webIdRoute;
    this.keyStore = keyStore;
  }

  public async handle({ target, accountId }: JsonInteractionHandlerInput): Promise<JsonRepresentation<EmptyObject>> {
    const match = parsePath(this.webIdRoute, target.path);

    const link = await this.webIdStore.get(match.webIdLink);
    verifyAccountId(accountId, link?.accountId);
    if (!link) {
      throw new NotFoundHttpError();
    }

    await this.webIdStore.delete(match.webIdLink);

    // The keys of the WebID are removed with the link, since the link is the only way to manage them
    await this.keyStore.deleteByWebId(link.webId);

    return { json: {}};
  }
}
