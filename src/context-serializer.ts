import { JobsError, JobsErrorCode } from './errors';
import type { JobContext } from './types';

export const CONTEXT_KEY = '__nestarcCtx';

export function attachContext<T extends Record<string, unknown>>(
  payload: T,
  context: JobContext | undefined,
): T & { [CONTEXT_KEY]: JobContext } {
  if (CONTEXT_KEY in payload) {
    throw new JobsError(
      JobsErrorCode.ReservedPayloadKey,
      `payload must not contain "${CONTEXT_KEY}"`,
    );
  }
  return { ...payload, [CONTEXT_KEY]: context ?? {} };
}

export function detachContext<T extends Record<string, unknown>>(
  envelope: T,
): { payload: Omit<T, typeof CONTEXT_KEY>; context: JobContext } {
  const { [CONTEXT_KEY]: context, ...payload } = envelope as T & {
    [CONTEXT_KEY]?: JobContext;
  };
  return { payload: payload as Omit<T, typeof CONTEXT_KEY>, context: context ?? {} };
}
