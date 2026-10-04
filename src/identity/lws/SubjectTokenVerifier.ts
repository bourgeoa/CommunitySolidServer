import { AsyncHandler } from '../../util/handlers/AsyncHandler';

/**
 * Token type URI of a JSON Web Token, used for self-issued `did:key` credentials.
 */
export const TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt';
/**
 * Token type URI of an OpenID Connect ID token.
 */
export const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
/**
 * Alternative spelling of the ID token type URI, as used in an example of the LWS authorization server metadata.
 */
export const TOKEN_TYPE_ID_TOKEN_ALT = 'urn:ietf:params:oauth:token-type:id-token';
/**
 * Token type URI of an OAuth 2.0 access token.
 */
export const TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

export interface SubjectTokenVerifierInput {
  /**
   * The serialized subject token.
   */
  token: string;
  /**
   * The token type URI provided by the client.
   */
  tokenType: string;
  /**
   * The identifier of the authorization server that verifies the token.
   * If the token has an audience restriction, it needs to include this value.
   */
  audience: string;
}

/**
 * The verified claims of an LWS authentication credential.
 */
export interface VerifiedSubject {
  /**
   * The LWS subject identifier: the URI of the agent.
   */
  subject: string;
  /**
   * The LWS issuer identifier.
   */
  issuer: string;
  /**
   * The LWS client identifier.
   */
  client: string;
}

/**
 * Validates an LWS authentication credential, as presented to an authorization server in a token exchange request.
 * Each authentication suite has its own implementation.
 *
 * Implementations throw a `NotImplementedHttpError` in `canHandle` if they do not support the token type,
 * and a `BadRequestHttpError` in `handle` if the credential is not valid.
 */
export abstract class SubjectTokenVerifier extends AsyncHandler<SubjectTokenVerifierInput, VerifiedSubject> {}
