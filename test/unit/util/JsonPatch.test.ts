import { BadRequestHttpError } from '../../../src/util/errors/BadRequestHttpError';
import { ConflictHttpError } from '../../../src/util/errors/ConflictHttpError';
import {
  applyJsonPatch,
  applyJsonPatchDocument,
  jsonEquals,
  parseJsonPointer,
} from '../../../src/util/JsonPatch';

describe('JsonPatch', (): void => {
  describe('#parseJsonPointer', (): void => {
    it('parses JSON Pointers.', async(): Promise<void> => {
      expect(parseJsonPointer('')).toEqual([]);
      expect(parseJsonPointer('/')).toEqual([ '' ]);
      expect(parseJsonPointer('/a~1b/m~0n/0')).toEqual([ 'a/b', 'm~n', '0' ]);
      expect(parseJsonPointer('/~01')).toEqual([ '~1' ]);
    });

    it('rejects invalid pointers.', async(): Promise<void> => {
      expect((): unknown => parseJsonPointer('a')).toThrow(BadRequestHttpError);
      expect((): unknown => parseJsonPointer(5)).toThrow(BadRequestHttpError);
    });
  });

  describe('#jsonEquals', (): void => {
    it('compares JSON values.', async(): Promise<void> => {
      expect(jsonEquals({ a: [ 1, { b: 2 }], c: null }, { c: null, a: [ 1, { b: 2 }]})).toBe(true);
      expect(jsonEquals([ 1, 2 ], [ 2, 1 ])).toBe(false);
      expect(jsonEquals([ 1 ], [ 1, 2 ])).toBe(false);
      expect(jsonEquals([ 1 ], { 0: 1 })).toBe(false);
      expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
      expect(jsonEquals({ a: 1, b: undefined }, { a: 1, c: 2 })).toBe(false);
      expect(jsonEquals('1', 1)).toBe(false);
    });
  });

  describe('#applyJsonPatch', (): void => {
    // Examples from Appendix A of RFC 6902
    it('adds values.', async(): Promise<void> => {
      expect(applyJsonPatch({ foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux' }]))
        .toEqual({ foo: 'bar', baz: 'qux' });
      expect(applyJsonPatch({ foo: [ 'bar', 'baz' ]}, [{ op: 'add', path: '/foo/1', value: 'qux' }]))
        .toEqual({ foo: [ 'bar', 'qux', 'baz' ]});
      expect(applyJsonPatch({ foo: [ 'bar' ]}, [{ op: 'add', path: '/foo/-', value: [ 'abc' ]}]))
        .toEqual({ foo: [ 'bar', [ 'abc' ]]});
      expect(applyJsonPatch(undefined, [{ op: 'add', path: '', value: { a: 1 }}])).toEqual({ a: 1 });
    });

    it('treats __proto__ as a regular key.', async(): Promise<void> => {
      const result = applyJsonPatch({}, [{ op: 'add', path: '/__proto__', value: { polluted: true }}]) as any;
      expect(result.polluted).toBeUndefined();
      expect(JSON.stringify(result)).toBe('{"__proto__":{"polluted":true}}');
    });

    it('removes values.', async(): Promise<void> => {
      expect(applyJsonPatch({ baz: 'qux', foo: 'bar' }, [{ op: 'remove', path: '/baz' }])).toEqual({ foo: 'bar' });
      expect(applyJsonPatch({ foo: [ 'bar', 'qux', 'baz' ]}, [{ op: 'remove', path: '/foo/1' }]))
        .toEqual({ foo: [ 'bar', 'baz' ]});
    });

    it('replaces values.', async(): Promise<void> => {
      expect(applyJsonPatch({ baz: 'qux', foo: 'bar' }, [{ op: 'replace', path: '/baz', value: 'boo' }]))
        .toEqual({ baz: 'boo', foo: 'bar' });
      expect(applyJsonPatch([ 1, 2, 3 ], [{ op: 'replace', path: '/1', value: 5 }])).toEqual([ 1, 5, 3 ]);
      expect(applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '', value: [ 1 ]}])).toEqual([ 1 ]);
    });

    it('moves values.', async(): Promise<void> => {
      expect(applyJsonPatch(
        { foo: { bar: 'baz', waldo: 'fred' }, qux: { corge: 'grault' }},
        [{ op: 'move', from: '/foo/waldo', path: '/qux/thud' }],
      )).toEqual({ foo: { bar: 'baz' }, qux: { corge: 'grault', thud: 'fred' }});
      expect(applyJsonPatch(
        { foo: [ 'all', 'grass', 'cows', 'eat' ]},
        [{ op: 'move', from: '/foo/1', path: '/foo/3' }],
      )).toEqual({ foo: [ 'all', 'cows', 'eat', 'grass' ]});
    });

    it('copies values.', async(): Promise<void> => {
      const result = applyJsonPatch({ a: { b: 1 }}, [{ op: 'copy', from: '/a', path: '/c' }]) as any;
      expect(result).toEqual({ a: { b: 1 }, c: { b: 1 }});
      expect(result.a).not.toBe(result.c);
    });

    it('tests values.', async(): Promise<void> => {
      const target = { baz: 'qux', foo: [ 'a', 2, 'c' ]};
      expect(applyJsonPatch(target, [
        { op: 'test', path: '/baz', value: 'qux' },
        { op: 'test', path: '/foo/1', value: 2 },
      ])).toEqual(target);
      expect((): unknown => applyJsonPatch(target, [{ op: 'test', path: '/baz', value: 'bar' }]))
        .toThrow(ConflictHttpError);
    });

    it('does not modify the target and applies all operations or none.', async(): Promise<void> => {
      const target = { a: 1 };
      expect((): unknown => applyJsonPatch(target, [
        { op: 'add', path: '/b', value: 2 },
        { op: 'test', path: '/b', value: 3 },
      ])).toThrow(ConflictHttpError);
      expect(target).toEqual({ a: 1 });
    });

    it('rejects operations on locations that do not exist.', async(): Promise<void> => {
      const conflicts = [
        [{ op: 'add', path: '/a/b', value: 1 }],
        [{ op: 'add', path: '/a/b/c', value: 1 }],
        [{ op: 'remove', path: '/b' }],
        [{ op: 'remove', path: '' }],
        [{ op: 'replace', path: '/b', value: 1 }],
        [{ op: 'add', path: '/list/5', value: 1 }],
        [{ op: 'add', path: '/list/01', value: 1 }],
        [{ op: 'remove', path: '/list/2' }],
        [{ op: 'move', from: '/a', path: '/a/b' }],
        [{ op: 'test', path: '/b', value: 1 }],
      ];
      for (const patch of conflicts) {
        expect((): unknown => applyJsonPatch({ a: 1, list: [ 1, 2 ]}, patch)).toThrow(ConflictHttpError);
      }
      expect((): unknown => applyJsonPatch(undefined, [{ op: 'test', path: '', value: 1 }]))
        .toThrow('The target document does not exist.');
    });

    it('rejects malformed patch documents.', async(): Promise<void> => {
      const malformed = [
        {},
        [ 'add' ],
        [{ op: 'add', path: '/a' }],
        [{ op: 'invalid', path: '/a' }],
        [{ op: 'add', value: 1 }],
      ];
      for (const patch of malformed) {
        expect((): unknown => applyJsonPatch({}, patch)).toThrow(BadRequestHttpError);
      }
    });
  });

  describe('#applyJsonPatchDocument', (): void => {
    it('applies the patch based on its media type.', async(): Promise<void> => {
      expect(applyJsonPatchDocument({ a: 1 }, [{ op: 'remove', path: '/a' }], 'application/json-patch+json'))
        .toEqual({});
      expect(applyJsonPatchDocument({ a: 1 }, { a: null }, 'application/merge-patch+json')).toEqual({});
    });
  });
});
