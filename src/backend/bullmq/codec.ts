import { detachContext, INTERNAL_JOB_KEY } from '../../context-serializer';
import type { JobContext } from '../../types';
import type { BackoffPolicy } from '../../retry';
const INTERNAL_KEY = INTERNAL_JOB_KEY;
export const INTERNAL_VERSION = 1;
export interface PersistedJobMetadata {
  version: typeof INTERNAL_VERSION;
  metadata: Record<string, unknown>;
  scheduledFor?: number;
  idempotencyKey?: string;
  dedupeKey?: string;
  enqueueToken: string;
  backoff?: BackoffPolicy;
}

export interface DecodedEnvelope {
  payload: Record<string, unknown>;
  context: JobContext;
  internal?: PersistedJobMetadata;
}

export function decodeEnvelope(envelope: Record<string, unknown>): DecodedEnvelope {
  const rawInternal = envelope[INTERNAL_KEY];
  if (!isPersistedMetadata(rawInternal)) {
    const { payload, context } = detachContext(envelope);
    return { payload, context };
  }
  const persistedEnvelope = { ...envelope };
  delete persistedEnvelope[INTERNAL_KEY];
  const { payload, context } = detachContext(persistedEnvelope);
  return { payload, context, internal: rawInternal };
}

function isPersistedMetadata(value: unknown): value is PersistedJobMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === INTERNAL_VERSION &&
    typeof (value as { metadata?: unknown }).metadata === 'object' &&
    (value as { metadata?: unknown }).metadata !== null &&
    typeof (value as { enqueueToken?: unknown }).enqueueToken === 'string'
  );
}
