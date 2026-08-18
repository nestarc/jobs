import { JobsError, JobsErrorCode } from './errors';
import type { JobContext } from './types';

export const CONTEXT_KEY = '__nestarcCtx';
export const INTERNAL_JOB_KEY = '__nestarcJob';

export function attachContext<T extends Record<string, unknown>>(
  payload: T,
  context: JobContext | undefined,
): T & { [CONTEXT_KEY]: JobContext } {
  assertPlainRecord(payload, 'job payload');
  const resolvedContext = context ?? {};
  assertPlainRecord(resolvedContext, 'job context');
  const reservedKey = [CONTEXT_KEY, INTERNAL_JOB_KEY].find((key) => key in payload);
  if (reservedKey) {
    throw new JobsError(
      JobsErrorCode.ReservedPayloadKey,
      `payload must not contain "${reservedKey}"`,
    );
  }
  return { ...payload, [CONTEXT_KEY]: resolvedContext };
}

export function detachContext<T extends Record<string, unknown>>(
  envelope: T,
): { payload: Omit<T, typeof CONTEXT_KEY>; context: JobContext } {
  const { [CONTEXT_KEY]: context, ...payload } = envelope as T & {
    [CONTEXT_KEY]?: JobContext;
  };
  return { payload: payload as Omit<T, typeof CONTEXT_KEY>, context: context ?? {} };
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}
