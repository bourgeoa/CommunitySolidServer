import arrayifyStream from 'arrayify-stream';
import type { Quad } from '@rdfjs/types';
import type { WebIdStore } from '../identity/interaction/webid/util/WebIdStore';
import type { Representation } from '../http/representation/Representation';
import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import { INTERNAL_QUADS, TEXT_TURTLE } from '../util/ContentTypes';
import { BadRequestHttpError } from '../util/errors/BadRequestHttpError';
import { createErrorMessage } from '../util/errors/ErrorUtil';
import { ForbiddenHttpError } from '../util/errors/ForbiddenHttpError';
import { trimTrailingSlashes } from '../util/PathUtil';
import { parseQuads } from '../util/QuadUtil';
import { cloneRepresentation } from '../util/ResourceUtil';
import { SOLID } from '../util/Vocabularies';
import type { Conditions } from './conditions/Conditions';
import { PassthroughStore } from './PassthroughStore';
import type { ChangeMap, ResourceStore } from './ResourceStore';

/**
 * Guards the WebID profile card of registered WebIDs.
 *
 * Any write (PUT, POST or the result of a PATCH) to a card that is registered
 * to an account on this server has to be valid Turtle that still contains
 * the `solid:oidcIssuer` triple pointing to this server. The card itself can
 * also no longer be deleted while its WebID is still registered.
 */
export class ProfileCardGuard extends PassthroughStore {
  private readonly webIdStore: WebIdStore;
  private readonly baseUrl: string;
  private readonly fragment: string;

  public constructor(
    source: ResourceStore,
    webIdStore: WebIdStore,
    baseUrl: string,
    fragment = 'me',
  ) {
    super(source);
    this.webIdStore = webIdStore;
    this.baseUrl = trimTrailingSlashes(baseUrl);
    this.fragment = fragment;
  }

  public async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    await this.validateCard(identifier, representation);
    return this.source.setRepresentation(identifier, representation, conditions);
  }

  public async addResource(
    container: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const identifier = representation.metadata.identifier?.value ?? container.path;
    await this.validateCard({ path: identifier }, representation);
    return this.source.addResource(container, representation, conditions);
  }

  public async deleteResource(identifier: ResourceIdentifier, conditions?: Conditions): Promise<ChangeMap> {
    if (await this.isProtectedCard(identifier)) {
      throw new ForbiddenHttpError(
        `The profile card ${identifier.path} cannot be deleted while its WebID is registered to an account.`,
      );
    }
    return this.source.deleteResource(identifier, conditions);
  }

  /**
   * Returns the WebID of the given document if it is a profile card.
   */
  protected getCardWebId(identifier: ResourceIdentifier): string | undefined {
    let { path } = identifier;
    if (path.endsWith('.ttl')) {
      path = path.slice(0, -4);
    }
    if (!path.endsWith('/profile/card')) {
      return undefined;
    }
    return `${path}#${this.fragment}`;
  }

  /**
   * Whether the identifier is the profile card of a WebID registered on this server.
   */
  protected async isProtectedCard(identifier: ResourceIdentifier): Promise<boolean> {
    const webId = this.getCardWebId(identifier);
    return typeof webId === 'string' && this.webIdStore.hasWebId(webId);
  }

  /**
   * Ensures that a write to a protected card results in valid Turtle that
   * contains the `solid:oidcIssuer` triple for its WebID.
   */
  protected async validateCard(identifier: ResourceIdentifier, representation: Representation): Promise<void> {
    const webId = this.getCardWebId(identifier);
    if (typeof webId !== 'string' || !await this.webIdStore.hasWebId(webId)) {
      return;
    }

    const copy = await cloneRepresentation(representation);
    let quads: Quad[];
    if (copy.metadata.contentType === INTERNAL_QUADS) {
      quads = await arrayifyStream<Quad>(copy.data);
    } else {
      if (copy.metadata.contentType !== TEXT_TURTLE) {
        representation.data.destroy();
        throw new BadRequestHttpError(
          `Invalid profile card ${identifier.path}: the card needs to be sent as Turtle (text/turtle).`,
        );
      }
      try {
        quads = await parseQuads(copy.data, { format: 'text/turtle' });
      } catch (error: unknown) {
        representation.data.destroy();
        const message = `Invalid data for ${identifier.path}: not valid Turtle. ${createErrorMessage(error)}`;
        throw new BadRequestHttpError(message, { cause: error });
      }
    }

    const valid = quads.some(({ subject, predicate, object }): boolean =>
      subject.value === webId &&
      predicate.value === SOLID.terms.oidcIssuer.value &&
      object.termType === 'NamedNode' &&
      trimTrailingSlashes(object.value) === this.baseUrl);

    if (!valid) {
      representation.data.destroy();
      const expected = `<${webId}> solid:oidcIssuer <${this.baseUrl}>`;
      throw new BadRequestHttpError(`Invalid profile card ${identifier.path}: missing the ${expected} triple.`);
    }
  }
}
