import { applyJsonMergePatch, isJsonObject } from '../../../src/util/JsonMergePatch';

describe('JsonMergePatch', (): void => {
  describe('#applyJsonMergePatch', (): void => {
    // Test cases from RFC 7386, Appendix A
    it.each([
      [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
      [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
      [{ a: 'b' }, { a: null }, {}],
      [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
      [{ a: [ 'b' ]}, { a: 'c' }, { a: 'c' }],
      [{ a: 'c' }, { a: [ 'b' ]}, { a: [ 'b' ]}],
      [{ a: { b: 'c' }}, { a: { b: 'd', c: null }}, { a: { b: 'd' }}],
      [{ a: [{ b: 'c' }]}, { a: [ 1 ]}, { a: [ 1 ]}],
      [[ 'a', 'b' ], [ 'c', 'd' ], [ 'c', 'd' ]],
      [{ a: 'b' }, [ 'c' ], [ 'c' ]],
      [{ a: 'foo' }, null, null ],
      [{ a: 'foo' }, 'bar', 'bar' ],
      [{ e: null }, { a: 1 }, { e: null, a: 1 }],
      [[ 1, 2 ], { a: 'b', c: null }, { a: 'b' }],
      [{}, { a: { bb: { ccc: null }}}, { a: { bb: {}}}],
    ])('patches %j with %j into %j.', (target, patch, expected): void => {
      expect(applyJsonMergePatch(target, patch)).toEqual(expected);
    });

    it('interprets an undefined target as a non-existing target.', async(): Promise<void> => {
      expect(applyJsonMergePatch(undefined, { a: { b: null, c: 1 }})).toEqual({ a: { c: 1 }});
    });

    it('does not modify the target.', async(): Promise<void> => {
      const target = { a: 'b', c: { d: 'e' }};
      applyJsonMergePatch(target, { a: null, c: { d: 'f' }});
      expect(target).toEqual({ a: 'b', c: { d: 'e' }});
    });
  });

  describe('#isJsonObject', (): void => {
    it('only accepts non-array objects.', async(): Promise<void> => {
      expect(isJsonObject({})).toBe(true);
      expect(isJsonObject([])).toBe(false);
      expect(isJsonObject(null)).toBe(false);
      expect(isJsonObject('a')).toBe(false);
      expect(isJsonObject(undefined)).toBe(false);
    });
  });
});
