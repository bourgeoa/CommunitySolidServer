/**
 * Applies a JSON Merge Patch, as defined in RFC 7386, to the given target.
 * The target is not modified, a new value is returned.
 *
 * @param target - The JSON value to patch. `undefined` is interpreted as a non-existing target.
 * @param patch - The JSON Merge Patch document.
 */
export function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isJsonObject(patch)) {
    return patch;
  }
  const result: Record<string, unknown> = isJsonObject(target) ? { ...target } : {};
  for (const [ key, value ] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = applyJsonMergePatch(result[key], value);
    }
  }
  return result;
}

/**
 * Checks if the given value is a JSON object (and not an array or null).
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
