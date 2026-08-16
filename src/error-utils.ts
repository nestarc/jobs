export function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;

  try {
    return new Error(String(value));
  } catch {
    return new Error('Job handler rejected with a non-error value');
  }
}
