import type { RepresentationMetadata } from '../../representation/RepresentationMetadata';
import { ResponseDescription } from './ResponseDescription';

/**
 * Corresponds to a 204 response.
 */
export class NoContentResponseDescription extends ResponseDescription {
  public constructor(metadata?: RepresentationMetadata) {
    super(204, metadata);
  }
}
