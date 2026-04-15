import type { JobEnvelope, EnqueueOptions } from '../types';

export interface JobsBackend {
  enqueue(jobType: string, envelope: Record<string, unknown>, opts: EnqueueOptions): Promise<string>;
  peekWaiting(jobType: string): Promise<JobEnvelope[]>;
  moveToActive(jobType: string, jobId: string): Promise<JobEnvelope | null>;
  ack(jobType: string, jobId: string): Promise<void>;
  fail(jobType: string, jobId: string, reason: string): Promise<void>;
  close(): Promise<void>;
}
