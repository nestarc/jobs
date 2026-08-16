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
  if (typeof value === 'function') return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;

  const cached = seen.get(value);
  if (cached) return cached as T;

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

  const copy: Record<PropertyKey, unknown> = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = cloneLifecycleValue(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy as T;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
