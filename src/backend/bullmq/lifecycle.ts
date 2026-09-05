import type { Job } from 'bullmq';
import type { JobEvent } from '../../types';
import type { BullMQConsumerOptions } from '../bullmq-backend';
import { decodeEnvelope, type PersistedJobMetadata } from './codec';
import {
  notifyLifecycleObserver,
  snapshotLifecycleValue,
  snapshotLifecycleError,
} from '../../lifecycle-observer';
export function notifyCompleted(
  jobType: string,
  job: Job,
  consumer: BullMQConsumerOptions,
  cleanup: (internal: PersistedJobMetadata | undefined) => void,
): void {
  const { context, internal } = decodeEnvelope(job.data as Record<string, unknown>);
  cleanup(internal);
  const tenantId = typeof context.tenantId === 'string' ? context.tenantId : undefined;
  const startedAt = new Date(job.processedOn ?? job.timestamp);
  const finishedAt = new Date(job.finishedOn ?? Date.now());
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  const event: JobEvent = {
    jobId: String(job.id),
    jobType,
    tenantId,
    startedAt,
    finishedAt,
    durationMs,
  };
  notifyLifecycleObserver(() => consumer.onFinish?.(snapshotLifecycleValue(event)));
  notifyLifecycleObserver(() =>
    consumer.events?.onEvent?.({
      type: 'job.succeeded',
      jobId: String(job.id),
      jobType,
      tenantId,
      attempt: job.attemptsMade,
      at: finishedAt,
      durationMs,
      metadata: snapshotLifecycleValue(internal?.metadata),
    }),
  );
}

export function notifyFailed(
  jobType: string,
  job: Job,
  error: Error,
  consumer: BullMQConsumerOptions,
  cleanup: (internal: PersistedJobMetadata | undefined) => void,
): void {
  const { context, internal } = decodeEnvelope(job.data as Record<string, unknown>);
  const tenantId = typeof context.tenantId === 'string' ? context.tenantId : undefined;
  const startedAt = new Date(job.processedOn ?? job.timestamp);
  const finishedAt = new Date(job.finishedOn ?? Date.now());
  const event: JobEvent = { jobId: String(job.id), jobType, tenantId, startedAt, finishedAt };
  // BullMQ sets finishedOn before emitting `failed` only when moveToFailed
  // actually chose the terminal path. The attempts count alone is not enough:
  // a custom backoff can return -1 and Job.discard() can stop retries early,
  // while an indeterminate transition can emit `failed` without finishing.
  const terminal = typeof job.finishedOn === 'number' && Number.isFinite(job.finishedOn);
  const willRetry = !terminal;
  if (!willRetry) cleanup(internal);
  notifyLifecycleObserver(() =>
    consumer.onFail?.(snapshotLifecycleValue(event), snapshotLifecycleError(error)),
  );
  notifyLifecycleObserver(() =>
    consumer.events?.onEvent?.({
      type: willRetry ? 'job.retry_scheduled' : 'job.failed',
      jobId: String(job.id),
      jobType,
      tenantId,
      attempt: job.attemptsMade,
      at: finishedAt,
      error: snapshotLifecycleValue({ message: error.message, name: error.name }),
      metadata: snapshotLifecycleValue(internal?.metadata),
    }),
  );
}
