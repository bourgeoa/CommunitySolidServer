import type { KeyObject } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { decodeBase58, parseDidKey } from '../../../src/util/DidKeyUtil';
import { BadRequestHttpError } from '../../../src/util/errors/BadRequestHttpError';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value * 256n) + BigInt(byte);
  }
  let result = '';
  while (value > 0n) {
    result = BASE58_ALPHABET[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; ++i) {
    result = `1${result}`;
  }
  return result;
}

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url');
  if (jwk.kty === 'OKP') {
    return x;
  }
  const y = Buffer.from(jwk.y!, 'base64url');

  return Buffer.concat([ Buffer.from([ (y.at(-1)! & 1) === 1 ? 3 : 2 ]), x ]);
}

function toDidKey(prefix: number[], raw: Uint8Array): string {
  return `did:key:z${encodeBase58(Uint8Array.from([ ...prefix, ...raw ]))}`;
}

describe('DidKeyUtil', (): void => {
  describe('#decodeBase58', (): void => {
    it('decodes base58 strings.', async(): Promise<void> => {
      expect(decodeBase58('')).toEqual(new Uint8Array());
      expect(decodeBase58('2g')).toEqual(Uint8Array.from([ 0x61 ]));
      expect(decodeBase58('9Vc')).toEqual(Uint8Array.from([ 0x6F, 0x9B ]));
    });

    it('preserves leading zero bytes.', async(): Promise<void> => {
      expect(decodeBase58('112g')).toEqual(Uint8Array.from([ 0, 0, 0x61 ]));
    });

    it('errors on invalid characters.', async(): Promise<void> => {
      expect((): unknown => decodeBase58('0OIl')).toThrow(BadRequestHttpError);
      expect((): unknown => decodeBase58('0OIl')).toThrow('Invalid base58 character 0.');
    });
  });

  describe('#parseDidKey', (): void => {
    it('parses P-256 keys.', async(): Promise<void> => {
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const result = parseDidKey(toDidKey([ 0x80, 0x24 ], rawPublicKey(publicKey)));
      expect(result.algorithms).toEqual([ 'ES256' ]);
      expect(result.key.export({ format: 'jwk' })).toEqual(publicKey.export({ format: 'jwk' }));
    });

    it('parses P-384 keys.', async(): Promise<void> => {
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
      const result = parseDidKey(toDidKey([ 0x81, 0x24 ], rawPublicKey(publicKey)));
      expect(result.algorithms).toEqual([ 'ES384' ]);
      expect(result.key.export({ format: 'jwk' })).toEqual(publicKey.export({ format: 'jwk' }));
    });

    it('parses Ed25519 keys, ignoring the fragment.', async(): Promise<void> => {
      const { publicKey } = generateKeyPairSync('ed25519');
      const did = toDidKey([ 0xED, 0x01 ], rawPublicKey(publicKey));
      const result = parseDidKey(`${did}#${did.slice(8)}`);
      expect(result.algorithms).toEqual([ 'EdDSA' ]);
      expect(result.key.export({ format: 'jwk' })).toEqual(publicKey.export({ format: 'jwk' }));
    });

    it('errors on identifiers that are not base58btc did:key identifiers.', async(): Promise<void> => {
      expect((): unknown => parseDidKey('did:web:example.com')).toThrow(BadRequestHttpError);
      expect((): unknown => parseDidKey('did:key:mABC'))
        .toThrow('did:key:mABC is not a base58btc encoded did:key identifier.');
    });

    it('errors on unsupported key types.', async(): Promise<void> => {
      const did = toDidKey([ 0xE7, 0x01 ], new Uint8Array(33).fill(2));
      expect((): unknown => parseDidKey(did)).toThrow(`${did} uses an unsupported key type.`);
    });

    it('errors on invalid keys.', async(): Promise<void> => {
      const did = toDidKey([ 0x80, 0x24 ], new Uint8Array(5).fill(7));
      expect((): unknown => parseDidKey(did)).toThrow(`${did} does not contain a valid public key.`);
    });
  });
});
