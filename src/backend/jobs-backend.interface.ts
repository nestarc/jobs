import type { JobEnvelope, EnqueueOptions } from '../types';
import type {
  BackendCapabilities,
  DeadLetterFilter,
  EnqueueResult,
  JobHistoryEntry,
  JobRecord,
  ReplayOptions,
} from '../lifecycle';

export type EnqueueCommitObserver = (result: EnqueueResult) => void;

export interface JobsBackend {
  capabilities(): BackendCapabilities;
  enqueue(
    jobType: string,
    envelope: Record<string, unknown>,
    opts: EnqueueOptions,
  ): Promise<string>;
  enqueueDetailed?(
    jobType: string,
    envelope: Record<string, unknown>,
    opts: EnqueueOptions,
    onCommit?: EnqueueCommitObserver,
  ): Promise<EnqueueResult>;
  peekWaiting(jobType: string): Promise<JobEnvelope[]>;
  moveToActive(jobType: string, jobId: string): Promise<JobEnvelope | null>;
  ack(jobType: string, jobId: string): Promise<void | JobRecord>;
  fail(jobType: string, jobId: string, reason: string): Promise<void | JobRecord>;
  getJob(jobId: string): Promise<JobRecord | null>;
  getJobHistory(jobId: string): Promise<JobHistoryEntry[]>;
  listDeadLetters?(filter?: DeadLetterFilter): Promise<JobRecord[]>;
  replayDeadLetter?(jobId: string, options?: ReplayOptions): Promise<string>;
  discardDeadLetter?(jobId: string, reason?: string): Promise<void>;
  close(): Promise<void>;
}
