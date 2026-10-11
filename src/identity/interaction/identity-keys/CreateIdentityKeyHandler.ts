import type { JWK } from 'jose';
import { object, string } from 'yup';
import { getLoggerFor } from '../../../logging/LogUtil';
import { BadRequestHttpError } from '../../../util/errors/BadRequestHttpError';
import type { IdentityKeyStore } from '../../lws/IdentityKeyStore';
import { assertAccountId } from '../account/util/AccountUtil';
import type { JsonRepresentation } from '../InteractionUtil';
import { JsonInteractionHandler } from '../JsonInteractionHandler';
import type { JsonInteractionHandlerInput } from '../JsonInteractionHandler';
import type { JsonView } from '../JsonView';
import type { WebIdStore } from '../webid/util/WebIdStore';
import { parseSchema, validateWithError } from '../YupUtil';
import type { IdentityKeyIdRoute } from './util/IdentityKeyRoute';

const inSchema = object({
  webId: string().trim().required(),
  label: string().trim().optional(),
  publicKeyJwk: object({
    kty: string().required(),
  }).required(),
});

type OutType = {
  id: string;
  keyId: string;
  label: string;
  webId: string;
  resource: string;
};

/**
 * Handles the registration of the public keys of a WebID.
 *
 * Registering a key allows an agent to authenticate with a self-issued credential
 * for a subject whose controlled identifier document this server cannot retrieve,
 * which is why the keys are registered through an authenticated account instead of being dereferenced.
 */
export class CreateIdentityKeyHandler extends JsonInteractionHandler<OutType> implements JsonView {
  protected readonly logger = getLoggerFor(this);

  private readonly webIdStore: WebIdStore;
  private readonly keyStore: IdentityKeyStore;
  private readonly keyRoute: IdentityKeyIdRoute;

  public constructor(webIdStore: WebIdStore, keyStore: IdentityKeyStore, keyRoute: IdentityKeyIdRoute) {
    super();
    this.webIdStore = webIdStore;
    this.keyStore = keyStore;
    this.keyRoute = keyRoute;
  }

  public async getView({ accountId }: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    assertAccountId(accountId);
    const keys: Record<string, string> = {};
    for (const { keyId, label } of await this.keyStore.findByAccount(accountId)) {
      keys[label] = keyId;
    }
    return { json: { ...parseSchema(inSchema), keys }};
  }

  public async handle({ accountId, json }: JsonInteractionHandlerInput): Promise<JsonRepresentation<OutType>> {
    assertAccountId(accountId);
    const { webId, label, publicKeyJwk } = await validateWithError(inSchema, json);

    if (!await this.webIdStore.isLinked(webId, accountId)) {
      this.logger.warn(`Trying to register a key for ${webId} which does not belong to account ${accountId}`);
      throw new BadRequestHttpError('WebID does not belong to this account.');
    }

    const key = await this.keyStore.create(webId, accountId, publicKeyJwk as JWK, label);
    const resource = this.keyRoute.getPath({ accountId, identityKeyId: key.id });

    // The keyId is the value that has to be used as the kid of a credential signed with this key
    return { json: { id: key.id, keyId: key.keyId, label: key.label, webId: key.webId, resource }};
  }
}
