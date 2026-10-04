import { getLoggerFor } from '../../../logging/LogUtil';
import type { StorageLocationStrategy } from '../../../server/description/StorageLocationStrategy';
import type { LwsNotificationSender } from '../../../server/notifications/lws/LwsNotificationSender';
import { createLwsActivity } from '../../../server/notifications/lws/LwsNotificationSender';
import type { AccessDocument } from '../../../authorization/lws/AccessGrantUtil';
import { validateAccessDocument } from '../../../authorization/lws/AccessGrantUtil';
import { APPLICATION_JSON, APPLICATION_LD_JSON, APPLICATION_LWS_JSON } from '../../../util/ContentTypes';
import { BadRequestHttpError } from '../../../util/errors/BadRequestHttpError';
import { createErrorMessage } from '../../../util/errors/ErrorUtil';
import { MethodNotAllowedHttpError } from '../../../util/errors/MethodNotAllowedHttpError';
import { UnsupportedMediaTypeHttpError } from '../../../util/errors/UnsupportedMediaTypeHttpError';
import { joinUrl } from '../../../util/PathUtil';
import { readableToString } from '../../../util/StreamUtil';
import { SOLID_HTTP } from '../../../util/Vocabularies';
import type { ResponseDescription } from '../../output/response/ResponseDescription';
import { BasicRepresentation } from '../../representation/BasicRepresentation';
import type { ResourceIdentifier } from '../../representation/ResourceIdentifier';
import type { OperationHandlerInput } from '../OperationHandler';
import { OperationHandler } from '../OperationHandler';

const JSON_TYPES = new Set([ APPLICATION_LWS_JSON, APPLICATION_JSON, APPLICATION_LD_JSON ]);

type AccessDocumentType = 'AccessGrant' | 'AccessRequest';

interface AccessContainerMatch {
  storage: ResourceIdentifier;
  container: string;
  type: AccessDocumentType;
  isMember: boolean;
}

export interface AccessDocumentOperationHandlerArgs {
  /**
   * The handler that performs the operations.
   */
  source: OperationHandler;
  /**
   * Determines the storage of the target resource.
   */
  storageStrategy: StorageLocationStrategy;
  /**
   * Path of the access grant container, relative to the storage. Defaults to `.lws/grants/`.
   */
  grantPath?: string;
  /**
   * Path of the access request container, relative to the storage. Defaults to `.lws/requests/`.
   */
  requestPath?: string;
  /**
   * Path of the container that contains both access containers, relative to the storage.
   * Access grants can not target resources in this container. Defaults to `.lws/`.
   */
  reservedPath?: string;
  /**
   * Used to notify the inbox of a new access grant.
   */
  sender?: LwsNotificationSender;
}

/**
 * Implements the access grant and access request endpoints of LWS, §Access Requests and Grants,
 * which are LWS containers in the storage.
 *
 * Validates the access grants and access requests that are posted to those containers,
 * and makes sure they can not be modified afterwards:
 * the containers only support GET, HEAD, and POST, and their members only support GET, HEAD, and DELETE.
 * Deleting an access grant revokes it.
 *
 * When an access grant with an `inbox` is created, a notification is sent to that inbox.
 */
export class AccessDocumentOperationHandler extends OperationHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly source: OperationHandler;
  private readonly storageStrategy: StorageLocationStrategy;
  private readonly grantPath: string;
  private readonly requestPath: string;
  private readonly reservedPath: string;
  private readonly sender?: LwsNotificationSender;

  public constructor(args: AccessDocumentOperationHandlerArgs) {
    super();
    this.source = args.source;
    this.storageStrategy = args.storageStrategy;
    this.grantPath = args.grantPath ?? '.lws/grants/';
    this.requestPath = args.requestPath ?? '.lws/requests/';
    this.reservedPath = args.reservedPath ?? '.lws/';
    this.sender = args.sender;
  }

  public async canHandle(input: OperationHandlerInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    const { operation } = input;
    const match = await this.match(operation.target);
    if (!match) {
      return this.source.handle(input);
    }

    const allowed = match.isMember ? [ 'GET', 'HEAD', 'DELETE' ] : [ 'GET', 'HEAD', 'POST' ];
    if (!allowed.includes(operation.method)) {
      const message = `${operation.method} is not allowed on ${match.type} resources.`;
      throw new MethodNotAllowedHttpError([ operation.method ], message);
    }
    if (operation.method !== 'POST') {
      return this.source.handle(input);
    }

    const contentType = operation.body.metadata.contentType;
    if (!contentType || !JSON_TYPES.has(contentType)) {
      throw new UnsupportedMediaTypeHttpError(`${match.type} resources need to be ${APPLICATION_LWS_JSON}.`);
    }
    const text = await readableToString(operation.body.data);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BadRequestHttpError('Invalid JSON.');
    }
    const document = validateAccessDocument(json, match.type, match.storage.path);
    this.validateTargets(document, match.storage);
    operation.body = new BasicRepresentation(text, operation.body.metadata);

    const result = await this.source.handle(input);
    const location = result.metadata?.get(SOLID_HTTP.terms.location)?.value;
    if (match.type === 'AccessGrant' && document.inbox && location && this.sender) {
      this.notify(document.inbox, match, location);
    }
    return result;
  }

  /**
   * Determines whether the target is an access container or one of its members.
   */
  private async match(target: ResourceIdentifier): Promise<AccessContainerMatch | undefined> {
    let storage: ResourceIdentifier;
    try {
      storage = await this.storageStrategy.getStorageIdentifier(target);
    } catch {
      return;
    }
    for (const [ path, type ] of [[ this.grantPath, 'AccessGrant' ], [ this.requestPath, 'AccessRequest' ]] as const) {
      const container = joinUrl(storage.path, path);
      if (target.path === container) {
        return { storage, container, type, isMember: false };
      }
      if (target.path.startsWith(container) && !target.path.slice(container.length).includes('/')) {
        return { storage, container, type, isMember: true };
      }
    }
  }

  /**
   * Prevents access documents from granting access to the access containers themselves.
   */
  private validateTargets(document: AccessDocument, storage: ResourceIdentifier): void {
    const reserved = joinUrl(storage.path, this.reservedPath);
    for (const policy of document.access) {
      for (const target of policy.target?.value ?? []) {
        if (target.startsWith(reserved)) {
          throw new BadRequestHttpError(`Access can not be granted to ${target}.`);
        }
      }
    }
  }

  private notify(inbox: string, match: AccessContainerMatch, location: string): void {
    const activity = createLwsActivity('Create', location, [ match.type ], { target: match.container });
    this.sender!.handleSafe({ inbox, storage: match.storage.path, activity }).catch((error: unknown): void => {
      this.logger.warn(`Unable to notify ${inbox} of access grant ${location}: ${createErrorMessage(error)}`);
    });
  }
}
