import { LWS_ACCESS_PROFILE } from '../../authorization/lws/AccessGrantUtil';
import { joinUrl } from '../../util/PathUtil';
import type { LwsStorageDescriberInput } from './LwsStorageDescriber';
import { LwsStorageDescriber } from './LwsStorageDescriber';

/**
 * Adds the access request and access grant services to an LWS storage description,
 * as described in LWS, §Access Requests and Grants.
 * Both endpoints are containers in the storage and support the LWS Access Profile.
 */
export class AccessServiceDescriber extends LwsStorageDescriber {
  private readonly grantPath: string;
  private readonly requestPath: string;

  /**
   * @param grantPath - Path of the access grant container, relative to the storage. Defaults to `.lws/grants/`.
   * @param requestPath - Path of the access request container, relative to the storage.
   *                      Defaults to `.lws/requests/`.
   */
  public constructor(grantPath = '.lws/grants/', requestPath = '.lws/requests/') {
    super();
    this.grantPath = grantPath;
    this.requestPath = requestPath;
  }

  public async handle({ storage, description }: LwsStorageDescriberInput): Promise<void> {
    description.service.push({
      type: 'AccessRequestService',
      serviceEndpoint: joinUrl(storage.path, this.requestPath),
      conformsTo: [ LWS_ACCESS_PROFILE ],
    }, {
      type: 'AccessGrantService',
      serviceEndpoint: joinUrl(storage.path, this.grantPath),
      conformsTo: [ LWS_ACCESS_PROFILE ],
    });
  }
}
