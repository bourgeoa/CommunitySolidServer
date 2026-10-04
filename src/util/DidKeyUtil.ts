import type { KeyObject } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { BadRequestHttpError } from './errors/BadRequestHttpError';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * A public key extracted from a `did:key` identifier.
 */
export interface DidKey {
  /**
   * The public key.
   */
  key: KeyObject;
  /**
   * The JWS algorithms that can be used with this key.
   */
  algorithms: string[];
}

/**
 * Supported multicodec key types, identified by their varint-encoded prefix,
 * with the DER prefix that turns the raw key into a SubjectPublicKeyInfo structure.
 */
const KEY_TYPES: { prefix: number[]; spki: string; algorithms: string[] }[] = [
  // P-256 public key (compressed point)
  { prefix: [ 0x80, 0x24 ], spki: '3039301306072a8648ce3d020106082a8648ce3d030107032200', algorithms: [ 'ES256' ]},
  // P-384 public key (compressed point)
  { prefix: [ 0x81, 0x24 ], spki: '3046301006072a8648ce3d020106052b81040022033200', algorithms: [ 'ES384' ]},
  // Ed25519 public key
  { prefix: [ 0xED, 0x01 ], spki: '302a300506032b6570032100', algorithms: [ 'EdDSA' ]},
];

/**
 * Decodes a base58btc (Bitcoin alphabet) encoded string.
 */
export function decodeBase58(input: string): Uint8Array {
  let value = 0n;
  for (const char of input) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) {
      throw new BadRequestHttpError(`Invalid base58 character ${char}.`);
    }
    value = (value * 58n) + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xFFn));
    value >>= 8n;
  }
  // Leading '1' characters represent leading zero bytes
  for (let i = 0; i < input.length && input[i] === '1'; ++i) {
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * Extracts the public key from a `did:key` identifier, as described in Section 3.1.3 of "The did:key Method".
 * Supports P-256, P-384, and Ed25519 keys.
 * Throws a 400 error if the identifier is not a valid or supported `did:key` identifier.
 */
export function parseDidKey(did: string): DidKey {
  const match = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)(?:#.*)?$/u.exec(did);
  if (!match) {
    throw new BadRequestHttpError(`${did} is not a base58btc encoded did:key identifier.`);
  }
  const bytes = decodeBase58(match[1]);
  for (const { prefix, spki, algorithms } of KEY_TYPES) {
    if (prefix.every((byte, idx): boolean => bytes[idx] === byte)) {
      const der = Buffer.concat([ Buffer.from(spki, 'hex'), Buffer.from(bytes.slice(prefix.length)) ]);
      try {
        return { key: createPublicKey({ key: der, format: 'der', type: 'spki' }), algorithms };
      } catch (error: unknown) {
        throw new BadRequestHttpError(`${did} does not contain a valid public key.`, { cause: error });
      }
    }
  }
  throw new BadRequestHttpError(`${did} uses an unsupported key type.`);
}
