export function notifyLifecycleObserver(callback: (() => unknown) | undefined): void {
  if (!callback) return;

  try {
    const result = callback();
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Lifecycle observers must not alter queue state or handler outcomes.
  }
}

export function snapshotLifecycleValue<T>(value: T): T {
  return cloneLifecycleValue(value, new WeakMap<object, unknown>());
}

export function snapshotLifecycleError(error: Error): Error {
  const snapshot = snapshotLifecycleValue(error);
  if (snapshot instanceof Error) return snapshot;

  const copy = new Error(error.message);
  copy.name = error.name;
  copy.stack = error.stack;
  return Object.assign(copy, snapshot);
}

function cloneLifecycleValue<T>(value: T, seen: WeakMap<object, unknown>): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;

  const cached = seen.get(value);
  if (cached) return cached as T;

  if (typeof value === 'function') {
    const original = value as unknown as (...args: unknown[]) => unknown;
    const copy = function (this: unknown, ...args: unknown[]) {
      return Reflect.apply(original, this, args);
    };
    seen.set(value, copy);
    copyOwnProperties(value, copy, seen, new Set(['length', 'name', 'arguments', 'caller']));
    return copy as T;
  }

  if (Buffer.isBuffer(value)) {
    const copy = Buffer.from(value);
    seen.set(value, copy);
    return copy as T;
  }
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    seen.set(value, copy);
    return copy as T;
  }
  if (ArrayBuffer.isView(value)) {
    const copiedBuffer = value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
    const copy =
      value instanceof DataView
        ? new DataView(copiedBuffer)
        : new (value.constructor as new (buffer: ArrayBuffer) => ArrayBufferView)(copiedBuffer);
    seen.set(value, copy);
    return copy as T;
  }
  if (value instanceof URL) {
    const copy = new URL(value.href);
    seen.set(value, copy);
    return copy as T;
  }

  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, entry] of value) {
      copy.set(cloneLifecycleValue(key, seen), cloneLifecycleValue(entry, seen));
    }
    return copy as T;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const entry of value) copy.add(cloneLifecycleValue(entry, seen));
    return copy as T;
  }

  const prototype = Object.getPrototypeOf(value);
  const isolatedPrototype =
    prototype === Object.prototype || prototype === null
      ? prototype
      : cloneLifecycleValue(prototype, seen);
  const copy: Record<PropertyKey, unknown> = Array.isArray(value)
    ? []
    : Object.create(isolatedPrototype);
  seen.set(value, copy);
  copyOwnProperties(value, copy, seen);
  return copy as T;
}

function copyOwnProperties(
  source: object,
  target: object,
  seen: WeakMap<object, unknown>,
  skipped: ReadonlySet<PropertyKey> = new Set(),
): void {
  for (const key of Reflect.ownKeys(source)) {
    if (skipped.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = cloneLifecycleValue(descriptor.value, seen);
    Object.defineProperty(target, key, descriptor);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
