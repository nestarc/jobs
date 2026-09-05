import { JobsError, JobsErrorCode } from './errors';

export const MAX_JSON_BYTES = 1_048_576;
export const MAX_JSON_DEPTH = 64;

function invalid(path: string, reason: string): never {
  throw new JobsError(JobsErrorCode.SerializationInvalid, `${path}: ${reason}`);
}

/** Snapshot JSON semantics without invoking getters or user-defined toJSON methods. */
export function portableRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(label, 'must be a plain object');
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  function charge(text: string): void {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_JSON_BYTES) invalid(label, `exceeds ${MAX_JSON_BYTES} UTF-8 bytes`);
  }
  function visit(input: unknown, path: string, depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) invalid(path, `exceeds depth ${MAX_JSON_DEPTH}`);
    if (++nodes > MAX_JSON_BYTES) invalid(path, 'too many values');
    if (input === undefined) return undefined;
    if (input === null || typeof input === 'boolean' || typeof input === 'string') {
      charge(JSON.stringify(input));
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) invalid(path, 'number must be finite');
      charge(String(input));
      return Object.is(input, -0) ? 0 : input;
    }
    if (input instanceof Date && Object.getPrototypeOf(input) === Date.prototype) {
      if (!Number.isFinite(Date.prototype.getTime.call(input))) invalid(path, 'invalid Date');
      const date = Date.prototype.toISOString.call(input);
      charge(JSON.stringify(date));
      return date;
    }
    if (typeof input !== 'object' || input === null || (!Array.isArray(input) && !isRecord(input)))
      invalid(path, 'unsupported JSON value or prototype');
    if (ancestors.has(input)) invalid(path, 'cycle');
    ancestors.add(input);
    const array = Array.isArray(input);
    if (array && Object.getPrototypeOf(input) !== Array.prototype)
      invalid(path, 'custom array prototype');
    if (array && input.length > MAX_JSON_BYTES) invalid(path, 'array too large');
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    charge(array ? '[]' : '{}');
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!descriptor.enumerable) continue;
      if (typeof key === 'symbol') invalid(path, 'symbol key');
      if (!('value' in descriptor)) invalid(`${path}.${key}`, 'accessor');
      if (array && !/^(0|[1-9]\d*)$/.test(key)) invalid(path, 'custom array property');
      charge(JSON.stringify(key) + ':,');
      const child = visit(descriptor.value, `${path}.${key}`, depth + 1);
      if (child !== undefined || array)
        Object.defineProperty(result, key, {
          value: child === undefined ? null : child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    if (array) {
      const out = result as unknown[];
      out.length = input.length;
      for (let i = 0; i < out.length; i++)
        if (!(i in out)) {
          out[i] = null;
          charge('null,');
        }
    }
    ancestors.delete(input);
    return result;
  }
  const result = visit(value, label, 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_JSON_BYTES)
    invalid(label, `exceeds ${MAX_JSON_BYTES} UTF-8 bytes`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
