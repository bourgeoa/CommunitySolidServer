import { APPLICATION_JSON_PATCH_JSON, APPLICATION_MERGE_PATCH_JSON } from './ContentTypes';
import { BadRequestHttpError } from './errors/BadRequestHttpError';
import { ConflictHttpError } from './errors/ConflictHttpError';
import { applyJsonMergePatch, isJsonObject } from './JsonMergePatch';

/**
 * `Object.hasOwn`, which this package cannot use directly: the ES2021 lib does not declare it.
 */
function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * The media types of the JSON patch documents that can be applied with {@link applyJsonPatchDocument}.
 */
export const JSON_PATCH_TYPES = [ APPLICATION_JSON_PATCH_JSON, APPLICATION_MERGE_PATCH_JSON ];

/**
 * Applies a JSON Patch (RFC 6902) or a JSON Merge Patch (RFC 7386) document, depending on the media type.
 *
 * @param target - The JSON value to patch. `undefined` is interpreted as a non-existing target.
 * @param patch - The parsed patch document.
 * @param contentType - The media type of the patch document.
 */
export function applyJsonPatchDocument(target: unknown, patch: unknown, contentType?: string): unknown {
  if (contentType === APPLICATION_JSON_PATCH_JSON) {
    return applyJsonPatch(target, patch);
  }
  return applyJsonMergePatch(target, patch);
}

/**
 * Parses a JSON Pointer (RFC 6901) into its reference tokens.
 */
export function parseJsonPointer(pointer: unknown): string[] {
  if (typeof pointer !== 'string' || (pointer.length > 0 && !pointer.startsWith('/'))) {
    throw new BadRequestHttpError(`Invalid JSON Pointer ${JSON.stringify(pointer)}.`);
  }
  if (pointer.length === 0) {
    return [];
  }
  return pointer.slice(1).split('/').map((token): string => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * Checks if two JSON values are equal, as defined by the `test` operation of RFC 6902.
 */
export function jsonEquals(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index): boolean => jsonEquals(value, right[index]));
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every((key): boolean => hasOwn(right, key) && jsonEquals(left[key], right[key]));
  }
  return left === right;
}

/**
 * Sets a property without invoking setters, so keys such as `__proto__` are treated as regular keys.
 */
function setProperty(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Parses an array index of a JSON Pointer.
 * `-`, referring to the end of the array, is only accepted if `allowEnd` is true.
 */
function toIndex(token: string, array: unknown[], allowEnd: boolean): number {
  if (allowEnd && token === '-') {
    return array.length;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
    throw new ConflictHttpError(`${token} is not a valid array index.`);
  }
  const index = Number(token);
  if (index > array.length || (!allowEnd && index === array.length)) {
    throw new ConflictHttpError(`Array index ${token} is out of bounds.`);
  }
  return index;
}

/**
 * Returns the value the tokens refer to. Throws a 409 if it does not exist.
 */
function getValue(document: unknown, tokens: string[]): unknown {
  let value = document;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      value = value[toIndex(token, value, false)];
    } else if (isJsonObject(value) && hasOwn(value, token)) {
      value = value[token];
    } else {
      throw new ConflictHttpError(`The path /${tokens.join('/')} does not exist.`);
    }
  }
  if (value === undefined) {
    throw new ConflictHttpError('The target document does not exist.');
  }
  return value;
}

/**
 * Returns the value containing the location the tokens refer to.
 */
function getParent(document: unknown, tokens: string[]): unknown {
  const parent = getValue(document, tokens.slice(0, -1));
  if (!Array.isArray(parent) && !isJsonObject(parent)) {
    throw new ConflictHttpError(`The parent of /${tokens.join('/')} is not an object or array.`);
  }
  return parent;
}

function add(document: unknown, tokens: string[], value: unknown): unknown {
  if (tokens.length === 0) {
    return value;
  }
  const parent = getParent(document, tokens);
  const key = tokens.at(-1)!;
  if (Array.isArray(parent)) {
    parent.splice(toIndex(key, parent, true), 0, value);
  } else {
    setProperty(parent as Record<string, unknown>, key, value);
  }
  return document;
}

function remove(document: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) {
    throw new ConflictHttpError('The root of a document can not be removed.');
  }
  // Throws if the value does not exist
  getValue(document, tokens);
  const parent = getParent(document, tokens);
  const key = tokens.at(-1)!;
  if (Array.isArray(parent)) {
    parent.splice(toIndex(key, parent, false), 1);
  } else {
    delete (parent as Record<string, unknown>)[key];
  }
  return document;
}

function getOperationValue(operation: Record<string, unknown>): unknown {
  if (!hasOwn(operation, 'value')) {
    throw new BadRequestHttpError(`The ${String(operation.op)} operation requires a value.`);
  }
  return structuredClone(operation.value);
}

/**
 * Applies a JSON Patch, as defined in RFC 6902, to the given target.
 * The target is not modified, a new value is returned.
 * Either all operations are applied, or an error is thrown:
 * a 400 if the patch document is malformed,
 * and a 409 if it can not be applied to the target, for example because a `test` operation failed.
 *
 * @param target - The JSON value to patch. `undefined` is interpreted as a non-existing target.
 * @param patch - The JSON Patch document.
 */
export function applyJsonPatch(target: unknown, patch: unknown): unknown {
  if (!Array.isArray(patch)) {
    throw new BadRequestHttpError('A JSON Patch document needs to be an array of operations.');
  }
  let document = structuredClone(target);
  for (const operation of patch) {
    if (!isJsonObject(operation)) {
      throw new BadRequestHttpError('A JSON Patch operation needs to be an object.');
    }
    const tokens = parseJsonPointer(operation.path);
    switch (operation.op) {
      case 'add':
        document = add(document, tokens, getOperationValue(operation));
        break;
      case 'remove':
        document = remove(document, tokens);
        break;
      case 'replace': {
        const value = getOperationValue(operation);
        // Throws if the value does not exist
        getValue(document, tokens);
        document = tokens.length === 0 ? value : add(remove(document, tokens), tokens, value);
        break;
      }
      case 'move': {
        const from = parseJsonPointer(operation.from);
        if (from.length < tokens.length && from.every((token, index): boolean => token === tokens[index])) {
          throw new ConflictHttpError('A value can not be moved into one of its children.');
        }
        const value = getValue(document, from);
        document = add(remove(document, from), tokens, value);
        break;
      }
      case 'copy':
        document = add(document, tokens, structuredClone(getValue(document, parseJsonPointer(operation.from))));
        break;
      case 'test':
        if (!jsonEquals(getValue(document, tokens), operation.value)) {
          throw new ConflictHttpError(`The test of /${tokens.join('/')} failed.`);
        }
        break;
      default:
        throw new BadRequestHttpError(`Unsupported JSON Patch operation ${JSON.stringify(operation.op)}.`);
    }
  }
  return document;
}
