import type { Quad } from '@rdfjs/types';
import arrayifyStream from 'arrayify-stream';
import type { AuxiliaryIdentifierStrategy } from '../../http/auxiliary/AuxiliaryIdentifierStrategy';
import { BasicRepresentation } from '../../http/representation/BasicRepresentation';
import type { Representation } from '../../http/representation/Representation';
import { getLoggerFor } from '../../logging/LogUtil';
import { APPLICATION_MERGE_PATCH_JSON, INTERNAL_QUADS } from '../../util/ContentTypes';
import { ConflictHttpError } from '../../util/errors/ConflictHttpError';
import { InternalServerError } from '../../util/errors/InternalServerError';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import { applyJsonMergePatch } from '../../util/JsonMergePatch';
import { linksetToLinks, linksToLinkset } from '../../util/LinksetUtil';
import type { LinksetMapper } from '../conversion/LinksetMapper';
import { readJsonMergePatch } from './JsonMergePatcher';
import type { RepresentationPatcherInput } from './RepresentationPatcher';
import { RepresentationPatcher } from './RepresentationPatcher';

/**
 * Applies JSON Merge Patch documents to LWS linkset resources.
 *
 * LWS, §Metadata: "Servers MUST support PATCH using `application/merge-patch+json`."
 *
 * The patch is applied to the linkset document as it is presented to clients,
 * after which the resulting links are converted back to RDF metadata.
 * Server-managed links, such as `up` and `type`, can not be modified and changes to them are ignored.
 * Links with an anchor other than the described resource are rejected.
 */
export class LinksetMergePatcher extends RepresentationPatcher<Representation> {
  protected readonly logger = getLoggerFor(this);

  private readonly metadataStrategy: AuxiliaryIdentifierStrategy;
  private readonly mapper: LinksetMapper;

  public constructor(metadataStrategy: AuxiliaryIdentifierStrategy, mapper: LinksetMapper) {
    super();
    this.metadataStrategy = metadataStrategy;
    this.mapper = mapper;
  }

  public async canHandle({ identifier, patch }: RepresentationPatcherInput<Representation>): Promise<void> {
    if (patch.metadata.contentType !== APPLICATION_MERGE_PATCH_JSON) {
      throw new NotImplementedHttpError('Only JSON Merge Patch documents are supported.');
    }
    if (!this.metadataStrategy.isAuxiliaryIdentifier(identifier)) {
      throw new NotImplementedHttpError('Only linkset resources are supported.');
    }
  }

  public async handle({ identifier, patch, representation }: RepresentationPatcherInput<Representation>):
  Promise<Representation> {
    if (!representation) {
      throw new ConflictHttpError('Linkset resources can not be created directly.');
    }
    if (representation.metadata.contentType !== INTERNAL_QUADS) {
      throw new InternalServerError('Quad stream was expected for patching a linkset.');
    }

    const patchDocument = await readJsonMergePatch(patch);
    const subject = this.mapper.getSubject(identifier).path;
    const original = await arrayifyStream<Quad>(representation.data);

    const current = linksToLinkset(await this.mapper.toLinks(identifier, original), subject);
    const patched = applyJsonMergePatch(current, patchDocument);
    const links = linksetToLinks(patched, identifier.path, subject);

    const foreign = links.find((link): boolean => link.anchor !== subject);
    if (foreign) {
      throw new ConflictHttpError(`This linkset can only contain links with anchor ${subject}.`);
    }

    this.logger.debug(`Applying JSON Merge Patch to linkset ${identifier.path}`);
    const quads = this.mapper.toQuads(identifier, links, original);
    return new BasicRepresentation(quads, representation.metadata, INTERNAL_QUADS);
  }
}
