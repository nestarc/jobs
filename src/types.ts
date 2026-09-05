import type { BackoffPolicy } from './retry';

export interface JobContext {
  tenantId?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface JobEnvelope<T = unknown> {
  id: string;
  jobType: string;
  payload: T;
  context: JobContext;
  enqueuedAt: Date;
  attempts: number;
  /** Opaque ownership token returned only by moveToActive. */
  activationId?: string;
  maxAttempts: number;
  scheduledFor?: Date;
  timeoutMs?: number;
  backoff?: BackoffPolicy;
  metadata: Record<string, unknown>;
  idempotencyKey?: string;
  dedupeKey?: string;
}

export interface ShardSnapshot {
  tenantId: string | undefined;
  waiting: number;
  inflight: number;
  weight: number;
  starvationTokens: number;
}

export interface JobEvent {
  jobId: string;
  jobType: string;
  tenantId: string | undefined;
  attempt?: number;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
}

export interface DedupeOptions {
  key: string;
  scope?: 'global' | 'tenant';
  ttlMs?: number;
  mode?: 'while_active' | 'until_completed';
}

export interface EnqueueOptions<
  TContext = JobContext,
  TMetadata extends object = Record<string, unknown>,
> {
  jobId?: string;
  context?: TContext;
  delay?: number;
  delayMs?: number;
  scheduledFor?: Date;
  attempts?: number;
  backoff?: BackoffPolicy;
  timeoutMs?: number;
  idempotencyKey?: string;
  dedupe?: DedupeOptions;
  metadata?: TMetadata;
}
