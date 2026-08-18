import { Inject } from '@nestjs/common';
import type { BackendCapabilities, DeadLetterFilter, EnqueueResult, JobHistoryEntry, JobRecord, ReplayOptions } from './lifecycle';
import type { EnqueueOptions, JobContext } from './types';

export const JOBS_SERVICE = Symbol.for('@nestarc/jobs:JobsService');

export type JobDefinitions = Record<string, AnyJobDefinition>;

export type AnyJobDefinition =
  | JobBuilder<unknown, unknown, unknown>
  | JobDefinition<unknown, unknown, unknown>;

export interface JobDefinition<TPayload, TContext, TResult> {
  readonly __payload?: TPayload;
  readonly __context?: TContext;
  readonly __result?: TResult;
  readonly defaults: JobDefaults;
}

export interface JobBuilder<TPayload, TContext, TResult> {
  readonly __payload?: TPayload;
  readonly __context?: TContext;
  readonly __result?: TResult;
  context<TNextContext>(): JobBuilder<TPayload, TNextContext, TResult>;
  result<TNextResult>(): JobBuilder<TPayload, TContext, TNextResult>;
  defaults(defaults: JobDefaults): JobDefinition<TPayload, TContext, TResult>;
}

export interface JobDefaults {
  attempts?: number;
  timeoutMs?: number;
  backoff?: EnqueueOptions['backoff'];
}

export type JobType<TJobs extends JobDefinitions> = Extract<keyof TJobs, string>;

export type JobPayload<
  TJobs extends JobDefinitions,
  TType extends JobType<TJobs>,
> = TJobs[TType] extends { readonly __payload?: infer TPayload } ? TPayload : never;

export type JobContextOf<
  TJobs extends JobDefinitions,
  TType extends JobType<TJobs>,
> = TJobs[TType] extends { readonly __context?: infer TContext } ? TContext : JobContext;

export type JobResult<
  TJobs extends JobDefinitions,
  TType extends JobType<TJobs>,
> = TJobs[TType] extends { readonly __result?: infer TResult } ? TResult : unknown;

export interface JobInstance<
  TJobs extends JobDefinitions,
  TType extends JobType<TJobs>,
> {
  id: string;
  type: TType;
  payload: JobPayload<TJobs, TType>;
  context: JobContextOf<TJobs, TType>;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
  metadata: Record<string, unknown>;
}

export interface TypedJobHandler<
  TJobs extends JobDefinitions,
  TType extends JobType<TJobs>,
> {
  handle(
    payload: JobPayload<TJobs, TType>,
    context: JobContextOf<TJobs, TType>,
  ): Promise<JobResult<TJobs, TType>>;
}

export interface TypedJobsService<TJobs extends JobDefinitions> {
  enqueue<TType extends JobType<TJobs>>(
    type: TType,
    payload: JobPayload<TJobs, TType>,
    options?: EnqueueOptions<JobContextOf<TJobs, TType>>,
  ): Promise<string>;

  enqueueDetailed<TType extends JobType<TJobs>>(
    type: TType,
    payload: JobPayload<TJobs, TType>,
    options?: EnqueueOptions<JobContextOf<TJobs, TType>>,
  ): Promise<EnqueueResult>;

  getJob<TType extends JobType<TJobs> = JobType<TJobs>>(
    jobId: string,
  ): Promise<JobRecord<JobPayload<TJobs, TType>, JobContextOf<TJobs, TType>> | null>;

  getJobHistory(jobId: string): Promise<JobHistoryEntry[]>;
  capabilities(): BackendCapabilities;
  listDeadLetters(filter?: DeadLetterFilter): Promise<JobRecord[]>;
  replayDeadLetter(jobId: string, options?: ReplayOptions): Promise<string>;
  discardDeadLetter(jobId: string, reason?: string): Promise<void>;
}

export function job<TPayload extends object>(): JobBuilder<TPayload, JobContext, unknown> {
  return makeJobBuilder<TPayload, JobContext, unknown>();
}

export function defineJobs<TJobs extends JobDefinitions>(definitions: TJobs): TJobs {
  return definitions;
}

export function InjectJobs(): ReturnType<typeof Inject> {
  return Inject(JOBS_SERVICE);
}

function makeJobBuilder<TPayload, TContext, TResult>(): JobBuilder<TPayload, TContext, TResult> {
  return {
    context<TNextContext>() {
      return makeJobBuilder<TPayload, TNextContext, TResult>();
    },
    result<TNextResult>() {
      return makeJobBuilder<TPayload, TContext, TNextResult>();
    },
    defaults(defaults: JobDefaults) {
      return { defaults } as JobDefinition<TPayload, TContext, TResult>;
    },
  } as JobBuilder<TPayload, TContext, TResult>;
}
