import { randomUUID } from 'node:crypto';
import type { JWK } from 'jose';
import { calculateJwkThumbprint } from 'jose';
import { Initializer } from '../../init/Initializer';
import { getLoggerFor } from '../../logging/LogUtil';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { InternalServerError } from '../../util/errors/InternalServerError';
import { sanitizeUrlPart } from '../../util/StringUtil';
import type { AccountLoginStorage } from '../interaction/account/util/LoginStorage';
import { ACCOUNT_TYPE } from '../interaction/account/util/LoginStorage';
import type { IdentityKey, IdentityKeyStore } from './IdentityKeyStore';
import { toDocumentId } from './IdentityKeyStore';

export const IDENTITY_KEY_STORAGE_TYPE = 'identityKey';
export const IDENTITY_KEY_STORAGE_DESCRIPTION = {
  webId: 'string',
  accountId: `id:${ACCOUNT_TYPE}`,
  keyId: 'string',
  jwk: 'string',
  label: 'string',
} as const;

/**
 * A {@link IdentityKeyStore} that uses a {@link AccountLoginStorage} for storing the keys.
 * Needs to be initialized before it can be used.
 */
export class BaseIdentityKeyStore extends Initializer implements IdentityKeyStore {
  private readonly logger = getLoggerFor(this);

  private readonly storage: AccountLoginStorage<{ [IDENTITY_KEY_STORAGE_TYPE]:
      typeof IDENTITY_KEY_STORAGE_DESCRIPTION; }>;

  private initialized = false;

  // Wrong typings to prevent Components.js typing issues
  public constructor(storage: AccountLoginStorage<Record<string, never>>) {
    super();
    this.storage = storage as unknown as typeof this.storage;
  }

  // Initialize the type definitions
  public async handle(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      await this.storage.defineType(IDENTITY_KEY_STORAGE_TYPE, IDENTITY_KEY_STORAGE_DESCRIPTION, false);
      await this.storage.createIndex(IDENTITY_KEY_STORAGE_TYPE, 'webId');
      this.initialized = true;
    } catch (cause: unknown) {
      throw new InternalServerError(
        `Error defining identity keys in storage: ${createErrorMessage(cause)}`,
        { cause },
      );
    }
  }

  public async get(id: string): Promise<IdentityKey | undefined> {
    const record = await this.storage.get(IDENTITY_KEY_STORAGE_TYPE, id);
    return record === undefined ? undefined : this.toIdentityKey(record);
  }

  public async findByWebId(webId: string): Promise<IdentityKey[]> {
    const records = await this.storage.find(IDENTITY_KEY_STORAGE_TYPE, { webId: toDocumentId(webId) });
    return records.map((record): IdentityKey => this.toIdentityKey(record));
  }

  public async findByAccount(accountId: string): Promise<IdentityKey[]> {
    const records = await this.storage.find(IDENTITY_KEY_STORAGE_TYPE, { accountId });
    return records.map((record): IdentityKey => this.toIdentityKey(record));
  }

  public async findKey(webId: string, keyId: string): Promise<IdentityKey | undefined> {
    const keys = await this.findByWebId(webId);

    const match = keys.find((key): boolean => key.keyId === keyId);
    if (match) {
      return match;
    }

    // The thumbprint of a registered key is also accepted as an identifier,
    // which allows clients to use the same identifier that is used for the keys of this server.
    // The identifier can be the thumbprint itself or a fragment of the document containing it.
    const fragment = keyId.slice(keyId.indexOf('#') + 1);
    for (const key of keys) {
      const thumbprint = await calculateJwkThumbprint(key.jwk);
      if (thumbprint === keyId || thumbprint === fragment) {
        return key;
      }
    }
  }

  public async create(webId: string, accountId: string, jwk: JWK, label?: string): Promise<IdentityKey> {
    const documentId = toDocumentId(webId);
    const cleaned = label === undefined ? '' : sanitizeUrlPart(label);
    const keyId = `${documentId}#${cleaned || randomUUID()}`;

    this.logger.debug(`Registering identity key ${keyId} for ${documentId} with account ${accountId}`);

    // Registering a key with the identifier of an existing key replaces it, which allows rotating keys
    for (const existing of await this.findByWebId(documentId)) {
      if (existing.keyId === keyId) {
        await this.delete(existing.id);
      }
    }

    const record = await this.storage.create(IDENTITY_KEY_STORAGE_TYPE, {
      webId: documentId,
      accountId,
      keyId,
      label: cleaned || keyId.slice(keyId.indexOf('#') + 1),
      jwk: JSON.stringify(jwk),
    });
    return this.toIdentityKey(record);
  }

  public async delete(id: string): Promise<void> {
    this.logger.debug(`Deleting identity key ${id}`);
    await this.storage.delete(IDENTITY_KEY_STORAGE_TYPE, id);
  }

  public async deleteByWebId(webId: string): Promise<void> {
    for (const key of await this.findByWebId(webId)) {
      await this.delete(key.id);
    }
  }

  private toIdentityKey(
    record: { id: string; webId: string; accountId: string; keyId: string; jwk: string; label: string },
  ): IdentityKey {
    return {
      id: record.id,
      webId: record.webId,
      accountId: record.accountId,
      keyId: record.keyId,
      label: record.label,
      jwk: JSON.parse(record.jwk) as JWK,
    };
  }
}
