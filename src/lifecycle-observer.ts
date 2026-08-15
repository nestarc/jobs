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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
