export type JobStatus =
  | 'queued'
  | 'delayed'
  | 'active'
  | 'succeeded'
  | 'failed'
  | 'retrying'
  | 'dead_letter'
  | 'cancelled';

export interface JobErrorSummary {
  name?: string;
  message: string;
  code?: string;
  reason?: string;
}

export interface JobRecord<TPayload = unknown, TContext = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  payload?: TPayload;
  context?: TContext;
  attempt: number;
  maxAttempts: number;
  enqueuedAt: Date;
  scheduledFor?: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  nextAttemptAt?: Date;
  error?: JobErrorSummary;
  idempotencyKey?: string;
  dedupeKey?: string;
  metadata: Record<string, unknown>;
}

export interface JobHistoryEntry {
  jobId: string;
  status: JobStatus;
  attempt: number;
  at: Date;
  reason?: string;
  error?: JobErrorSummary;
  metadata?: Record<string, unknown>;
}

export interface BackendCapabilities {
  durable: boolean;
  distributed: boolean;
  delayed: boolean;
  retries: boolean;
  backoff: boolean;
  timeout: boolean;
  statusQuery: boolean;
  history: boolean;
  idempotency: boolean;
  deadLetter: boolean;
  fairness: 'none' | 'local-tenant';
  manualDrain: boolean;
}

export type JobLifecycleEventType =
  | 'job.enqueued'
  | 'job.started'
  | 'job.succeeded'
  | 'job.failed'
  | 'job.retry_scheduled'
  | 'job.dead_lettered'
  | 'job.cancelled'
  | 'job.discarded'
  | 'job.replayed';

export interface JobLifecycleEvent {
  type: JobLifecycleEventType;
  jobId: string;
  jobType: string;
  tenantId?: string;
  attempt: number;
  at: Date;
  durationMs?: number;
  error?: JobErrorSummary;
  metadata?: Record<string, unknown>;
}

export interface JobEventsOptions {
  onEvent?: (event: JobLifecycleEvent) => void;
}

export interface EnqueueResult {
  status: 'created' | 'deduped';
  jobId: string;
  existingJobId?: string;
}

export interface DeadLetterFilter {
  type?: string;
  tenantId?: string;
}

export interface ReplayOptions {
  preserveOriginalId?: boolean;
  resetAttempts?: boolean;
  metadata?: Record<string, unknown>;
}
