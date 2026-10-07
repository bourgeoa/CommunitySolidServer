import { didWebDocumentUrl } from '../../../src/util/DidWebUtil';
import { BadRequestHttpError } from '../../../src/util/errors/BadRequestHttpError';

describe('DidWebUtil', (): void => {
  describe('#didWebDocumentUrl', (): void => {
    it('resolves a domain to its well-known DID document.', async(): Promise<void> => {
      expect(didWebDocumentUrl('did:web:alice.example')).toBe('https://alice.example/.well-known/did.json');
    });

    it('resolves path segments to a DID document in that folder.', async(): Promise<void> => {
      expect(didWebDocumentUrl('did:web:alice.example:user:alice')).toBe('https://alice.example/user/alice/did.json');
    });

    it('resolves percent-encoded ports and path segments.', async(): Promise<void> => {
      expect(didWebDocumentUrl('did:web:alice.example%3A3000')).toBe('https://alice.example:3000/.well-known/did.json');
      expect(didWebDocumentUrl('did:web:alice.example%3A3000:user:alice'))
        .toBe('https://alice.example:3000/user/alice/did.json');
    });

    it('rejects identifiers that are not a did:web identifier.', async(): Promise<void> => {
      for (const did of [ 'did:key:z123', 'did:web:', 'did:web:alice.example:', 'https://alice.example/' ]) {
        expect((): string => didWebDocumentUrl(did)).toThrow(BadRequestHttpError);
      }
    });

    it('rejects identifiers with a fragment or query.', async(): Promise<void> => {
      for (const did of [ 'did:web:alice.example#key-1', 'did:web:alice.example?service=agent' ]) {
        expect((): string => didWebDocumentUrl(did)).toThrow(BadRequestHttpError);
      }
    });

    it('rejects hosts and path segments that would change the URL.', async(): Promise<void> => {
      const dids = [
        'did:web:alice.example%2Fevil',
        'did:web:alice.example%40evil.example',
        'did:web:alice.example:..%2F..',
      ];
      for (const did of dids) {
        expect((): string => didWebDocumentUrl(did)).toThrow(BadRequestHttpError);
      }
    });

    it('rejects malformed percent-encoding.', async(): Promise<void> => {
      expect((): string => didWebDocumentUrl('did:web:alice.example%')).toThrow(BadRequestHttpError);
    });
  });
});
