import type { JWK } from 'jose';

/**
 * Removes the fragment of a subject identifier, so only the controlled identifier document remains.
 * Keys are registered for a document, not for a specific subject in it.
 *
 * @param webId - Subject identifier, with or without fragment.
 */
export function toDocumentId(webId: string): string {
  return webId.replace(/#.*$/u, '');
}

/**
 * A public key of an agent that is registered with this server as a verification method of its controlled identifier.
 *
 * Registering keys replaces dereferencing the controlled identifier document of the subject:
 * LWS requires a trust relationship between the verifier and the issuer of a credential,
 * which MAY be established through an out-of-band mechanism,
 * and neither LWS nor CID requires the document to be publicly readable.
 */
export interface IdentityKey {
  /**
   * Identifier of this key in the store.
   */
  id: string;
  /**
   * Identifier of the agent the key belongs to, without fragment.
   */
  webId: string;
  /**
   * Identifier of the account that registered the key.
   */
  accountId: string;
  /**
   * Identifier of the verification method, which is the value that has to be used as the `kid` of a credential.
   */
  keyId: string;
  /**
   * Human-readable label of the key.
   */
  label: string;
  /**
   * The public key.
   */
  jwk: JWK;
}

/**
 * Stores the identity keys of agents, which are used by the server to authenticate them
 * without dereferencing their controlled identifier document.
 */
export interface IdentityKeyStore {
  /**
   * Finds the key with the given identifier.
   *
   * @param id - Identifier of the key in the store.
   */
  get: (id: string) => Promise<IdentityKey | undefined>;

  /**
   * Finds all keys registered for the agent of the given controlled identifier.
   *
   * @param webId - Identifier of the agent, with or without fragment.
   */
  findByWebId: (webId: string) => Promise<IdentityKey[]>;

  /**
   * Finds all keys registered by the given account.
   *
   * @param accountId - Identifier of the account.
   */
  findByAccount: (accountId: string) => Promise<IdentityKey[]>;

  /**
   * Finds the registered key of the agent that matches the given verification method identifier.
   * Besides the identifier that was created when registering the key,
   * the JWK thumbprint of a registered key is also accepted as an identifier.
   *
   * @param webId - Identifier of the agent, with or without fragment.
   * @param keyId - Identifier of the verification method.
   */
  findKey: (webId: string, keyId: string) => Promise<IdentityKey | undefined>;

  /**
   * Registers a key for the agent of the given controlled identifier.
   * Registering a key with the label of an existing key replaces that key, which allows rotating keys.
   *
   * @param webId - Identifier of the agent, with or without fragment.
   * @param accountId - Identifier of the account that registers the key.
   * @param jwk - The public key.
   * @param label - Human-readable label of the key. A random label is generated if none is provided.
   */
  create: (webId: string, accountId: string, jwk: JWK, label?: string) => Promise<IdentityKey>;

  /**
   * Deletes the key with the given identifier.
   *
   * @param id - Identifier of the key in the store.
   */
  delete: (id: string) => Promise<void>;

  /**
   * Deletes all keys registered for the agent of the given controlled identifier.
   *
   * @param webId - Identifier of the agent, with or without fragment.
   */
  deleteByWebId: (webId: string) => Promise<void>;
}
