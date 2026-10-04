/* eslint-disable @typescript-eslint/naming-convention */
import { randomUUID } from 'node:crypto';
import type { Credentials } from '../../../authentication/Credentials';
import type { CredentialsExtractor } from '../../../authentication/CredentialsExtractor';
import { isAbsoluteUri, LWS_CONTEXT_URI } from '../../../authorization/lws/AccessGrantUtil';
import type { PermissionReader } from '../../../authorization/PermissionReader';
import { AccessMode } from '../../../authorization/permissions/Permissions';
import { NoContentResponseDescription } from '../../../http/output/response/NoContentResponseDescription';
import { ResponseDescription } from '../../../http/output/response/ResponseDescription';
import { BasicRepresentation } from '../../../http/representation/BasicRepresentation';
import { getLoggerFor } from '../../../logging/LogUtil';
import { APPLICATION_JSON, APPLICATION_LD_JSON, APPLICATION_LWS_JSON } from '../../../util/ContentTypes';
import { BadRequestHttpError } from '../../../util/errors/BadRequestHttpError';
import { ForbiddenHttpError } from '../../../util/errors/ForbiddenHttpError';
import { MethodNotAllowedHttpError } from '../../../util/errors/MethodNotAllowedHttpError';
import { NotFoundHttpError } from '../../../util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../util/errors/NotImplementedHttpError';
import { UnauthorizedHttpError } from '../../../util/errors/UnauthorizedHttpError';
import { UnsupportedMediaTypeHttpError } from '../../../util/errors/UnsupportedMediaTypeHttpError';
import { isJsonObject } from '../../../util/JsonMergePatch';
import { IdentifierSetMultiMap } from '../../../util/map/IdentifierMap';
import { joinUrl } from '../../../util/PathUtil';
import { readableToString } from '../../../util/StreamUtil';
import { LWS, RDF, SOLID_HTTP } from '../../../util/Vocabularies';
import type { OperationHttpHandlerInput } from '../../OperationHttpHandler';
import { OperationHttpHandler } from '../../OperationHttpHandler';
import type { LwsSubscription, LwsSubscriptionStorage } from './LwsSubscriptionStorage';

const JSON_TYPES = new Set([ APPLICATION_LWS_JSON, APPLICATION_JSON, APPLICATION_LD_JSON ]);

/**
 * The subscription type of the LWS 1.0 Notification Suite: Webhooks.
 */
export const WEBHOOK_SUBSCRIPTION = 'WebhookSubscription';

export interface LwsSubscriptionHttpHandlerArgs {
  /**
   * Base URL of the server.
   */
  baseUrl: string;
  /**
   * Path of the subscription endpoint, relative to the base URL. Defaults to `.notifications/lws/`.
   */
  path?: string;
  /**
   * Extracts the credentials of the subscriber.
   */
  credentialsExtractor: CredentialsExtractor;
  /**
   * Determines whether the subscriber can read the topics.
   */
  permissionReader: PermissionReader;
  /**
   * Stores the subscriptions.
   */
  storage: LwsSubscriptionStorage;
}

/**
 * The subscription endpoint of the LWS 1.0 Notification Suite: Webhooks, see LWS, §Notifications.
 *
 * A POST request to the endpoint creates a subscription,
 * if the subscriber can read all resources of the `topic` array.
 * A GET request to the endpoint returns the subscriptions of the subscriber as an LWS container.
 * Every subscription supports GET and DELETE requests.
 * Subscriptions of authenticated subscribers can only be accessed by the same agent.
 */
export class LwsSubscriptionHttpHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly endpoint: string;
  private readonly credentialsExtractor: CredentialsExtractor;
  private readonly permissionReader: PermissionReader;
  private readonly storage: LwsSubscriptionStorage;

  public constructor(args: LwsSubscriptionHttpHandlerArgs) {
    super();
    this.endpoint = joinUrl(args.baseUrl, args.path ?? '.notifications/lws/');
    this.credentialsExtractor = args.credentialsExtractor;
    this.permissionReader = args.permissionReader;
    this.storage = args.storage;
  }

  public async canHandle({ operation }: OperationHttpHandlerInput): Promise<void> {
    if (!operation.target.path.startsWith(this.endpoint)) {
      throw new NotImplementedHttpError(`${operation.target.path} is not an LWS subscription resource.`);
    }
  }

  public async handle({ operation, request }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    const credentials = await this.credentialsExtractor.handleSafe(request);
    const { method, target } = operation;
    if (target.path === this.endpoint) {
      if (method === 'POST') {
        const body = await readableToString(operation.body.data);
        return this.subscribe(operation.body.metadata.contentType, body, credentials);
      }
      if (method === 'GET' || method === 'HEAD') {
        return this.list(credentials, method === 'HEAD');
      }
      throw new MethodNotAllowedHttpError([ method ]);
    }

    const subscription = await this.storage.get(target.path);
    if (!subscription || (subscription.webId && subscription.webId !== credentials.agent?.webId)) {
      throw new NotFoundHttpError();
    }
    if (method === 'GET' || method === 'HEAD') {
      return this.respond(200, this.toJson(subscription), method === 'HEAD');
    }
    if (method === 'DELETE') {
      await this.storage.delete(subscription.id);
      return new NoContentResponseDescription();
    }
    throw new MethodNotAllowedHttpError([ method ]);
  }

  /**
   * Creates a new subscription.
   */
  private async subscribe(contentType: string | undefined, body: string, credentials: Credentials):
  Promise<ResponseDescription> {
    if (!contentType || !JSON_TYPES.has(contentType)) {
      throw new UnsupportedMediaTypeHttpError(`Subscription requests need to be ${APPLICATION_LWS_JSON}.`);
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new BadRequestHttpError('Invalid JSON.');
    }
    if (!isJsonObject(json)) {
      throw new BadRequestHttpError('A subscription request needs to be a JSON object.');
    }
    const { type, topic, inbox, expires } = json;
    if (typeof type !== 'string') {
      throw new BadRequestHttpError('A subscription request needs a type.');
    }
    if (type !== WEBHOOK_SUBSCRIPTION) {
      throw new BadRequestHttpError(`Unsupported subscription type ${type}.`);
    }
    if (!Array.isArray(topic) || topic.length === 0 || !topic.every(isAbsoluteUri)) {
      throw new BadRequestHttpError('A subscription request needs an array of topic URIs.');
    }
    if (!isAbsoluteUri(inbox) || !/^https?:/u.test(inbox)) {
      throw new BadRequestHttpError('A webhook subscription needs an HTTP(S) inbox URL.');
    }
    if (expires !== undefined && (typeof expires !== 'string' || Number.isNaN(Date.parse(expires)))) {
      throw new BadRequestHttpError('expires needs to be a dateTime.');
    }
    if (typeof expires === 'string' && Date.parse(expires) <= Date.now()) {
      throw new BadRequestHttpError('expires needs to be in the future.');
    }

    await this.assertReadable(topic, credentials);

    const subscription: LwsSubscription = {
      id: joinUrl(this.endpoint, randomUUID()),
      type,
      topic,
      inbox,
      ...expires ? { expires: new Date(expires).toISOString() } : {},
      ...credentials.agent?.webId ? { webId: credentials.agent.webId } : {},
      ...credentials.client?.clientId ? { clientId: credentials.client.clientId } : {},
    };
    await this.storage.add(subscription);
    this.logger.debug(`Created LWS subscription ${subscription.id} for ${topic.join(', ')}`);

    const response = this.respond(201, this.toJson(subscription));
    response.metadata!.set(SOLID_HTTP.terms.location, subscription.id);
    return response;
  }

  /**
   * Throws an error if the subscriber can not read all of the given resources.
   */
  private async assertReadable(topics: string[], credentials: Credentials): Promise<void> {
    const requestedModes = new IdentifierSetMultiMap<AccessMode>(
      topics.map((path): [{ path: string }, AccessMode] => [{ path }, AccessMode.read ]),
    );
    const permissions = await this.permissionReader.handleSafe({ credentials, requestedModes });
    for (const path of topics) {
      if (!permissions.get({ path })?.read) {
        throw credentials.agent?.webId ?
          new ForbiddenHttpError(`No read access to ${path}.`) :
          new UnauthorizedHttpError(`No read access to ${path}.`);
      }
    }
  }

  /**
   * Returns the subscriptions of the subscriber as an LWS container.
   */
  private async list(credentials: Credentials, head: boolean): Promise<ResponseDescription> {
    const webId = credentials.agent?.webId;
    if (!webId) {
      throw new UnauthorizedHttpError('Only authenticated agents can list their subscriptions.');
    }
    const items = (await this.storage.getAll())
      .filter((subscription): boolean => subscription.webId === webId)
      .map((subscription): Record<string, unknown> => ({ id: subscription.id, type: [ 'DataResource' ]}));
    const response = this.respond(200, {
      '@context': [ LWS_CONTEXT_URI ],
      id: this.endpoint,
      type: 'Container',
      totalItems: items.length,
      items,
    }, head);
    response.metadata!.add(RDF.terms.type, LWS.terms.Container);
    return response;
  }

  private toJson(subscription: LwsSubscription): Record<string, unknown> {
    return {
      '@context': [ LWS_CONTEXT_URI ],
      type: subscription.type,
      subscription: subscription.id,
      topic: subscription.topic,
      inbox: subscription.inbox,
      ...subscription.expires ? { expires: subscription.expires } : {},
    };
  }

  private respond(statusCode: number, json: Record<string, unknown>, head = false): ResponseDescription {
    const representation = new BasicRepresentation(JSON.stringify(json), APPLICATION_LWS_JSON);
    if (head) {
      representation.data.destroy();
      return new ResponseDescription(statusCode, representation.metadata);
    }
    return new ResponseDescription(statusCode, representation.metadata, representation.data);
  }
}
