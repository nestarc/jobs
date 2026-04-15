export interface JobContext {
  tenantId?: string;
  [key: string]: unknown;
}

export interface JobEnvelope<T = unknown> {
  id: string;
  jobType: string;
  payload: T;
  context: JobContext;
  enqueuedAt: Date;
  attempts: number;
}

export interface ShardSnapshot {
  tenantId: string;
  waiting: number;
  inflight: number;
  weight: number;
  starvationTokens: number;
}

export interface JobEvent {
  jobId: string;
  jobType: string;
  tenantId: string | undefined;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
}

export interface EnqueueOptions {
  jobId?: string;
  context?: JobContext;
  delay?: number;
  attempts?: number;
}
