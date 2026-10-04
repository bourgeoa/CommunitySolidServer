import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { Patch } from '../../../../src/http/representation/Patch';
import type { Representation } from '../../../../src/http/representation/Representation';
import { isJsonMediaType, JsonMergePatcher, readJsonMergePatch } from '../../../../src/storage/patch/JsonMergePatcher';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { readableToString } from '../../../../src/util/StreamUtil';

function getPatch(body: string, contentType = 'application/merge-patch+json'): Patch {
  return new BasicRepresentation(body, contentType);
}

describe('A JsonMergePatcher', (): void => {
  const identifier = { path: 'http://test.com/foo' };
  let patch: Patch;
  let representation: Representation;
  let patcher: JsonMergePatcher;

  beforeEach(async(): Promise<void> => {
    patch = getPatch('{ "a": null, "b": { "c": 2 } }');
    representation = new BasicRepresentation('{ "a": 1, "b": { "d": 3 } }', identifier, 'application/json');
    patcher = new JsonMergePatcher();
  });

  describe('#readJsonMergePatch', (): void => {
    it('parses the patch body.', async(): Promise<void> => {
      await expect(readJsonMergePatch(patch)).resolves.toEqual({ a: null, b: { c: 2 }});
    });

    it('throws a 400 error on invalid JSON.', async(): Promise<void> => {
      await expect(readJsonMergePatch(getPatch('{'))).rejects.toThrow(BadRequestHttpError);
      await expect(readJsonMergePatch(getPatch('{'))).rejects.toThrow('Invalid JSON Merge Patch document.');
    });
  });

  describe('#isJsonMediaType', (): void => {
    it('accepts JSON media types.', async(): Promise<void> => {
      expect(isJsonMediaType('application/json')).toBe(true);
      expect(isJsonMediaType('application/ld+json')).toBe(true);
      expect(isJsonMediaType('text/turtle')).toBe(false);
      expect(isJsonMediaType('application/json+ld')).toBe(false);
      expect(isJsonMediaType()).toBe(false);
    });
  });

  describe('canHandle', (): void => {
    it('accepts JSON Merge Patch documents on JSON resources.', async(): Promise<void> => {
      await expect(patcher.canHandle({ identifier, patch, representation })).resolves.toBeUndefined();
      representation.metadata.contentType = 'application/lws+json';
      await expect(patcher.canHandle({ identifier, patch, representation })).resolves.toBeUndefined();
    });

    it('accepts JSON Merge Patch documents on non-existing resources.', async(): Promise<void> => {
      await expect(patcher.canHandle({ identifier, patch })).resolves.toBeUndefined();
    });

    it('rejects other patch types.', async(): Promise<void> => {
      patch = getPatch('{}', 'application/sparql-update');
      await expect(patcher.canHandle({ identifier, patch, representation }))
        .rejects.toThrow('Only JSON Merge Patch documents are supported.');
    });

    it('rejects non-JSON resources.', async(): Promise<void> => {
      representation.metadata.contentType = 'text/turtle';
      await expect(patcher.canHandle({ identifier, patch, representation }))
        .rejects.toThrow(NotImplementedHttpError);
      await expect(patcher.canHandle({ identifier, patch, representation }))
        .rejects.toThrow('JSON Merge Patch can only be applied to JSON resources.');
    });
  });

  describe('handle', (): void => {
    it('applies the patch to the resource.', async(): Promise<void> => {
      const result = await patcher.handle({ identifier, patch, representation });
      expect(result.metadata).toBe(representation.metadata);
      expect(JSON.parse(await readableToString(result.data))).toEqual({ b: { c: 2, d: 3 }});
    });

    it('creates a JSON resource if there is none.', async(): Promise<void> => {
      const result = await patcher.handle({ identifier, patch });
      expect(result.metadata.contentType).toBe('application/json');
      expect(result.metadata.identifier.value).toBe(identifier.path);
      expect(JSON.parse(await readableToString(result.data))).toEqual({ b: { c: 2 }});
    });

    it('treats an empty resource as a non-existing target.', async(): Promise<void> => {
      representation = new BasicRepresentation('', identifier, 'application/json');
      patch = getPatch('"value"');
      const result = await patcher.handle({ identifier, patch, representation });
      await expect(readableToString(result.data)).resolves.toBe('"value"');
    });

    it('throws a 400 error if the resource does not contain valid JSON.', async(): Promise<void> => {
      representation = new BasicRepresentation('{', identifier, 'application/json');
      await expect(patcher.handle({ identifier, patch, representation }))
        .rejects.toThrow('The target resource does not contain valid JSON.');
    });

    it('throws a 400 error if the patch is not valid JSON.', async(): Promise<void> => {
      patch = getPatch('{');
      await expect(patcher.handle({ identifier, patch, representation }))
        .rejects.toThrow('Invalid JSON Merge Patch document.');
    });
  });
});
